import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { lstat, open, readdir, realpath, rename, unlink, mkdir, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIMITS } from './config.js';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function within(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
export class PolicyError extends Error { override name = 'PolicyError'; }

/** A deny-list is defense in depth, not a secret classifier. Choose a source-only root. */
export function blockedName(name: string): boolean {
  const n = name.toLowerCase();
  return ['.git', '.ssh', '.aws', '.azure', '.config', '.codex', '.aside', '.chat2local',
    '.chat2local-local', '.gnupg', '.npmrc', '.netrc', 'auth.json', 'credentials.json',
    'credentials', 'id_rsa', 'id_ed25519', 'login.keychain-db'].includes(n)
    || n.startsWith('.env') || /\.(pem|key|p12|pfx|keychain-db|kdbx)$/.test(n);
}

export class Workspace {
  /**
   * One lock per target file, shared across sessions and overlapping roots.
   *
   * A single global queue made every edit wait behind every other edit, so a
   * hundred sessions touching a hundred different files took a hundred turns for
   * no correctness gain. What compare-and-swap actually needs is that two
   * writers to the SAME file cannot interleave their read, verify and rename.
   * Keys are resolved absolute paths, so two sessions reaching one file through
   * different roots still contend on a single lock.
   */
  private static locks = new Map<string, Promise<unknown>>();
  private constructor(readonly root: string, readonly writable: boolean) {}

  private static lock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = Workspace.locks.get(key) ?? Promise.resolve();
    const operation = previous.then(task);
    const settled = operation.then(() => {}, () => {});
    Workspace.locks.set(key, settled);
    // Release the key once this call is the tail, so the map holds live writers
    // rather than every file the runtime has ever touched.
    void settled.then(() => { if (Workspace.locks.get(key) === settled) Workspace.locks.delete(key); });
    return operation;
  }

  /** Files with a write in flight or queued behind one. Introspection only. */
  static writeLocks(): number { return Workspace.locks.size; }

  static async create(root: string, writable = false): Promise<Workspace> {
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory()) throw new PolicyError('Workspace is not a directory');
    if (within(canonical, homedir())) throw new PolicyError('Do not expose your home directory or an ancestor');
    return new Workspace(canonical, writable);
  }

  async path(input: string, missingLeaf = false): Promise<string> {
    // A cached session root can be moved or replaced between calls. Revalidate
    // it too, not only descendants; do not follow a newly substituted symlink.
    if (!(await lstat(this.root)).isDirectory() || await realpath(this.root) !== this.root)
      throw new PolicyError('Workspace root changed; select a valid source directory');
    if (!input || input.includes('\0') || input.includes('\\')) throw new PolicyError('Invalid path');
    const target = resolve(this.root, input);
    if (!within(this.root, target)) throw new PolicyError('Path escapes the selected workspace');
    const parts = relative(this.root, target).split(sep).filter(Boolean);
    if (parts.some(blockedName)) throw new PolicyError('Sensitive or control path is blocked');
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      let st;
      try { st = await lstat(current); }
      catch (e) {
        if (missingLeaf && i === parts.length - 1 && (e as NodeJS.ErrnoException).code === 'ENOENT') return target;
        throw e;
      }
      if (st.isSymbolicLink()) throw new PolicyError('Symlinks are not exposed');
      if (!st.isDirectory() && !st.isFile()) throw new PolicyError('Special files are not exposed');
      if (st.isFile() && st.nlink !== 1) throw new PolicyError('Hard-linked files are not exposed');
    }
    return target;
  }

  async buffer(path: string): Promise<Buffer> {
    const target = await this.path(path);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1) throw new PolicyError('Only single-linked regular files are readable');
      if (st.size > LIMITS.fileBytes) throw new PolicyError(`File exceeds ${LIMITS.fileBytes} bytes`);
      const bytes = Buffer.alloc(Math.min(st.size + 1, LIMITS.fileBytes + 1));
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > LIMITS.fileBytes || length > st.size) throw new PolicyError('File grew during read; retry');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  async read(path: string, offset = 0, limit = LIMITS.readBytes) {
    const data = await this.buffer(path);
    if (!isUtf8(data)) throw new PolicyError('File is not valid UTF-8; refusing a lossy text read');
    const continuation = (index: number) => index < data.length && (data[index] & 0xc0) === 0x80;
    if (offset < data.length && continuation(offset)) throw new PolicyError('Offset must be a UTF-8 boundary; follow next_offset');
    let end = Math.min(data.length, offset + limit);
    // Keep the byte limit without returning half a Korean character or emoji.
    while (end > offset && continuation(end)) end--;
    if (end === offset && offset < data.length) throw new PolicyError('Read limit is too small for the next UTF-8 character; use at least 4 bytes');
    return { path, content: data.subarray(offset, end).toString('utf8'),
      sha256: sha256(data), total_bytes: data.length, offset,
      next_offset: end < data.length ? end : null };
  }

  /** Compare-and-swap edits, serialized per target file; callers must read and supply the current hash. */
  write(path: string, content: string, expected: string, signal?: AbortSignal) {
    // The key is the resolved target, computed without I/O so the lock is taken
    // during the call itself. That keeps issue order: two writers to one file
    // apply in the order they were called, exactly as the old global queue did.
    // Resolution normalizes spelling, and two roots that reach one file produce
    // one key, so aliases contend rather than racing. Validation stays inside.
    return Workspace.lock(resolve(this.root, path), async () => {
      if (signal?.aborted) throw new PolicyError('Write cancelled before execution');
      if (!this.writable) throw new PolicyError('Writes disabled by operator; set CHAT2LOCAL_ALLOW_WRITE=1 to re-enable');
      if (Buffer.byteLength(content) > LIMITS.fileBytes) throw new PolicyError('Write exceeds file limit');
      const target = await this.path(path, true);
      if (target === this.root) throw new PolicyError('Cannot replace workspace root');
      let old: Buffer | undefined;
      try { old = await this.buffer(path); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if ((old ? sha256(old) : 'absent') !== expected) throw new PolicyError('Conflict: file changed; read again before writing');
      const mode = old ? (await lstat(target)).mode & 0o777 : 0o644;
      const tmp = join(dirname(target), `.chat2local-edit-${randomUUID()}`);
      const h = await open(tmp, 'wx', 0o600);
      try {
        await h.writeFile(content, 'utf8'); await h.sync(); await h.close();
        await this.path(path, true);
        // Detect external edits before rename too. Same-user hostile races are out of scope.
        let latest: Buffer | undefined;
        try { latest = await this.buffer(path); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if ((latest ? sha256(latest) : 'absent') !== expected) throw new PolicyError('Conflict during write');
        if (signal?.aborted) throw new PolicyError('Write cancelled before commit');
        await chmod(tmp, mode); await rename(tmp, target);
      } catch (e) { await h.close().catch(() => {}); throw e; }
      finally { await unlink(tmp).catch(() => {}); }
      return { path, previous_sha256: expected, sha256: sha256(content), bytes: Buffer.byteLength(content) };
    });
  }

  async list(path = '.', recursive = false) {
    const base = await this.path(path);
    const entries: Array<{ path: string; type: 'file' | 'directory'; size: number }> = [];
    let examined = 0, omitted = 0, truncated = false;
    const walk = async (dir: string, depth: number) => {
      for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++examined > LIMITS.walkEntries) { truncated = true; return; }
        if (blockedName(item.name) || ['node_modules', 'dist', '.cache'].includes(item.name)) { omitted++; continue; }
        const p = join(dir, item.name);
        try {
          await this.path(p);
          const st = await lstat(p);
          entries.push({ path: relative(this.root, p).split(sep).join('/'), type: st.isDirectory() ? 'directory' : 'file', size: st.size });
          if (recursive && st.isDirectory() && depth < 20) await walk(p, depth + 1);
          else if (recursive && st.isDirectory()) truncated = true;
        } catch (e) { if (e instanceof PolicyError) omitted++; else throw e; }
        if (truncated && examined > LIMITS.walkEntries) return;
      }
    };
    await walk(base, 0);
    return { entries, omitted, truncated };
  }

  async snapshot(destination: string) {
    const listing = await this.list('.', true);
    if (listing.truncated) throw new PolicyError('Workspace too large for a bounded snapshot; select a smaller project');
    let bytes = 0, files = 0;
    await mkdir(destination, { recursive: true, mode: 0o755 });
    for (const entry of listing.entries) {
      if (entry.type !== 'file') continue;
      const data = await this.buffer(entry.path);
      if ((bytes += data.length) > LIMITS.snapshotBytes) throw new PolicyError('Snapshot exceeds 32 MiB');
      const target = join(destination, entry.path);
      await mkdir(dirname(target), { recursive: true });
      const h = await open(target, 'wx', 0o644);
      try { await h.writeFile(data); } finally { await h.close(); }
      files++;
    }
    return { files, bytes, omitted: listing.omitted };
  }
}

