import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { LIMITS, type Config } from './config.js';
import { Workspace, within, globRegex, PolicyError, sha256 } from './policy.js';
import { Store, type SessionRecord } from './store.js';
import { Jobs, CleanupError, type JobContext } from './jobs.js';
import { Sandbox } from './sandbox.js';
import { Gate } from './gate.js';
import { backendEnv, runProcess, type ProcessResult } from './process.js';
import { INSTRUCTIONS } from './instructions.js';
import { schemas, type ToolName, batchReads, batchWrites } from './tools.js';

/**
 * The Aside CLI announces a session it created on the FIRST line of stderr,
 * before the agent it launched produces anything.
 *
 * That ordering is the whole security argument. The model controls `aside_native`
 * argv and `aside_repl` code, so any text it can place in the output stream must
 * not be able to name a session id: matching exactly the first line, with no
 * `m` flag and no stdout, means model-authored text cannot precede the CLI's own
 * banner. A parse miss reaps nothing, so every surprise — a reworded banner,
 * JSON output, an unexpected warning line — fails toward doing nothing rather
 * than toward stopping a session this runtime does not own.
 */
const CREATED_SESSION = /^created new session: ([A-Za-z0-9]{8,64})$/;
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
export interface SessionReap { id: string; stopped: boolean; error?: string }

export function createdSession(stderr: string): string | undefined {
  const first = stderr.replace(ANSI, '').split('\n', 1)[0].trim();
  return CREATED_SESSION.exec(first)?.[1];
}

export class Runtime {
  readonly jobs: Jobs;
  readonly sandbox: Sandbox;
  private workspaces = new Map<string, Workspace>();
  private sessions = new Map<string, SessionRecord>();
  /**
   * One bounded gate per privileged adapter, never a shared queue.
   *
   * Aside and CodexClaw are different external systems; a long agent run on one
   * must not decide when a call to the other may start.
   */
  private readonly asideGate: Gate;
  private readonly codexclawGate: Gate;
  private sessionQueue: Promise<unknown> = Promise.resolve();
  private evictedSessions = 0;
  /** When each session record was last written, so the throttle cannot starve. */
  private persistedAt = new Map<string, number>();
  /** Tool calls currently resolving against each session, by session id. */
  private inFlight = new Map<string, number>();

  private constructor(readonly config: Config, readonly workspace: Workspace, readonly store: Store) {
    this.jobs = new Jobs(store, config.maxActiveJobs); this.sandbox = new Sandbox(config);
    this.asideGate = new Gate(config.nativeConcurrency); this.codexclawGate = new Gate(config.nativeConcurrency);
  }
  static async create(config: Config) {
    const workspace = await Workspace.create(config.workspace, config.allowWrite);
    if (within(workspace.root, config.stateDir) || within(config.stateDir, workspace.root)) throw new Error('State and workspace must be separate, non-nested directories');
    const store = await Store.open(config.stateDir);
    const runtime = new Runtime(config, workspace, store);
    try {
      for (const session of await store.list<SessionRecord>('sessions')) runtime.sessions.set(session.id, session);
      await runtime.jobs.init();
      // The loader no longer refuses an over-capacity directory, so retention has
      // to run at startup too, not only when the next session is opened.
      await runtime.pruneSessions(config.maxSessions);
      return runtime;
    } catch (e) { await store.close(); throw e; }
  }

  private sessionRecord(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new Error('Unknown session; use session_open');
    this.touch(record);
    return record;
  }

  /**
   * Record use for least-recently-used retention.
   *
   * Persisted at most once a minute per session: retention only needs to know
   * which sessions are cold, and a journal write per tool call would be a real
   * cost for no extra accuracy.
   */
  private touch(record: SessionRecord) {
    record.last_used_at = new Date().toISOString();
    // Throttled against the last WRITE, not the last use. Throttling against the
    // last use means a conversation busier than once a minute never persists at
    // all and looks stale after a restart.
    const written = this.persistedAt.get(record.id) ?? 0;
    if (Date.now() - written < 60_000) return;
    this.persistedAt.set(record.id, Date.now());
    void this.writeSession(record.id);
  }

  /**
   * The one path that writes a session record.
   *
   * It queues behind session retention and re-reads the live record at write
   * time rather than persisting a captured object. Both properties matter: a
   * delayed use-timestamp write must not overwrite a checkpoint saved after it,
   * and it must not recreate a record that retention has already deleted.
   */
  private writeSession(id: string): Promise<unknown> {
    const op = this.sessionQueue.then(() => {
      const live = this.sessions.get(id);
      return live ? this.store.save('sessions', live) : undefined;
    });
    this.sessionQueue = op.catch(() => {});
    return op;
  }

