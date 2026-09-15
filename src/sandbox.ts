import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LIMITS, type Config } from './config.js';
import { Workspace } from './policy.js';
import { backendEnv, runProcess } from './process.js';
import { WORKER_SOURCE } from './worker-source.js';
import type { JobContext } from './jobs.js';

export function dockerArgs(name: string, image: string): string[] {
  return ['run', '--rm', '-i', '--pull=never', '--name', name, '--init', '--log-driver=none',
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1',
    '--user=65534:65534', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp'];
}

export class Sandbox {
  constructor(private config: Config) {}
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

  async code(code: string, timeout: number, ctx: JobContext,
    call: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const image = this.image(), name = `chat2local-${randomUUID()}`;
    const args = [...dockerArgs(name, image), '--entrypoint', 'node', image,
      '--max-old-space-size=128', '--input-type=module', '--eval', WORKER_SOURCE];
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
      const processResult = await runProcess(this.config.dockerBinary, args, {
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
      await Promise.allSettled(inflight); await this.cleanup(name);
    }
  }

  /** Commands see a filtered snapshot, NEVER a writable mount of the live project. */
  async command(workspace: Workspace, command: string, timeout: number, ctx: JobContext) {
    const image = this.image(), name = `chat2local-${randomUUID()}`;
    const snapshot = join(this.config.stateDir, 'snapshots', randomUUID());
    if (snapshot.includes(',')) throw new Error('Docker snapshot path cannot contain a comma');
    await mkdir(snapshot, { mode: 0o755 });
    let attempted = false;
    try {
      const manifest = await workspace.snapshot(snapshot);
      ctx.log(`Snapshot: ${manifest.files} files, ${manifest.bytes} bytes; ${manifest.omitted} excluded entries`);
      attempted = true;
      const result = await runProcess(this.config.dockerBinary, [...dockerArgs(name, image),
        '--mount', `type=bind,src=${snapshot},dst=/source,readonly`,
        '--tmpfs', '/work:rw,nosuid,size=128m,mode=1777', '--workdir', '/work',
        '--entrypoint', '/bin/sh', image, '-c', 'cp -R /source/. /work/ && exec /bin/sh -c "$1"', 'chat2local', command],
        { timeout, signal: ctx.signal, env: backendEnv() });
      if (result.timed_out || result.cancelled || result.output_limited) throw new Error(`Command stopped: ${JSON.stringify(result)}`);
      if (result.exit_code !== 0) throw new Error(`Command failed: ${JSON.stringify(result)}`);
      return { ...result, snapshot: manifest, changes_applied_to_host: false };
    } finally {
      try { if (attempted) await this.cleanup(name); }
      finally { await rm(snapshot, { recursive: true, force: true }); }
    }
  }
}
