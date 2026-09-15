import { randomUUID } from 'node:crypto';
import { LIMITS } from './config.js';
import { sha256 } from './policy.js';
import { Store, type JobRecord } from './store.js';

export interface JobContext { signal: AbortSignal; log: (text: string) => void }
interface Running { record: JobRecord; controller: AbortController; done: Promise<void> }

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
  constructor(private store: Store) {}

  async init() {
    for (const record of await this.store.list<JobRecord>('jobs')) {
      if (record.status === 'running') {
        record.status = 'interrupted'; record.finished_at = new Date().toISOString();
        record.error = 'Runtime stopped before completion. Inspect side effects before using a new request_id. No automatic replay.';
        await this.store.save('jobs', record);
      }
      this.records.set(record.id, record);
    }
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
      if (this.running.size >= LIMITS.activeJobs) throw new Error('Active job limit reached; finish or cancel a job first');
      if (this.records.size >= LIMITS.jobs) throw new Error('Job journal full; operator must archive old state while stopped');
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
