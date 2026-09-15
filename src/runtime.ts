import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { LIMITS, type Config } from './config.js';
import { Workspace, within, globRegex, PolicyError, sha256 } from './policy.js';
import { Store, type SessionRecord } from './store.js';
import { Jobs, type JobContext } from './jobs.js';
import { Sandbox } from './sandbox.js';
import { backendEnv, runProcess } from './process.js';
import { INSTRUCTIONS } from './instructions.js';
import { schemas, type ToolName, batchReads, batchWrites } from './tools.js';

export class Runtime {
  readonly jobs: Jobs;
  readonly sandbox: Sandbox;
  private workspaces = new Map<string, Workspace>();
  private sessions = new Map<string, SessionRecord>();
  private nativeQueue: Promise<unknown> = Promise.resolve();
  private sessionQueue: Promise<unknown> = Promise.resolve();

  private constructor(readonly config: Config, readonly workspace: Workspace, readonly store: Store) {
    this.jobs = new Jobs(store); this.sandbox = new Sandbox(config);
  }
  static async create(config: Config) {
    const workspace = await Workspace.create(config.workspace, config.allowWrite);
    if (within(workspace.root, config.stateDir) || within(config.stateDir, workspace.root)) throw new Error('State and workspace must be separate, non-nested directories');
    const store = await Store.open(config.stateDir);
    const runtime = new Runtime(config, workspace, store);
    try {
      for (const session of await store.list<SessionRecord>('sessions')) runtime.sessions.set(session.id, session);
      await runtime.jobs.init(); return runtime;
    } catch (e) { await store.close(); throw e; }
  }

  private sessionRecord(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new Error('Unknown session; use session_open');
    return record;
  }

  private async session(id: string) {
    const record = this.sessionRecord(id);
    const project = await this.workspace.path(record.project);
    if (!this.workspaces.has(id)) this.workspaces.set(id, await Workspace.create(project, this.config.allowWrite));
    return { record, workspace: this.workspaces.get(id)! };
  }
  capabilities() {
    const backend = this.config.sandboxBackend;
    const configured = backend === 'seatbelt' ? Boolean(this.config.nodeBinary)
      : backend === 'docker' ? Boolean(this.config.workerImage) : false;
    return { host_shell: false, write_enabled: this.config.allowWrite,
      sandbox_backend: backend,
      code_mode_configured: configured, worker_image: this.config.workerImage || null,
      native_aside_enabled: this.config.allowAside, native_aside_is_sandboxed: false,
      native_aside_permission: this.config.asidePermission, operator_mode: 'personal',
      isolated_commands: backend === 'seatbelt'
        ? 'Filtered snapshot copied into a scratch directory and run under macOS Seatbelt: no network, no access to the live project, no copy-back. Host tools on PATH remain visible and rlimits bound an honest runaway, not a determined attacker.'
        : 'Filtered snapshot, network disabled, no copy-back; dependencies must already be in the image',
      batch_read_tools: batchReads, batch_write_tools: batchWrites.filter(t => t === 'write_file' ? this.config.allowWrite : this.config.allowAside),
      code_api: ['await tools.list()', 'await tools.call(name, args)', 'await tools.map(items, async (item, index) => ..., concurrency)'],
      limits: LIMITS, live_backend_health_checked: false, instructions: INSTRUCTIONS };
  }

  private async openSession(args: { session_id?: string; project: string; title: string }) {
    if (args.session_id) {
      // Resuming task records must not require a still-existing source directory.
      // Every subsequent file/backend operation validates its own workspace.
      const record = this.sessionRecord(args.session_id);
      return { session: record, jobs: this.jobs.list(record.id), workspace_validated: false, ...this.capabilities() };
    }
    if (this.sessions.size >= LIMITS.sessions) throw new Error('Session limit reached; resume an existing session');
    const project = await this.workspace.path(args.project);
    const workspace = await Workspace.create(project, this.config.allowWrite);
    const record: SessionRecord = { id: randomUUID(), project: workspace.root, title: args.title,
      created_at: new Date().toISOString(), checkpoint: '' };
    await this.store.save('sessions', record);
    this.sessions.set(record.id, record); this.workspaces.set(record.id, workspace);
    return { session: record, ...this.capabilities() };
  }

