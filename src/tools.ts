import { z } from 'zod';
import { LIMITS } from './config.js';

const session = { session_id: z.string().uuid().describe('Session ID returned by session_open') };
const path = z.string().min(1).max(4096).describe('Path within the session project; symlinks and sensitive paths are rejected');
const timeout = z.number().int().min(1000).max(600_000).default(60_000);
const request = z.string().min(1).max(128).describe('Stable idempotency key; reuse only for an identical operation');
const code = z.string().min(1).max(100_000).describe('Async JavaScript body. await tools.call(name,args), tools.list(), tools.map(items,fn,concurrency). Return a compact result.');
const writeShape = {
  path, content: z.string().max(LIMITS.fileBytes),
  expected_sha256: z.string().regex(/^(absent|[a-f0-9]{64})$/).describe('Current full-file SHA-256 from read_file, or absent to create. Parent directory must already exist.'),
};

/** Single schema source for both MCP discovery and broker validation/defaults. */
export const schemas = {
  session_open: z.object({ project: z.string().min(1).max(4096).default('.'), title: z.string().max(200).default('Chat task'), session_id: z.string().uuid().optional() }).strict(),
  session_list: z.object({}).strict(),
  session_checkpoint: z.object({ ...session, summary: z.string().max(8000) }).strict(),
  capabilities: z.object({ ...session }).strict(),
  read_file: z.object({ ...session, path, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(LIMITS.readBytes).default(LIMITS.readBytes) }).strict(),
  write_file: z.object({ ...session, ...writeShape }).strict(),
  list_dir: z.object({ ...session, path: path.default('.'), recursive: z.boolean().default(false) }).strict(),
  glob: z.object({ ...session, pattern: z.string().min(1).max(500), path: path.default('.') }).strict(),
  grep: z.object({ ...session, pattern: z.string().min(1).max(1000).describe('Literal text, not a regular expression'), path: path.default('.'), caseSensitive: z.boolean().default(false), maxResults: z.number().int().min(1).max(1000).default(100) }).strict(),
  artifact_read: z.object({ ...session, path }).strict(),
  code_mode_read: z.object({ ...session, code, request_id: request, timeout }).strict(),
  code_mode: z.object({ ...session, code, request_id: request, timeout }).strict(),
  exec_command: z.object({ ...session, command: z.string().min(1).max(20_000), request_id: request, timeout }).strict(),
  aside_native: z.object({ ...session, args: z.array(z.string().max(100_000)).min(1).max(32).describe('Exact Aside CLI argv, no shell. Privileged personal default; operator may disable it.'), request_id: request, timeout }).strict(),
  codexclaw_native: z.object({ ...session, args: z.array(z.string().max(20_000)).min(1).max(32).describe('Exact CodexClaw cxc argv, without shell interpolation. Runs against the session project.'), request_id: request, timeout }).strict(),
  aside_repl: z.object({ ...session, code: z.string().min(1).max(100_000), account: z.string().min(1).max(100).optional(), host: z.string().min(1).max(100).optional(), request_id: request, timeout }).strict(),
  spawn_subagent: z.object({ ...session, prompt: z.string().min(1).max(100_000), model: z.string().min(1).max(200).optional(), request_id: request, timeout }).strict(),
  job_get: z.object({ ...session, job_id: z.string().uuid(), cursor: z.number().int().min(0).default(0), wait_ms: z.number().int().min(0).max(10_000).default(0) }).strict(),
  job_cancel: z.object({ ...session, job_id: z.string().uuid() }).strict(),
};
export type ToolName = keyof typeof schemas;
export const descriptions: Record<ToolName, string> = {
  session_open: 'Start a task within the operator-selected workspace or resume a saved session_id. Read returned capabilities and instructions first. No subprocess is run.',
  session_list: 'List this single-operator runtime’s saved task sessions. Checkpoints are task notes, not a restored model context.',
  session_checkpoint: 'Save a concise task checkpoint for later resumption. Do not store secrets or internal reasoning.',
  capabilities: 'Read operator policy, available backends and batch tool names. Configured does not mean the backend has passed a live health check.',
  read_file: 'Read bounded UTF-8 file content and full-file SHA-256. No shell. Offset/limit are bytes; pages end at complete UTF-8 characters. Follow next_offset; invalid UTF-8 is rejected.',
  write_file: 'Compare-and-swap a UTF-8 file after reviewing its content. Writes default on for personal use; operator restrictions still apply. No directories, hooks or commands are executed.',
  list_dir: 'List scoped files and directories, optionally recursively. Sensitive paths, symlinks, hardlinks and build/dependency directories are omitted. Check truncated.',
  glob: 'Find scoped files using *, ** and ? glob patterns. No shell or regex interpolation; check truncated.',
  grep: 'Find literal text in bounded source files. No shell or regex execution. Returns line numbers and truncation/exclusion counts.',
  artifact_read: 'Return a scoped PNG/JPEG/WebP as actual MCP image content, or a bounded UTF-8 text artifact. A local path alone is not a downloadable attachment.',
  code_mode_read: 'Run read-only tool orchestration JavaScript in a disposable, network-disabled OS sandbox (macOS Seatbelt or Docker). No in-process JS fallback. Returns job_id; poll job_get.',
  code_mode: 'Run tool orchestration JavaScript with operator-enabled write/native capabilities. May modify files or act externally; obtain approval for the whole batch. Returns job_id.',
  exec_command: 'Run a shell command ONLY inside the OS sandbox on a filtered source snapshot. No unsandboxed shell, network, secrets or live writable project. No automatic copy-back. Returns job_id.',
  aside_native: 'Invoke exact Aside CLI argv without shell interpolation. This is a PRIVILEGED HOST adapter, not a sandbox. Enabled by default for personal use; Aside calls run concurrently up to a fixed ceiling and never queue behind CodexClaw. Returns job_id.',
  codexclaw_native: 'Invoke the configured CodexClaw cxc payload with exact argv in the session project. This is a PRIVILEGED HOST adapter and may mutate CodexClaw/project state. Returns job_id.',
  aside_repl: 'Use the optional privileged Aside adapter for direct browser JavaScript, retaining account/host options. Prefer direct calls for visual or single-step tasks. Returns job_id.',
  spawn_subagent: 'Optionally delegate an independent task to Aside exec with the operator-selected permission (personal default: full-access). Not the default coding route. Honors the operator disable switch. Returns job_id.',
  job_get: 'Get status, cursor-paged events, terminal result and errors for a job in this session. wait_ms <=10000. Available even if the source directory moved. Failed/interrupted work is never automatically replayed.',
  job_cancel: 'Request cancellation even if the project directory moved; inspect job_get until terminal. Already-applied file changes or browser actions are not rolled back.',
};

export const readTools = new Set<ToolName>(['session_list', 'capabilities', 'read_file', 'list_dir', 'glob', 'grep', 'artifact_read', 'code_mode_read', 'job_get']);
export const externalTools = new Set<ToolName>(['aside_native', 'codexclaw_native', 'aside_repl', 'spawn_subagent', 'code_mode']);
export const batchReads = ['read_file', 'list_dir', 'glob', 'grep'] as const;
export const batchWrites = ['write_file', 'aside_native', 'codexclaw_native'] as const;