  /**
   * Evict least-recently-used sessions, not oldest-created ones: a live
   * conversation can hold a session that was opened days ago, while a session
   * opened this morning and abandoned is the disposable one.
   *
   * Jobs owned by an evicted session are not deleted here; they age out through
   * the job ring, and `jobs.get` already refuses a session that no longer matches.
   */
  private async pruneSessions(target: number, exempt?: string) {
    const order = [...this.sessions.values()].sort((a, b) =>
      (a.last_used_at ?? a.created_at).localeCompare(b.last_used_at ?? b.created_at));
    for (const record of order) {
      if (this.sessions.size <= target) break;
      // The session this prune is making room for is never its own victim.
      if (record.id === exempt) continue;
      // Never evict a session whose work is still in flight: job_get and
      // job_cancel both resolve the session first, so evicting it would leave a
      // running job unobservable and uncancellable.
      if (this.jobs.hasRunning(record.id)) continue;
      // Nor one with a call already in progress, which jobs.hasRunning() cannot
      // see until that call has registered its job.
      if (this.inFlight.has(record.id)) continue;
      // Drop the record in the same tick as the checks above. Awaiting the unlink
      // first would leave a window where a new call resolves this session and
      // registers a job against a record retention is already retiring; that job
      // would be unobservable and uncancellable. Removing it from memory first
      // means a call arriving now is cleanly rejected with 'Unknown session'.
      const live = this.sessions.get(record.id) ?? record;
      this.sessions.delete(record.id);
      this.workspaces.delete(record.id);
      this.persistedAt.delete(record.id);
      try { await this.store.delete('sessions', record.id); }
      catch {
        // The record is still on disk, so put it back rather than losing it on the
        // next restart. Retention tries again later; failing here would reject the
        // session_open whose own record is already saved.
        this.sessions.set(live.id, live);
        continue;
      }
      this.evictedSessions++;
    }
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
      native_aside_permission: this.config.asidePermission,
      codexclaw_native_enabled: Boolean(this.config.allowWrite && this.config.nodeBinary && this.config.codexclawEntry),
      codexclaw_entry: this.config.codexclawEntry || null,
      codexclaw_native_is_sandboxed: false, operator_mode: 'personal',
      native_concurrency: this.config.nativeConcurrency,
      max_active_jobs: this.config.maxActiveJobs,
      native_aside_reaps_sessions: this.config.allowAside && this.config.asideReapSessions,
      job_journal: this.jobs.stats(),
      session_journal: { retained: this.sessions.size, evicted: this.evictedSessions, capacity: this.config.maxSessions },
      isolated_commands: backend === 'seatbelt'
        ? 'Filtered snapshot copied into a scratch directory and run under macOS Seatbelt: no network, no access to the live project, no copy-back. Host tools on PATH remain visible and rlimits bound an honest runaway, not a determined attacker.'
        : 'Filtered snapshot, network disabled, no copy-back; dependencies must already be in the image',
      batch_read_tools: batchReads, batch_write_tools: batchWrites.filter(t => t === 'write_file' ? this.config.allowWrite : t === 'aside_native' ? this.config.allowAside : this.config.allowWrite && Boolean(this.config.codexclawEntry)),
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
    const project = await this.workspace.path(args.project);
    const workspace = await Workspace.create(project, this.config.allowWrite);
    const now = new Date().toISOString();
    const record: SessionRecord = { id: randomUUID(), project: workspace.root, title: args.title,
      created_at: now, checkpoint: '', last_used_at: now };
    // Persist the replacement FIRST, then retire cold records. Pruning ahead of a
    // save that can still fail means a rejected open costs the operator a good
    // session, which is the opposite of what retention is for. Capacity is a
    // retention target, so briefly holding one extra record is fine; refusing to
    // open a session is not.
    await this.store.save('sessions', record);
    this.sessions.set(record.id, record); this.workspaces.set(record.id, workspace);
    this.persistedAt.set(record.id, Date.now());
    // Capacity is a target, not a wall. When every existing session is protected
    // the journal holds one more for now and the next open tries again;
    // protection is transient, while refusing to open a session is not.
    if (this.sessions.size > this.config.maxSessions) await this.pruneSessions(this.config.maxSessions, record.id);
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
    // A call that has resolved its session but has not registered its job yet is
    // invisible to jobs.hasRunning(). Counting it here, and releasing it only when
    // the call returns, is what stops retention from evicting a session out from
    // under work that is already admitted.
    this.inFlight.set(record.id, (this.inFlight.get(record.id) ?? 0) + 1);
    try { return await this.dispatch(name, args, record, signal); }
    finally {
      const remaining = (this.inFlight.get(record.id) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(record.id, remaining); else this.inFlight.delete(record.id);
    }
  }

  private async dispatch(name: ToolName, args: any, record: SessionRecord, signal: AbortSignal): Promise<unknown> {
    if (name === 'capabilities') return this.capabilities();
    if (name === 'session_checkpoint') {
      const updated = { ...record, checkpoint: args.summary };
      this.sessions.set(record.id, updated);
      await this.writeSession(record.id);
      return updated;
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
    if (name === 'codexclaw_native') {
      if (!this.config.allowWrite) throw new PolicyError('CodexClaw native adapter disabled because writes are disabled');
      if (!this.config.nodeBinary || !this.config.codexclawEntry) throw new PolicyError('CodexClaw native adapter is not configured');
      return this.jobs.start(record.id, args.request_id, name, ctxInput, ctx => this.codexclaw(args.args, args.timeout, workspace, ctx));
    }
    if (name === 'aside_native' || name === 'aside_repl' || name === 'spawn_subagent') {
      if (!this.config.allowAside) throw new PolicyError('Privileged Aside adapter disabled by operator');
      let argv = args.args;
      if (name === 'aside_repl') {
        argv = ['repl']; if (args.account) argv.push('--account', args.account); if (args.host) argv.push('--host', args.host);
        // Same terminator as spawn_subagent, after the options so neither loses its
        // value. The code is model-authored and the schema allows a leading dash.
        argv.push('--', args.code);
      }
      if (name === 'spawn_subagent') {
        argv = ['exec', '--permission', this.config.asidePermission]; if (args.model) argv.push('-m', args.model);
        // The argument terminator is what stops a model-authored prompt from being
        // read as CLI options. Without it a prompt beginning with a dash can pick
        // flags — including, on some builds, a flag naming an existing session.
        argv.push('--', args.prompt);
      }
      // Ownership is asserted here, by the call site that built the argv, and is
      // never inferred from output. Only spawn_subagent is a runtime-constructed,
      // one-shot session, so only it is reaped.
      return this.jobs.start(record.id, args.request_id, name, ctxInput,
        ctx => this.native(argv, args.timeout, workspace, ctx, name === 'spawn_subagent'));
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
    const names = [...batchReads, ...(!readOnly ? batchWrites.filter(t => t === 'write_file' ? this.config.allowWrite : t === 'aside_native' ? this.config.allowAside : this.config.allowWrite && Boolean(this.config.codexclawEntry)) : [])];
    if (name === '$list') return names.map(n => ({ name: n, description: n === 'aside_native' ? `Privileged host Aside CLI argv; up to ${this.config.nativeConcurrency} in flight` : n === 'codexclaw_native' ? `Privileged CodexClaw cxc argv in the session project; up to ${this.config.nativeConcurrency} in flight` : 'Use the corresponding MCP tool schema without session_id' }));
    if (!(names as readonly string[]).includes(name)) throw new PolicyError(`Tool unavailable in this batch: ${name}`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be an object');
    if ('session_id' in input || 'request_id' in input) throw new PolicyError('Session and request identity are supplied by the broker');
    if (ctx.signal.aborted) throw new Error('Cancelled');
    if (name === 'aside_native') {
      const args = schemas.aside_native.parse({ ...input, session_id: sessionId, request_id: 'broker' });
      return this.native(args.args, args.timeout, (await this.session(sessionId)).workspace, ctx, false);
    }
    if (name === 'codexclaw_native') {
      const args = schemas.codexclaw_native.parse({ ...input, session_id: sessionId, request_id: 'broker' });
      return this.codexclaw(args.args, args.timeout, (await this.session(sessionId)).workspace, ctx);
    }
    return this.invoke(name as ToolName, { ...input, session_id: sessionId }, ctx.signal);
  }

  private codexclaw(args: string[], timeout: number, workspace: Workspace, ctx: JobContext) {
    return this.codexclawGate.run(async () => {
      if (!this.config.allowWrite) throw new PolicyError('CodexClaw native adapter disabled');
      const entry = this.config.codexclawEntry;
      if (!this.config.nodeBinary || !entry) throw new PolicyError('CodexClaw native adapter is not configured');
      // Re-check immediately before exec, not only at startup. The payload lives on
      // a filesystem the operator keeps using, and this adapter runs it unsandboxed
      // with host privileges; a path that became writable-from-workspace after boot
      // must not be executed just because it passed once.
      if (within(this.config.workspace, entry)) throw new PolicyError('CodexClaw entry is inside the writable workspace; refusing to execute a payload the model can rewrite');
      if (ctx.signal.aborted) throw new Error('Cancelled before CodexClaw execution');
      const result = await runProcess(this.config.nodeBinary, [entry, ...args],
        { cwd: workspace.root, env: backendEnv(true), timeout, signal: ctx.signal });
      if (result.timed_out || result.cancelled || result.output_limited || result.exit_code !== 0) throw new Error('CodexClaw failed: '+JSON.stringify(result));
      return result;
    }, ctx.signal);
  }

  private native(args: string[], timeout: number, workspace: Workspace, ctx: JobContext, owned: boolean) {
    return this.asideGate.run(async () => {
      if (!this.config.allowAside) throw new PolicyError('Privileged Aside adapter disabled');
      if (ctx.signal.aborted) throw new Error('Cancelled before native execution');
      // The banner is observed as it arrives, because a rejected runProcess never
      // returns the buffered stderr and the session it announced would then be
      // unreachable.
      let banner = '';
      const observe = (chunk: Buffer) => { if (banner.length < 512) banner += chunk.toString('utf8'); };
      let result: ProcessResult;
      try {
        result = await runProcess(this.config.asideBinary, args,
          { cwd: workspace.root, env: backendEnv(true), timeout, signal: ctx.signal, onStderr: observe });
      } catch (e) {
        const orphan = createdSession(banner);
        if (owned && orphan && this.config.asideReapSessions) {
          const stop = await this.stopSession(orphan);
          // Losing the id here would leave a session nobody knows to clean up.
          if (!stop.stopped) throw new CleanupError(`Aside session ${stop.id} was created but could not be `
            + `stopped: ${stop.error}. Stop it manually. The run itself failed: `
            + `${e instanceof Error ? e.message : String(e)}`, { session: stop });
        }
        throw e;
      }
      const created = createdSession(banner || result.stderr);
      // A killed or timed-out CLI leaves a session that is abandoned by
      // definition, so the same reap covers success, timeout and cancellation.
      const reap = owned && created !== undefined && this.config.asideReapSessions;
      const stop = reap ? await this.stopSession(created!) : undefined;
      const payload = stop ? { ...result, session: stop }
        : created ? { ...result, session_hint: created } : result;
      const ranBadly = result.timed_out || result.cancelled || result.output_limited || result.exit_code !== 0;
      // Cleanup failure is checked first so the combined case still carries the
      // payload on the record instead of only inside an error string.
      if (stop && !stop.stopped)
        throw new CleanupError(`Aside session ${stop.id} could not be stopped: ${stop.error}. `
          + `Stop it manually before reusing this request_id.${ranBadly ? ' The run itself also failed.' : ''}`, payload);
      if (ranBadly) throw new Error(`Aside failed: ${JSON.stringify(payload)}`);
      return payload;
    }, ctx.signal);
  }

  /**
   * Stop a session this runtime created.
   *
   * Deliberately runs without the job's AbortSignal and on its own timeout: a
   * cancelled job is exactly the case where the session most needs releasing.
   * It runs inside the caller's own gate slot, on the id that caller's process
   * announced on its first stderr line, so a concurrent run can never stop a
   * session it does not own.
   */
  private async stopSession(id: string): Promise<SessionReap> {
    try {
      const result = await runProcess(this.config.asideBinary, ['session', 'stop', id],
        { cwd: this.workspace.root, env: backendEnv(true), timeout: 30_000 });
      // Exit 0 alone is not success for this CLI: a policy denial is reported in
      // the output while the process still exits cleanly. `stopped` therefore
      // means "the CLI reported no failure", which is the strongest postcondition
      // the CLI offers, and nothing more.
      const denied = /is blocked by policy|permission denied/i.test(result.stdout + result.stderr);
      if (result.exit_code === 0 && !result.timed_out && !result.output_limited && !denied) return { id, stopped: true };
      return { id, stopped: false, error: (result.stderr || result.stdout || `exit ${result.exit_code}`).slice(0, 500) };
    } catch (e) {
      return { id, stopped: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // jobs.shutdown() aborts first, which is what releases a call still waiting for
  // a gate slot; draining then waits only for children that actually started.
  async close() { await this.jobs.shutdown(); await this.asideGate.drain(); await this.codexclawGate.drain(); await this.sessionQueue; await this.store.close(); }
}
