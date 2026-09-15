import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { accessSync, constants, realpathSync } from 'node:fs';

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
  /** Optional CodexClaw payload entry invoked by the privileged native adapter. */
  codexclawEntry?: string;
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

/**
 * Resolve the CodexClaw payload, refusing any entry the model can rewrite.
 *
 * codexclaw_native executes this file on the host, outside the sandbox, with the
 * operator's own privileges. The workspace is simultaneously writable through
 * `write_file`. So an entry located inside the workspace is not a privileged
 * adapter at all: the model can rewrite the payload and then ask for it to be
 * executed, turning a scoped file write into arbitrary host code execution.
 * That path was demonstrated end to end, not merely suspected.
 *
 * `aside_native` avoids this by construction because its binary is pinned outside
 * the source tree. The same rule is enforced here rather than left to convention:
 * the entry must live outside the workspace, and the operator must name it. There
 * is deliberately no in-workspace auto-discovery, because a discovered path is
 * exactly the path an attacker can create.
 */
export function resolveCodexclawEntry(env: NodeJS.ProcessEnv, workspace: string): string | undefined {
  const configured = env.CHAT2LOCAL_CODEXCLAW_ENTRY;
  if (!configured) return undefined;
  const entry = resolve(configured);
  const realEntry = realpathOrSelf(entry);
  const realWorkspace = realpathOrSelf(workspace);
  // BOTH the named path and its resolved target must be outside the workspace.
  // Checking only the target would accept a symlink sitting at a model-writable
  // path: resolution happens once at startup, but the operator would be relying on
  // a link the model can replace, and the next restart resolves the replacement.
  for (const candidate of [entry, realEntry]) {
    if (candidate === realWorkspace || candidate === workspace || within(realWorkspace, candidate) || within(workspace, candidate))
      throw new Error('CHAT2LOCAL_CODEXCLAW_ENTRY must live outside the writable workspace; '
        + 'an entry the model can rewrite with write_file is arbitrary host execution, not an adapter');
  }
  try { accessSync(realEntry, constants.R_OK); } catch {
    throw new Error('CHAT2LOCAL_CODEXCLAW_ENTRY is not readable: ' + entry);
  }
  return realEntry;
}

function realpathOrSelf(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}

/** True when `path` is inside `root`, using a separator-aware prefix test. */
function within(root: string, path: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(base);
}

/** Only the operator's environment controls privileges, never tool arguments. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Config {
  const workspace = resolve(env.CHAT2LOCAL_WORKSPACE || env.CODEX_MCP_WORKSPACE || process.cwd());
  const nodeBinary = env.CHAT2LOCAL_NODE_BINARY
    ? resolveOnPath(env.CHAT2LOCAL_NODE_BINARY, env)
    : resolveOnPath('node', env) || resolveOnPath('bun', env);
  const codexclawEntry = resolveCodexclawEntry(env, workspace);
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
    codexclawEntry,
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
