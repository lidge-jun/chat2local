import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LIMITS, type Config, type SandboxBackend } from './config.js';
import { Workspace } from './policy.js';
import { backendEnv, runProcess } from './process.js';
import { WORKER_SOURCE } from './worker-source.js';
import { buildSeatbeltProfile, seatbeltArgs, SEATBELT_EXECUTABLE } from './seatbelt-policy.js';
import type { JobContext } from './jobs.js';

export function dockerArgs(name: string, image: string): string[] {
  return ['run', '--rm', '-i', '--pull=never', '--name', name, '--init', '--log-driver=none',
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1',
    '--user=65534:65534', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp'];
}

/**
 * Resource caps for the Seatbelt backend.
 *
 * Seatbelt governs *authority* (which files, which syscalls), not resource
 * consumption, so Docker's --memory and --pids-limit have no direct equivalent.
 * What remains is POSIX rlimits, and they are a genuinely weaker control:
 *
 *  - RLIMIT_NPROC is deliberately NOT set. On macOS it counts processes for the
 *    whole UID, not for this process tree, so a small value fails instantly on a
 *    normal desktop session and a safe value bounds nothing. It is not a
 *    --pids-limit equivalent and pretending otherwise would be worse than
 *    admitting the gap.
 *  - RLIMIT_AS (`ulimit -v`) is unsupported on macOS/arm64.
 *
 * Descriptor, file-size and core-dump limits are real and are applied. Timeouts
 * and output caps in runProcess() remain the effective bound on a runaway job.
 */
export const SEATBELT_RLIMITS = Object.freeze({
  /** Max open descriptors. */
  files: 256,
  /** Max file size the worker may create, in 512-byte blocks (~64 MiB). */
  fileSizeBlocks: 131072,
});

function rlimitPrelude(): string {
  // Each limit is best-effort: a shell that rejects one must not fail the job.
  return [
    `ulimit -n ${SEATBELT_RLIMITS.files} 2>/dev/null || true`,
    `ulimit -f ${SEATBELT_RLIMITS.fileSizeBlocks} 2>/dev/null || true`,
    'ulimit -c 0 2>/dev/null || true',
  ].join('; ');
}

/** Shell-quote for the single-quoted POSIX form used in the launch prelude. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

export interface BackendLaunch {
  binary: string;
  args: string[];
  /** Container name for Docker; undefined for Seatbelt, which has no daemon state. */
  containerName?: string;
}

export class Sandbox {
  constructor(private config: Config) {}

  /** The configured backend, or a thrown explanation of what the operator must provision. */
  private backend(): SandboxBackend {
    const backend = this.config.sandboxBackend;
    if (backend === 'docker') {
      const image = this.config.workerImage;
      if (!image || image.startsWith('-') || !/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/.test(image))
        throw new Error('Docker backend selected but CHAT2LOCAL_WORKER_IMAGE is unset or invalid. Set a provisioned image, or use CHAT2LOCAL_SANDBOX=seatbelt on macOS.');
      return 'docker';
    }
    if (backend === 'seatbelt') {
      if (process.platform !== 'darwin') throw new Error('Seatbelt backend requires macOS. Use the Docker backend on this platform.');
      if (!this.config.nodeBinary) throw new Error('Seatbelt backend requires CHAT2LOCAL_NODE_BINARY or a resolvable node/bun on PATH.');
      return 'seatbelt';
    }
    throw new Error('Code execution disabled. Provision Docker with CHAT2LOCAL_WORKER_IMAGE, or enable the macOS Seatbelt backend. No host fallback.');
  }

  private image() {
    const image = this.config.workerImage;
    if (!image || image.startsWith('-') || !/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/.test(image))
      throw new Error('Code execution disabled. Operator must provision Docker and CHAT2LOCAL_WORKER_IMAGE. No host fallback.');
    return image;
  }

  private async cleanup(name: string) {
    const result = await runProcess(this.config.dockerBinary, ['rm', '-f', name], { timeout: 5000, env: backendEnv() });
    if (result.exit_code !== 0 && !/No such container/i.test(result.stderr)) throw new Error('Container cleanup could not be confirmed; inspect Docker before retrying');
  }

