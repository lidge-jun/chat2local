import { mkdir, open, readFile, readdir, rename, unlink, lstat, chmod, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS } from './config.js';

export interface SessionRecord {
  id: string; project: string; title: string; created_at: string; checkpoint: string;
  /** Optional so records written by earlier versions still load. */
  last_used_at?: string;
}
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface JobRecord {
  id: string; session_id: string; key: string; fingerprint: string; kind: string;
  status: JobStatus; created_at: string; finished_at?: string;
  events: Array<{ seq: number; at: string; text: string }>;
  dropped_events: number; result?: unknown; error?: string;
}
export function validId(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid identifier');
  return id;
}

/** Private, single-operator journal. The lock prevents concurrent runtime writers. */
export class Store {
  /**
   * One chain per record, not one for the whole journal.
   *
   * Two records are two separate files written through separate temporaries and
   * an atomic rename, so ordering only has to hold for writes to the same id.
   * A single chain made every fsync wait for every other fsync, which is what a
   * hundred concurrent sessions would have queued on.
   */
  private serial = new Map<string, Promise<unknown>>();
  /** Every unfinished write, so close() still waits for all of them. */
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private constructor(readonly root: string) {}

  private chain<T>(kind: 'sessions' | 'jobs', id: string, task: () => Promise<T>): Promise<T> {
    const key = `${kind}/${id}`;
    const previous = this.serial.get(key) ?? Promise.resolve();
    const operation = previous.then(task);
    const settled = operation.then(() => {}, () => {});
    this.serial.set(key, settled); this.pending.add(settled);
    void settled.then(() => {
      this.pending.delete(settled);
      if (this.serial.get(key) === settled) this.serial.delete(key);
    });
    return operation;
  }

  static async open(path: string): Promise<Store> {
    const root = resolve(path);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('State path must be canonical, not symlinked');
    await chmod(root, 0o700);
    const lock = join(root, 'runtime.lock');
    for (let attempt = 0; ; attempt++) {
      try {
        const h = await open(lock, 'wx', 0o600);
        try { await h.writeFile(String(process.pid)); await h.sync(); } finally { await h.close(); }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
        if ((await lstat(lock)).isSymbolicLink()) throw new Error('Invalid runtime lock');
        const pid = Number(await readFile(lock, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid runtime lock; inspect it manually');
        try { process.kill(pid, 0); throw new Error('State directory is in use by another runtime'); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
        await unlink(lock);
      }
    }
    const store = new Store(root);
    try {
      // 'workers' belongs here even though save() never writes to it: Sandbox.code
      // creates workers/<uuid> with mkdir recursive, which would happily follow a
      // symlink planted at that name.
      for (const dir of ['sessions', 'jobs', 'snapshots', 'workers']) {
        const p = join(root, dir); await mkdir(p, { mode: 0o700 });
      }
    } catch (e) {
      // Existing state directories are valid, but none may be redirected.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { await store.close(); throw e; }
      for (const dir of ['sessions', 'jobs', 'snapshots', 'workers']) {
        const p = join(root, dir); await mkdir(p, { recursive: true, mode: 0o700 });
        if (!(await lstat(p)).isDirectory() || await realpath(p) !== p) { await store.close(); throw new Error('Invalid state directory'); }
      }
    }
    try { await store.sweepTemporaries(); } catch (e) { await store.close(); throw e; }
    return store;
  }

  /**
   * Remove this writer's own interrupted `save()` temporaries.
   *
   * A kill between `open(temp)` and `rename()` leaves `.<uuid>.tmp` behind
   * forever: nothing reads it, nothing counts it, and it never expires. The
   * runtime lock is already held here, so no other runtime owns these files, and
   * the pattern matches only the name `save()` constructs.
   */
  private async sweepTemporaries() {
    // Exactly what randomUUID() produces: version 4, RFC 4122 variant. A looser
    // pattern matches names this writer cannot create, which means someone else's
    // file. Only 'sessions' and 'jobs' are written through save(), so a matching
    // name anywhere else is outside this writer's namespace and is left alone.
    const temporary = /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
    for (const kind of ['sessions', 'jobs'] as const) {
      const dir = join(this.root, kind);
      for (const name of await readdir(dir)) {
        if (!temporary.test(name)) continue;
        const path = join(dir, name);
        // A symlink or a hardlinked file is not something this writer created.
        const st = await lstat(path).catch(() => undefined);
        if (!st || !st.isFile() || st.nlink !== 1) continue;
        await unlink(path).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
      }
    }
  }

  async read<T>(kind: 'sessions' | 'jobs', id: string): Promise<T> {
    const p = join(this.root, kind, `${validId(id)}.json`);
    const st = await lstat(p);
    if (!st.isFile() || st.nlink !== 1 || st.size > 2 * LIMITS.resultBytes) throw new Error('Invalid journal record');
    return JSON.parse(await readFile(p, 'utf8')) as T;
  }

  save(kind: 'sessions' | 'jobs', record: SessionRecord | JobRecord): Promise<void> {
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > 2 * LIMITS.resultBytes) return Promise.reject(new Error('Journal record too large'));
    return this.chain(kind, record.id, async () => {
      if (this.closed) throw new Error('Store closed');
      const path = join(this.root, kind, `${validId(record.id)}.json`);
      const temp = join(dirname(path), `.${randomUUID()}.tmp`);
      const h = await open(temp, 'wx', 0o600);
      try { await h.writeFile(json); await h.sync(); await h.close(); await rename(temp, path); }
      finally { await h.close().catch(() => {}); await unlink(temp).catch(() => {}); }
    });
  }

  /** Deleting a record is how retention works; a missing file is already the goal. */
  delete(kind: 'sessions' | 'jobs', id: string): Promise<void> {
    return this.chain(kind, id, async () => {
      if (this.closed) throw new Error('Store closed');
      await unlink(join(this.root, kind, `${validId(id)}.json`))
        .catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
    });
  }

  /**
   * Load every record.
   *
   * This used to refuse to load a journal at capacity, which left the operator
   * with no way back: the runtime that wrote the 512th record could not start
   * again to prune it. Retention now belongs to the components that understand
   * which records are disposable — `Jobs` and `Runtime` — and the loader just
   * loads.
   */
  async list<T>(kind: 'sessions' | 'jobs'): Promise<T[]> {
    const names = (await readdir(join(this.root, kind))).filter(x => /^[a-f0-9-]{36}\.json$/.test(x));
    return Promise.all(names.map(name => this.read<T>(kind, name.slice(0, -5))));
  }

  async close() {
    // Drained in a loop: a write can still be queued behind one this call is
    // already waiting on.
    while (this.pending.size) await Promise.all([...this.pending]);
    if (this.closed) return;
    this.closed = true; await unlink(join(this.root, 'runtime.lock')).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
  }
}