/** Bounded glob subset via dynamic programming, avoiding regex backtracking. */
export function globRegex(pattern: string): { test: (candidate: string) => boolean } {
  if (pattern.length > 500 || /[\[\]{}\\]/.test(pattern)) throw new PolicyError('Use glob patterns with *, ** and ? only');
  const tokens: Array<{ kind: 'literal' | 'star' | 'all' | 'dirs' | 'one'; value?: string }> = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { tokens.push({ kind: 'dirs' }); i++; }
      else tokens.push({ kind: 'all' });
    } else if (c === '*') tokens.push({ kind: 'star' });
    else if (c === '?') tokens.push({ kind: 'one' });
    else tokens.push({ kind: 'literal', value: c });
  }
  return { test(candidate) {
    if (candidate.length > 4096) return false;
    const n = candidate.length;
    let next = new Uint8Array(n + 1); next[n] = 1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i], current = new Uint8Array(n + 1);
      let slashReachable = false;
      for (let j = n; j >= 0; j--) {
        if (token.kind === 'dirs') {
          if (j < n && candidate[j] === '/' && next[j + 1]) slashReachable = true;
          current[j] = Number(Boolean(next[j]) || slashReachable);
        } else if (token.kind === 'all' || token.kind === 'star') {
          current[j] = Number(Boolean(next[j]) || (j < n && (token.kind === 'all' || candidate[j] !== '/') && Boolean(current[j + 1])));
        } else if (j < n && next[j + 1]) {
          current[j] = Number(token.kind === 'one' ? candidate[j] !== '/' : candidate[j] === token.value);
        }
      }
      next = current;
    }
    return next[0] === 1;
  } };
}
