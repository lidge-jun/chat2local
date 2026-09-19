import { randomUUID } from 'node:crypto';
import { LIMITS } from './config.js';
import { sha256 } from './policy.js';
import { Store, type JobRecord } from './store.js';

export interface JobContext { signal: AbortSignal; log: (text: string) => void }
interface Running { record: JobRecord; controller: AbortController; done: Promise<void> }

/**
 * An error that still carries what the adapter produced.
 *
 * Unconfirmed cleanup must not be reported as success, but throwing the payload
 * away pushes the caller toward a retry that repeats an external side effect.
 * A `CleanupError` fails the job and keeps the output on the record.
 */
export class CleanupError extends Error {
  constructor(message: string, readonly payload: unknown) { super(message); this.name = 'CleanupError'; }
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}

export class Jobs {
  private records = new Map<string, JobRecord>();
  private running = new Map<string, Running>();
  private reservation: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private evicted = 0;
  constructor(private store: Store, private readonly maxActive = LIMITS.activeJobs) {}

  async init() {
    // Sorted on load so insertion order — and therefore eviction order — is the
    // same after a restart as it was before one.
    const loaded = (await this.store.list<JobRecord>('jobs')).sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1);
    for (const record of loaded) {
      if (record.status === 'running') {
        record.status = 'interrupted'; record.finished_at = new Date().toISOString();
        record.error = 'Runtime stopped before completion. Inspect side effects before using a new request_id. No automatic replay.';
        await this.store.save('jobs', record);
      }
      this.records.set(record.id, record);
    }
    // An already-full journal recovers here, without the operator stopping the
    // runtime to archive state by hand.
    await this.prune(LIMITS.jobs);
  }

  /**
   * Bounded ring: evict the oldest terminal records rather than refuse service.
   *
   * Insertion order, scanning for the first terminal record, matching the
   * reference implementation's `state.order` walk. Disk is deleted before the
   * map entry, because a failed unlink that had already dropped the map entry
   * would remove the idempotency guard while the record is still readable on the
   * next start.
   *
   * Evicting a terminal record releases its `request_id`. That is the price of a
   * runtime that keeps serving, and `stats()` makes it visible.
   */
  private async prune(target: number) {
    for (const [id, record] of [...this.records]) {
      if (this.records.size <= target) break;
      if (record.status === 'running') continue;
      await this.store.delete('jobs', id);
      this.records.delete(id);
      this.evicted++;
    }
  }

  stats() { return { retained: this.records.size, evicted: this.evicted, capacity: LIMITS.jobs, active_limit: this.maxActive }; }

  /** Session retention must not evict a session whose work is still in flight. */
  hasRunning(session: string): boolean {
    for (const run of this.running.values()) if (run.record.session_id === session) return true;
    return false;
  }

  start(session: string, key: string, kind: string, input: unknown, task: (ctx: JobContext) => Promise<unknown>): Promise<JobRecord> {
    const op = this.reservation.then(async () => {
      if (this.stopping) throw new Error('Runtime is shutting down');
      const fingerprint = sha256(canonical({ kind, input }));
      const previous = [...this.records.values()].find(r => r.session_id === session && r.key === key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('request_id already used for different input');
        return this.summary(previous);
      }
      if (this.running.size >= this.maxActive) throw new Error(`Active job limit of ${this.maxActive} reached; finish or cancel a job, or raise CHAT2LOCAL_MAX_ACTIVE_JOBS`);
      // Pruning runs after the idempotency lookup above, so a key a caller is
      // retrying right now is never evicted out from under it.
      await this.prune(LIMITS.jobs - 1);
      // Defensive only: admission already caps active jobs at maxActive
      // and init() rewrites persisted 'running' records to 'interrupted', so the
      // public API cannot reach a journal that is full of running jobs.
      if (this.records.size >= LIMITS.jobs) throw new Error('Job journal full of running jobs; cancel one before starting another');
      const record: JobRecord = { id: randomUUID(), session_id: session, key, fingerprint, kind,
        status: 'running', created_at: new Date().toISOString(), events: [], dropped_events: 0 };
      // Persist reservation BEFORE any side effects. Crash recovery never replays it.
      await this.store.save('jobs', record); this.records.set(record.id, record);
      const controller = new AbortController();
      const running: Running = { record, controller, done: Promise.resolve() };
      this.running.set(record.id, running);
      running.done = (async () => {
        try {
          const result = await task({ signal: controller.signal, log: text => {
            if (record.events.length >= 100) { record.dropped_events++; return; }
            record.events.push({ seq: record.events.length, at: new Date().toISOString(), text: text.slice(0, 2048) });
          } });
          if (Buffer.byteLength(JSON.stringify(result ?? null)) > LIMITS.resultBytes) throw new Error('Result exceeds 512 KiB; return a smaller summary');
          record.result = result ?? null;
          record.status = controller.signal.aborted ? 'cancelled' : 'succeeded';
        } catch (e) {
          record.status = controller.signal.aborted ? 'cancelled' : 'failed';
          record.error = e instanceof Error ? e.message : String(e);
          if (e instanceof CleanupError) {
            const json = JSON.stringify(e.payload ?? null);
            record.result = Buffer.byteLength(json) > LIMITS.resultBytes ? { omitted: 'Payload exceeds 512 KiB' } : e.payload;
          }
        } finally {
          record.finished_at = new Date().toISOString();
          try { await this.store.save('jobs', record); }
          finally { this.running.delete(record.id); }
        }
      })();
      // A persistence failure remains visible in memory, without an unhandled rejection.
      running.done.catch(e => { record.status = 'failed'; record.error = `Journal persistence failed: ${String(e)}`; });
      return this.summary(record);
    });
    this.reservation = op.catch(() => {});
    return op;
  }

  private summary(record: JobRecord): JobRecord {
    return { ...record, events: [] , result: undefined };
  }

  async get(session: string, id: string, cursor = 0, waitMs = 0) {
    const record = this.records.get(id);
    if (!record || record.session_id !== session) throw new Error('Job not found in this session');
    if (waitMs > 0 && this.running.has(id)) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.running.get(id)!.done, new Promise<void>(r => { timer = setTimeout(r, waitMs); })]);
      if (timer) clearTimeout(timer);
    }
    return { ...record, events: record.events.slice(cursor, cursor + 50),
      next_cursor: Math.min(cursor + 50, record.events.length) };
  }

  async cancel(session: string, id: string) {
    await this.get(session, id);
    this.running.get(id)?.controller.abort();
    return this.get(session, id, 0, 1000);
  }

  list(session: string) { return [...this.records.values()].filter(r => r.session_id === session).map(r => this.summary(r)); }
  async shutdown() {
    this.stopping = true; await this.reservation;
    for (const run of this.running.values()) run.controller.abort();
    await Promise.allSettled([...this.running.values()].map(r => r.done));
  }
}