  /**
   * Launch parameters for the code-mode worker.
   *
   * Docker: a disposable container with no network, no mounts and a read-only rootfs.
   * Seatbelt: the host `node`/`bun` under `sandbox-exec`, with a scratch directory as
   * the only writable root. Code-mode never touches project files directly; every file
   * operation is a broker RPC validated in this process, so the worker itself needs no
   * read access to the workspace at all.
   */
  codeLaunch(scratch: string): BackendLaunch {
    if (this.backend() === 'docker') {
      const image = this.image(), containerName = `chat2local-${randomUUID()}`;
      return { binary: this.config.dockerBinary, containerName,
        args: [...dockerArgs(containerName, image), '--entrypoint', 'node', image,
          '--max-old-space-size=128', '--input-type=module', '--eval', WORKER_SOURCE] };
    }
    const { policy, params } = buildSeatbeltProfile({
      // Read access covers only the interpreter itself and system paths from the
      // platform defaults; the project is deliberately absent.
      readableRoots: [this.config.nodeBinary!, scratch],
      writableRoots: [scratch],
    });
    // `cd` into the scratch root before exec: Node calls process.cwd() while
    // bootstrapping --input-type=module, and inheriting a directory the sandbox
    // cannot stat aborts the worker with EPERM before any user code runs.
    const prelude = `${rlimitPrelude()}; cd ${shellQuote(scratch)} && export HOME=${shellQuote(scratch)} TMPDIR=${shellQuote(scratch)} PWD=${shellQuote(scratch)}; `
      + `exec ${shellQuote(this.config.nodeBinary!)} --max-old-space-size=128 --input-type=module --eval "$1"`;
    return { binary: SEATBELT_EXECUTABLE,
      args: seatbeltArgs(policy, params, ['/bin/sh', '-c', prelude, 'chat2local', WORKER_SOURCE]) };
  }

  /**
   * Launch parameters for a shell command over a filtered snapshot.
   *
   * Both backends run the command against a COPY. The live project is never a
   * writable mount, and results are never copied back automatically.
   */
  commandLaunch(snapshot: string, work: string, command: string): BackendLaunch {
    if (this.backend() === 'docker') {
      const image = this.image(), containerName = `chat2local-${randomUUID()}`;
      return { binary: this.config.dockerBinary, containerName,
        args: [...dockerArgs(containerName, image),
          '--mount', `type=bind,src=${snapshot},dst=/source,readonly`,
          '--tmpfs', '/work:rw,nosuid,size=128m,mode=1777', '--workdir', '/work',
          '--entrypoint', '/bin/sh', image, '-c', 'cp -R /source/. /work/ && exec /bin/sh -c "$1"', 'chat2local', command] };
    }
    const { policy, params } = buildSeatbeltProfile({
      readableRoots: [snapshot, work],
      writableRoots: [work],
    });
    const prelude = `${rlimitPrelude()}; cp -R ${shellQuote(snapshot)}/. ${shellQuote(work)}/ && cd ${shellQuote(work)} `
      + `&& export HOME=${shellQuote(work)} TMPDIR=${shellQuote(work)} && exec /bin/sh -c "$1"`;
    return { binary: SEATBELT_EXECUTABLE,
      args: seatbeltArgs(policy, params, ['/bin/sh', '-c', prelude, 'chat2local', command]) };
  }