  async invoke(name: ToolName, raw: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
    // SDK and batch calls share EXACTLY the same parser; defaults cannot drift.
    const args = schemas[name].parse(raw) as any;
    if (signal.aborted) throw new Error('Cancelled');
    if (name === 'session_open') {
      const op = this.sessionQueue.then(() => this.openSession(args)); this.sessionQueue = op.catch(() => {}); return op;
    }
    if (name === 'session_list') return { sessions: [...this.sessions.values()] };
    // Job control and checkpoints are journal operations, not source access.
    // Moving/deleting a project must never make a running job uncancellable.
    const record = this.sessionRecord(args.session_id);
    if (name === 'capabilities') return this.capabilities();
    if (name === 'session_checkpoint') {
      const updated = { ...record, checkpoint: args.summary };
      await this.store.save('sessions', updated); this.sessions.set(record.id, updated); return updated;
    }
    if (name === 'job_get') return this.jobs.get(record.id, args.job_id, args.cursor, args.wait_ms);
    if (name === 'job_cancel') return this.jobs.cancel(record.id, args.job_id);
    const { workspace } = await this.session(record.id);
    if ((batchReads as readonly string[]).includes(name) || name === 'write_file' || name === 'artifact_read') return this.primitive(name, args, workspace, signal);
    const ctxInput = { ...args }; delete ctxInput.request_id;
    if (name === 'code_mode' || name === 'code_mode_read') {
      if (name === 'code_mode' && !this.config.allowWrite && !this.config.allowAside) throw new PolicyError('No write/native capabilities enabled; use code_mode_read');
      return this.jobs.start(record.id, args.request_id, name, ctxInput, ctx => this.sandbox.code(args.code, args.timeout, ctx,
        (tool, input, brokerSignal) => this.batchCall(record.id, tool, input, name === 'code_mode_read', { ...ctx, signal: brokerSignal })));
    }
    if (name === 'exec_command') return this.jobs.start(record.id, args.request_id, name, ctxInput,
      ctx => this.sandbox.command(workspace, args.command, args.timeout, ctx));
    if (name === 'aside_native' || name === 'aside_repl' || name === 'spawn_subagent') {
      if (!this.config.allowAside) throw new PolicyError('Privileged Aside adapter disabled by operator');
      let argv = args.args;
      if (name === 'aside_repl') {
        argv = ['repl']; if (args.account) argv.push('--account', args.account); if (args.host) argv.push('--host', args.host);
        argv.push(args.code);
      }
      if (name === 'spawn_subagent') {
        argv = ['exec', '--permission', this.config.asidePermission]; if (args.model) argv.push('-m', args.model); argv.push(args.prompt);
      }
      return this.jobs.start(record.id, args.request_id, name, ctxInput, ctx => this.native(argv, args.timeout, workspace, ctx));
    }
    throw new Error('Unsupported tool');
  }

