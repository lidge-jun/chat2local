import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LIMITS } from './config.js';

export interface ProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal;
  input?: string; keepStdin?: boolean;
  onStart?: (child: ChildProcessWithoutNullStreams) => void;
  onStdout?: (chunk: Buffer) => void;
}
export interface ProcessResult {
  stdout: string; stderr: string; exit_code: number | null; signal: NodeJS.Signals | null;
  timed_out: boolean; cancelled: boolean; output_limited: boolean;
}

/** Never inherit tunnel/API keys into execution backends. */
export function backendEnv(native = false): NodeJS.ProcessEnv {
  const keys = native ? ['PATH', 'HOME', 'LANG', 'TMPDIR'] : ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'];
  return Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}

export async function runProcess(binary: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new Error('Cancelled before execution');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env || backendEnv(),
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), outputBytes = 0;
    let timed_out = false, cancelled = false, output_limited = false;
    let failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* process already exited */ }
    };
    const stop = () => {
      kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => kill('SIGKILL'), 750);
    };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timed_out = true; stop(); }, options.timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    // Close the race between the early check and listener registration.
    if (options.signal?.aborted) abort();
    const cleanup = () => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > LIMITS.processBytes) { output_limited = true; stop(); return; }
      if (options.onStdout) {
        try { options.onStdout(chunk); } catch (e) { failure = e instanceof Error ? e : new Error(String(e)); stop(); }
      } else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > LIMITS.processBytes) { output_limited = true; stop(); return; }
      stderr = Buffer.concat([stderr, chunk]).subarray(0, 64 * 1024);
    });
    child.stdin.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') { failure = e; stop(); } });
    child.on('error', e => { failure = e; });
    child.on('close', (exit_code, signal) => {
      if (cancelled || timed_out || output_limited || failure) kill('SIGKILL');
      cleanup();
      if (failure) { reject(failure); return; }
      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exit_code, signal,
        timed_out, cancelled, output_limited });
    });
    try {
      options.onStart?.(child);
      if (options.input) child.stdin.write(options.input);
      if (!options.keepStdin) child.stdin.end();
    } catch (e) { failure = e instanceof Error ? e : new Error(String(e)); stop(); }
  });
}
