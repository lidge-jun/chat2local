import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';

const enabled = process.env.CHAT2LOCAL_DOCKER_TESTS === '1';
async function fixture(t: any) {
  // tmpdir() is a symlink on macOS and the runtime requires a canonical state path.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-docker-')));
  const root = join(base, 'project'); await mkdir(root); await writeFile(join(root, 'a.ts'), 'original');
  await writeFile(join(root, '.env'), 'FAKE_FIXTURE_SECRET=must-not-copy');
  // Setting workerImage alone is no longer sufficient: the backend is selected
  // explicitly, so the fixture must request Docker rather than inherit 'none'.
  const runtime = await Runtime.create({ ...loadConfig({}), workspace: root, stateDir: join(base, 'state'),
    allowWrite: true, allowAside: false, sandboxBackend: 'docker',
    workerImage: process.env.CHAT2LOCAL_TEST_IMAGE || 'node:22-alpine' });
  t.after(async () => { await runtime.close(); await rm(base, { recursive: true, force: true }); });
  const open = await runtime.invoke('session_open', {}) as any;
  const session_id = open.session.id;
  const run = async (name: 'code_mode_read' | 'code_mode' | 'exec_command', input: object) => {
    const job = await runtime.invoke(name, { session_id, request_id: crypto.randomUUID(), ...input }) as any;
    let result;
    do { result = await runtime.invoke('job_get', { session_id, job_id: job.id, wait_ms: 1000 }) as any; } while (result.status === 'running');
    return result;
  };
  return { run, root, runtime, session_id };
}

test('Docker: real code-mode RPC batching, read-only denial and hash-checked writes', { skip: !enabled }, async t => {
  const { run, root } = await fixture(t);
  const read = await run('code_mode_read', { code: `const a = await tools.call('read_file', {path:'a.ts'}); return {content:a.content, unicode:'안녕 🌏'};` });
  assert.equal(read.status, 'succeeded', read.error); assert.equal(read.result.content, 'original'); assert.equal(read.result.unicode, '안녕 🌏');
  const denied = await run('code_mode_read', { code: `return await tools.call('write_file',{path:'a.ts',content:'bad',expected_sha256:'absent'});` });
  assert.equal(denied.status, 'failed'); assert.match(denied.error, /unavailable/);
  const edit = await run('code_mode', { code: `const a = await tools.call('read_file',{path:'a.ts'}); return await tools.call('write_file',{path:'a.ts',content:'updated',expected_sha256:a.sha256});` });
  assert.equal(edit.status, 'succeeded', edit.error); assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'updated');
});

test('Docker: shell gets a disposable filtered snapshot, not live files or host secrets', { skip: !enabled }, async t => {
  const { run, root } = await fixture(t);
  const result = await run('exec_command', { command: `test ! -e .env && test ! -e /var/run/docker.sock && printf changed > a.ts && cat a.ts` });
  assert.equal(result.status, 'succeeded', result.error); assert.equal(result.result.stdout, 'changed');
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'original');
  assert.equal(result.result.changes_applied_to_host, false);
});

test('Docker: runaway code times out and worker cannot route cross-session requests', { skip: !enabled }, async t => {
  const { run } = await fixture(t);
  const loop = await run('code_mode_read', { code: 'while(true){}', timeout: 1000 });
  assert.equal(loop.status, 'failed'); assert.match(loop.error, /timed out/);
  const cross = await run('code_mode_read', { code: `return await tools.call('read_file',{path:'a.ts',session_id:'anything'});` });
  assert.equal(cross.status, 'failed'); assert.match(cross.error, /identity/);
});
