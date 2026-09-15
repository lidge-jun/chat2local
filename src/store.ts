import { mkdir, open, readFile, readdir, rename, unlink, lstat, chmod, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS } from './config.js';

export interface SessionRecord {
  id: string; project: string; title: string; created_at: string; checkpoint: string;
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
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(readonly root: string) {}

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
      for (const dir of ['sessions', 'jobs', 'snapshots']) {
        const p = join(root, dir); await mkdir(p, { mode: 0o700 });
      }
    } catch (e) {
      // Existing state directories are valid, but none may be redirected.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { await store.close(); throw e; }
      for (const dir of ['sessions', 'jobs', 'snapshots']) {
        const p = join(root, dir); await mkdir(p, { recursive: true, mode: 0o700 });
        if (!(await lstat(p)).isDirectory() || await realpath(p) !== p) { await store.close(); throw new Error('Invalid state directory'); }
      }
    }
    return store;
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
    const op = this.serial.then(async () => {
      if (this.closed) throw new Error('Store closed');
      const path = join(this.root, kind, `${validId(record.id)}.json`);
      const temp = join(dirname(path), `.${randomUUID()}.tmp`);
      const h = await open(temp, 'wx', 0o600);
      try { await h.writeFile(json); await h.sync(); await h.close(); await rename(temp, path); }
      finally { await h.close().catch(() => {}); await unlink(temp).catch(() => {}); }
    });
    this.serial = op.catch(() => {});
    return op;
  }

  async list<T>(kind: 'sessions' | 'jobs'): Promise<T[]> {
    const names = (await readdir(join(this.root, kind))).filter(x => /^[a-f0-9-]{36}\.json$/.test(x));
    const max = kind === 'jobs' ? LIMITS.jobs : LIMITS.sessions;
    if (names.length > max) throw new Error('Journal capacity exceeded; archive old state while runtime is stopped');
    return Promise.all(names.map(name => this.read<T>(kind, name.slice(0, -5))));
  }

  async close() {
    await this.serial; if (this.closed) return;
    this.closed = true; await unlink(join(this.root, 'runtime.lock')).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
  }
}