  async code(code: string, timeout: number, ctx: JobContext,
    call: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const scratch = join(this.config.stateDir, 'workers', randomUUID());
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const launch = this.codeLaunch(scratch);
    let child: ChildProcessWithoutNullStreams;
    const decoder = new StringDecoder('utf8');
    let buffer = '', calls = 0, active = 0, responseBytes = 0;
    let finished = false, result: unknown, error: string | undefined;
    const seen = new Set<number>(), inflight = new Set<Promise<void>>();
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    ctx.signal.addEventListener('abort', relayAbort, { once: true });
    if (ctx.signal.aborted) controller.abort();
    const frame = (line: string) => {
      const m = JSON.parse(line);
      if (!m || typeof m !== 'object' || finished) throw new Error('Invalid worker frame');
      if (m.type === 'log') { ctx.log(String(m.text)); return; }
      if (m.type === 'result' || m.type === 'error') {
        if (active) throw new Error('Worker completed with outstanding broker calls; inspect side effects');
        finished = true; result = m.result; error = m.type === 'error' ? String(m.error) : undefined; return;
      }
      if (m.type !== 'call' || !Number.isSafeInteger(m.id) || seen.has(m.id) || typeof m.name !== 'string') throw new Error('Invalid broker request');
      if (++calls > LIMITS.toolCalls || ++active > LIMITS.concurrency) throw new Error('Broker call/concurrency limit exceeded');
      seen.add(m.id);
      const promise = (async () => {
        let reply: { result?: unknown; error?: string };
        try {
          if (controller.signal.aborted) throw new Error('Cancelled');
          const value = await call(m.name, m.args, controller.signal);
          ctx.log(`tool: ${m.name}`);
          reply = { result: value };
        } catch (e) { reply = { error: e instanceof Error ? e.message : String(e) }; }
        const output = JSON.stringify({ type: 'reply', id: m.id, ...reply }) + '\n';
        responseBytes += Buffer.byteLength(output);
        active--;
        if (responseBytes > 4 * LIMITS.processBytes) { error = 'Broker response budget exceeded'; controller.abort(); return; }
        if (!child.stdin.destroyed && !controller.signal.aborted) child.stdin.write(output);
      })();
      inflight.add(promise); promise.finally(() => inflight.delete(promise)).catch(() => controller.abort());
    };
    try {
      const processResult = await runProcess(launch.binary, launch.args, {
        timeout, signal: controller.signal, env: backendEnv(), keepStdin: true,
        input: JSON.stringify({ type: 'run', code }) + '\n', onStart: p => { child = p; },
        onStdout: chunk => {
          buffer += decoder.write(chunk);
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) frame(line); }
          if (Buffer.byteLength(buffer) > LIMITS.resultBytes) throw new Error('Worker frame exceeds limit');
        },
      });
      if (processResult.timed_out || processResult.cancelled || processResult.output_limited || processResult.exit_code !== 0) controller.abort();
      await Promise.allSettled(inflight);
      if (processResult.timed_out) throw new Error('Worker timed out');
      if (processResult.output_limited) throw new Error('Worker output limit exceeded');
      if (processResult.cancelled) throw new Error(error || 'Worker cancelled');
      if (error) throw new Error(error);
      if (!finished || processResult.exit_code !== 0) throw new Error(`Worker failed (${processResult.exit_code}): ${processResult.stderr.slice(0, 2000)}`);
      return result;
    } finally {
      controller.abort(); ctx.signal.removeEventListener('abort', relayAbort);
      await Promise.allSettled(inflight);
      if (launch.containerName) await this.cleanup(launch.containerName);
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Commands see a filtered snapshot, NEVER a writable mount of the live project. */
  async command(workspace: Workspace, command: string, timeout: number, ctx: JobContext) {
    const backend = this.backend();
    const base = join(this.config.stateDir, 'snapshots', randomUUID());
    const snapshot = join(base, 'source'), work = join(base, 'work');
    if (base.includes(',')) throw new Error('Sandbox snapshot path cannot contain a comma');
    await mkdir(snapshot, { recursive: true, mode: 0o755 });
    if (backend === 'seatbelt') await mkdir(work, { recursive: true, mode: 0o700 });
    let launch: BackendLaunch | undefined;
    try {
      const manifest = await workspace.snapshot(snapshot);
      ctx.log(`Snapshot: ${manifest.files} files, ${manifest.bytes} bytes; ${manifest.omitted} excluded entries`);
      launch = this.commandLaunch(snapshot, work, command);
      const result = await runProcess(launch.binary, launch.args, { timeout, signal: ctx.signal, env: backendEnv() });
      if (result.timed_out || result.cancelled || result.output_limited) throw new Error(`Command stopped: ${JSON.stringify(result)}`);
      if (result.exit_code !== 0) throw new Error(`Command failed: ${JSON.stringify(result)}`);
      return { ...result, snapshot: manifest, changes_applied_to_host: false };
    } finally {
      try { if (launch?.containerName) await this.cleanup(launch.containerName); }
      finally { await rm(base, { recursive: true, force: true }); }
    }
  }
}