  private async primitive(name: ToolName, args: any, workspace: Workspace, signal: AbortSignal): Promise<unknown> {
    if (name === 'read_file') return workspace.read(args.path, args.offset, args.limit);
    if (name === 'write_file') return workspace.write(args.path, args.content, args.expected_sha256, signal);
    if (name === 'list_dir') return workspace.list(args.path, args.recursive);
    if (name === 'glob') {
      const { entries, ...meta } = await workspace.list(args.path, true);
      const pattern = globRegex(args.pattern), base = await workspace.path(args.path);
      return { files: entries.filter(e => e.type === 'file' && pattern.test(relative(base, workspace.root + '/' + e.path).split('\\').join('/'))).map(e => e.path), ...meta };
    }
    if (name === 'grep') {
      const target = await workspace.path(args.path);
      const listing = (await lstat(target)).isDirectory() ? await workspace.list(args.path, true)
        : { entries: [{ path: args.path, type: 'file' as const, size: (await lstat(target)).size }], omitted: 0, truncated: false };
      const matches: Array<{ path: string; line: number; content: string }> = [];
      let skipped = 0, bytes = 0, truncated = listing.truncated;
      const query = args.caseSensitive ? args.pattern : args.pattern.toLowerCase();
      for (const entry of listing.entries) {
        if (entry.type !== 'file') continue;
        if (entry.size > LIMITS.fileBytes) { skipped++; continue; }
        if ((bytes += entry.size) > LIMITS.snapshotBytes) { truncated = true; break; }
        const data = await workspace.buffer(entry.path);
        if (data.includes(0) || !isUtf8(data)) { skipped++; continue; }
        for (const [index, line] of data.toString('utf8').split('\n').entries()) {
          if ((args.caseSensitive ? line : line.toLowerCase()).includes(query)) matches.push({ path: entry.path, line: index + 1, content: line.slice(0, 2000) });
          if (matches.length >= args.maxResults) { truncated = true; break; }
        }
        if (matches.length >= args.maxResults) break;
      }
      return { matches, omitted: listing.omitted, skipped, truncated };
    }
    if (name === 'artifact_read') {
      const data = await workspace.buffer(args.path);
      if (data.length > LIMITS.resultBytes) throw new Error('Artifact exceeds 512 KiB inline limit');
      let mime: string | undefined;
      if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
      else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) mime = 'image/jpeg';
      else if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
      if (mime) return { image: { data: data.toString('base64'), mimeType: mime }, name: basename(args.path), sha256: sha256(data) };
      if (data.includes(0) || !isUtf8(data) || data.toString('ascii', 0, 5) === '%PDF-') throw new Error('Binary artifact not supported inline; only PNG/JPEG/WebP and UTF-8 text');
      return { name: basename(args.path), text: data.toString('utf8'), sha256: sha256(data) };
    }
    throw new Error('Unknown primitive');
  }

  private async batchCall(sessionId: string, name: string, input: unknown, readOnly: boolean, ctx: JobContext): Promise<unknown> {
    const names = [...batchReads, ...(!readOnly ? batchWrites.filter(t => t === 'write_file' ? this.config.allowWrite : this.config.allowAside) : [])];
    if (name === '$list') return names.map(n => ({ name: n, description: n === 'aside_native' ? 'Privileged host Aside CLI argv; serial execution' : 'Use the corresponding MCP tool schema without session_id' }));
    if (!(names as readonly string[]).includes(name)) throw new PolicyError(`Tool unavailable in this batch: ${name}`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be an object');
    if ('session_id' in input || 'request_id' in input) throw new PolicyError('Session and request identity are supplied by the broker');
    if (ctx.signal.aborted) throw new Error('Cancelled');
    if (name === 'aside_native') {
      const args = schemas.aside_native.parse({ ...input, session_id: sessionId, request_id: 'broker' });
      return this.native(args.args, args.timeout, (await this.session(sessionId)).workspace, ctx);
    }
    return this.invoke(name as ToolName, { ...input, session_id: sessionId }, ctx.signal);
  }

  private native(args: string[], timeout: number, workspace: Workspace, ctx: JobContext) {
    const op = this.nativeQueue.then(async () => {
      if (!this.config.allowAside) throw new PolicyError('Privileged Aside adapter disabled');
      if (ctx.signal.aborted) throw new Error('Cancelled before native execution');
      const result = await runProcess(this.config.asideBinary, args,
        { cwd: workspace.root, env: backendEnv(true), timeout, signal: ctx.signal });
      if (result.timed_out || result.cancelled || result.output_limited || result.exit_code !== 0) throw new Error(`Aside failed: ${JSON.stringify(result)}`);
      return result;
    });
    this.nativeQueue = op.catch(() => {}); return op;
  }

  async close() { await this.jobs.shutdown(); await this.nativeQueue; await this.sessionQueue; await this.store.close(); }
}
