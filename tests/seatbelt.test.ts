import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';

/**
 * Real macOS Seatbelt integration. Runs only when explicitly enabled, on darwin,
 * so a Linux CI job and an unprepared host both skip rather than fail.
 */
const enabled = process.env.CHAT2LOCAL_SEATBELT_TESTS === '1' && process.platform === 'darwin';

async function fixture(t: any) {
  // tmpdir() is a symlink on macOS and the runtime requires a canonical state path.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-seatbelt-')));
  const root = join(base, 'project'); await mkdir(root);
  await writeFile(join(root, 'a.ts'), 'original');
  await writeFile(join(root, '.env'), 'FAKE_FIXTURE_SECRET=must-not-copy');
  const runtime = await Runtime.create({
    ...loadConfig({ ...process.env, CHAT2LOCAL_SANDBOX: 'seatbelt' } as NodeJS.ProcessEnv, 'darwin'),
    workspace: root, stateDir: join(base, 'state'), allowWrite: true, allowAside: false,
  });
  t.after(async () => { await runtime.close(); await rm(base, { recursive: true, force: true }); });
  const open = await runtime.invoke('session_open', {}) as any;
  const session_id = open.session.id;
  const run = async (name: 'code_mode_read' | 'code_mode' | 'exec_command', input: object) => {
    const job = await runtime.invoke(name, { session_id, request_id: crypto.randomUUID(), ...input }) as any;
    let result;
    do { result = await runtime.invoke('job_get', { session_id, job_id: job.id, wait_ms: 1000 }) as any; } while (result.status === 'running');
    return result;
  };
  return { run, root, runtime, session_id, open };
}

test('Seatbelt: capabilities report the native backend without an image', { skip: !enabled }, async t => {
  const { open } = await fixture(t);
  assert.equal(open.sandbox_backend, 'seatbelt');
  assert.equal(open.code_mode_configured, true);
  assert.equal(open.worker_image, null);
  assert.equal(open.host_shell, false);
});

test('Seatbelt: real code-mode RPC batching, read-only denial and hash-checked writes', { skip: !enabled }, async t => {
  const { run, root } = await fixture(t);
  const read = await run('code_mode_read', { code: `const a = await tools.call('read_file', {path:'a.ts'}); return {content:a.content, unicode:'안녕 🌏'};` });
  assert.equal(read.status, 'succeeded', read.error);
  assert.equal(read.result.content, 'original');
  assert.equal(read.result.unicode, '안녕 🌏');
  const denied = await run('code_mode_read', { code: `return await tools.call('write_file',{path:'a.ts',content:'bad',expected_sha256:'absent'});` });
  assert.equal(denied.status, 'failed'); assert.match(denied.error, /unavailable/);
  const edit = await run('code_mode', { code: `const a = await tools.call('read_file',{path:'a.ts'}); return await tools.call('write_file',{path:'a.ts',content:'updated',expected_sha256:a.sha256});` });
  assert.equal(edit.status, 'succeeded', edit.error);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'updated');
});

test('Seatbelt: the code worker cannot reach the project or the operator home directory', { skip: !enabled }, async t => {
  const { run, root } = await fixture(t);
  // Code mode reads files only through broker RPC; direct filesystem access is denied
  // by the kernel because neither path is a readable root in the generated profile.
  const direct = await run('code_mode_read', {
    code: `const fs = await import('node:fs/promises');
           try { await fs.readFile(${JSON.stringify(join(root, 'a.ts'))}, 'utf8'); return 'READ_SUCCEEDED'; }
           catch (e) { return 'denied:' + e.code; }`,
  });
  assert.equal(direct.status, 'succeeded', direct.error);
  assert.match(direct.result, /^denied:/);

  const home = await run('code_mode_read', {
    code: `const fs = await import('node:fs/promises');
           try { await fs.readdir(${JSON.stringify(homedir())}); return 'LIST_SUCCEEDED'; }
           catch (e) { return 'denied:' + e.code; }`,
  });
  assert.equal(home.status, 'succeeded', home.error);
  assert.match(home.result, /^denied:/);
});

test('Seatbelt: the code worker has no network access', { skip: !enabled }, async t => {
  const { run } = await fixture(t);
  const result = await run('code_mode_read', {
    code: `try { const r = await fetch('http://127.0.0.1:1/'); return 'FETCH_SUCCEEDED:' + r.status; }
           catch (e) { return 'denied'; }`,
    timeout: 15000,
  });
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.result, 'denied');
});

test('Seatbelt: shell gets a disposable filtered snapshot, not live files or host secrets', { skip: !enabled }, async t => {
  const { run, root } = await fixture(t);
  const result = await run('exec_command', { command: `test ! -e .env && printf changed > a.ts && cat a.ts` });
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.result.stdout, 'changed');
  // The live project is never a writable mount and nothing is copied back.
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'original');
  assert.equal(result.result.changes_applied_to_host, false);
});

test('Seatbelt: a shell command cannot write outside its scratch directory', { skip: !enabled }, async t => {
  const { run, root } = await fixture(t);
  const target = join(root, 'escaped.txt');
  const result = await run('exec_command', { command: `printf escaped > ${JSON.stringify(target)} && echo WROTE || echo denied` });
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.result.stdout.trim(), 'denied');
  await assert.rejects(() => readFile(target, 'utf8'), /ENOENT/);
});

test('Seatbelt: runaway code times out and worker cannot route cross-session requests', { skip: !enabled }, async t => {
  const { run } = await fixture(t);
  const loop = await run('code_mode_read', { code: 'while(true){}', timeout: 1000 });
  assert.equal(loop.status, 'failed'); assert.match(loop.error, /timed out/);
  const cross = await run('code_mode_read', { code: `return await tools.call('read_file',{path:'a.ts',session_id:'anything'});` });
  assert.equal(cross.status, 'failed'); assert.match(cross.error, /identity/);
});
