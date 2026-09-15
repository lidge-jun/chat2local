import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { accessSync, constants } from 'node:fs';

/**
 * Execution backend for code mode and shell commands.
 *
 * Both options are OS-level isolation, never in-process: `node:vm`,
 * `AsyncFunction` and `worker_threads` are not security boundaries and are never
 * used as a fallback.
 *   https://nodejs.org/api/vm.html
 *
 * Backend selection follows the Codex `get_platform_sandbox()` model: prefer the
 * platform-native sandbox and treat containers as one option rather than the only
 * one. On macOS that is Seatbelt via `/usr/bin/sandbox-exec`, which requires no
 * installation.
 */
export type SandboxBackend = 'seatbelt' | 'docker' | 'none';

export interface Config {
  workspace: string;
  stateDir: string;
  allowWrite: boolean;
  allowAside: boolean;
  sandboxBackend: SandboxBackend;
  dockerBinary: string;
  workerImage?: string;
  /** Absolute path to the interpreter the Seatbelt worker executes. */
  nodeBinary?: string;
  asideBinary: string;
  asidePermission: 'guard' | 'full-access';
}

/** Personal defaults are intentional; explicit operator restrictions always win. */
function enabled(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  if (value === undefined || value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${key} must be 0 or 1; refusing an ambiguous permission value`);
}

function nativePermission(value: string | undefined): 'guard' | 'full-access' {
  if (value === undefined || value === 'full-access') return 'full-access';
  if (value === 'guard') return 'guard';
  throw new Error('CHAT2LOCAL_ASIDE_PERMISSION must be guard or full-access');
}

/** Resolve an executable on PATH without spawning a shell. */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(name)) {
    try { accessSync(name, constants.X_OK); return name; } catch { return undefined; }
  }
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep searching */ }
  }
  return undefined;
}

/**
 * Pick the execution backend.
 *
 * An explicit `CHAT2LOCAL_SANDBOX` always wins so an operator can force one.
 * Otherwise macOS uses Seatbelt and every other platform requires a provisioned
 * Docker image. Auto-selection never silently downgrades to an in-process
 * evaluator: when nothing is available the backend is `none` and code execution
 * fails closed.
 */
export function selectBackend(env: NodeJS.ProcessEnv, platform: string, hasNode: boolean): SandboxBackend {
  const requested = env.CHAT2LOCAL_SANDBOX;
  if (requested !== undefined) {
    if (requested !== 'seatbelt' && requested !== 'docker' && requested !== 'none')
      throw new Error('CHAT2LOCAL_SANDBOX must be seatbelt, docker or none');
    if (requested === 'seatbelt' && platform !== 'darwin') throw new Error('CHAT2LOCAL_SANDBOX=seatbelt requires macOS');
    return requested;
  }
  if (platform === 'darwin' && hasNode) return 'seatbelt';
  if (env.CHAT2LOCAL_WORKER_IMAGE) return 'docker';
  return 'none';
}

/** Only the operator's environment controls privileges, never tool arguments. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Config {
  const workspace = resolve(env.CHAT2LOCAL_WORKSPACE || env.CODEX_MCP_WORKSPACE || process.cwd());
  const nodeBinary = env.CHAT2LOCAL_NODE_BINARY
    ? resolveOnPath(env.CHAT2LOCAL_NODE_BINARY, env)
    : resolveOnPath('node', env) || resolveOnPath('bun', env);
  return {
    workspace,
    stateDir: resolve(env.CHAT2LOCAL_STATE_DIR || join(homedir(), '.chat2local', 'state')),
    allowWrite: enabled(env, 'CHAT2LOCAL_ALLOW_WRITE'),
    allowAside: enabled(env, 'CHAT2LOCAL_ALLOW_ASIDE'),
    sandboxBackend: selectBackend(env, platform, Boolean(nodeBinary)),
    dockerBinary: env.CHAT2LOCAL_DOCKER_BINARY || 'docker',
    workerImage: env.CHAT2LOCAL_WORKER_IMAGE || undefined,
    nodeBinary,
    asideBinary: env.CHAT2LOCAL_ASIDE_BINARY || 'aside',
    asidePermission: nativePermission(env.CHAT2LOCAL_ASIDE_PERMISSION),
  };
}

export const LIMITS = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  readBytes: 256 * 1024,
  resultBytes: 512 * 1024,
  processBytes: 1024 * 1024,
  toolCalls: 128,
  concurrency: 8,
  activeJobs: 4,
  jobs: 512,
  sessions: 128,
  walkEntries: 5000,
  snapshotBytes: 32 * 1024 * 1024,
});
