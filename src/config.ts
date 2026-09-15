import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  workspace: string;
  stateDir: string;
  allowWrite: boolean;
  allowAside: boolean;
  dockerBinary: string;
  workerImage?: string;
  asideBinary: string;
}

/** Only the operator's environment controls privileges, never tool arguments. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workspace = resolve(env.CHAT2LOCAL_WORKSPACE || env.CODEX_MCP_WORKSPACE || process.cwd());
  return {
    workspace,
    stateDir: resolve(env.CHAT2LOCAL_STATE_DIR || join(homedir(), '.chat2local', 'state')),
    allowWrite: env.CHAT2LOCAL_ALLOW_WRITE === '1',
    allowAside: env.CHAT2LOCAL_ALLOW_ASIDE === '1',
    dockerBinary: env.CHAT2LOCAL_DOCKER_BINARY || 'docker',
    workerImage: env.CHAT2LOCAL_WORKER_IMAGE || undefined,
    asideBinary: env.CHAT2LOCAL_ASIDE_BINARY || 'aside',
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
