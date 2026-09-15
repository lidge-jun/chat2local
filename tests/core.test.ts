import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, sha256, globRegex, blockedName, within } from '../src/policy.js';
import { Store, type JobRecord } from '../src/store.js';
import { Jobs } from '../src/jobs.js';
import { loadConfig } from '../src/config.js';
import { runProcess, backendEnv } from '../src/process.js';
import { dockerArgs, Sandbox } from '../src/sandbox.js';
import { WORKER_SOURCE } from '../src/worker-source.js';

async function fixture(t: any, writable = false) {
  const base = await mkdtemp(join(tmpdir(), 'chat2local-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'); await mkdir(root);
  await writeFile(join(root, 'a.ts'), 'first line\nconst answer = 42;\n안녕 🌏\n');
  return { base, root, workspace: await Workspace.create(root, writable) };
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

test('operator config defaults are read-only and have no execution image', () => {
  const config = loadConfig({});
  assert.equal(config.allowWrite, false); assert.equal(config.allowAside, false); assert.equal(config.workerImage, undefined);
  assert.equal(loadConfig({ CHAT2LOCAL_ALLOW_WRITE: 'true' }).allowWrite, false);
  assert.equal(loadConfig({ CHAT2LOCAL_ALLOW_WRITE: '1' }).allowWrite, true);
});

test('bounded reads apply byte defaults and hash the full file', async t => {
  const { workspace, root } = await fixture(t);
  const actual = await workspace.read('a.ts');
  assert.match(actual.content, /answer/); assert.equal(actual.sha256, sha256(await readFile(join(root, 'a.ts'))));
  assert.equal((await workspace.read('a.ts', 6, 4)).content, 'line');
  assert.equal((await workspace.read('a.ts', 0, 2)).next_offset, 2);
});

test('traversal, sibling-prefix and sensitive paths are denied', async t => {
  const { workspace, root } = await fixture(t);
  for (const path of ['../elsewhere', `${root}-sibling/file`, '.git/config', '.env', '.ssh/id_rsa', 'auth.json', 'x\\..\\y'])
    await assert.rejects(() => workspace.read(path));
  assert.equal(within(root, `${root}-sibling`), false);
  for (const name of ['.env.production', 'PRIVATE.KEY', 'credentials.json', '.npmrc']) assert.equal(blockedName(name), true);
});

test('symlink and hardlink reads and writes fail closed', async t => {
  const { workspace, root, base } = await fixture(t, true);
  const outside = join(base, 'outside'); await writeFile(outside, 'secret');
  await symlink(outside, join(root, 'symlink')); await link(outside, join(root, 'hardlink'));
  for (const name of ['symlink', 'hardlink']) {
    await assert.rejects(() => workspace.read(name));
    await assert.rejects(() => workspace.write(name, 'overwrite', sha256('secret')));
  }
  assert.equal(await readFile(outside, 'utf8'), 'secret');
  const listing = await workspace.list('.', true);
  assert.equal(listing.omitted, 2); assert.equal(listing.entries.length, 1);
});

test('read-only workspace rejects writes even with a correct hash', async t => {
  const { workspace } = await fixture(t);
  await assert.rejects(() => workspace.write('a.ts', 'changed', 'absent'), /Writes disabled/);
});

test('compare-and-swap edits reject conflicts, serialize races and clean temp files', async t => {
  const { workspace, root } = await fixture(t, true);
  const before = await workspace.read('a.ts');
  const results = await Promise.allSettled([
    workspace.write('a.ts', 'first edit', before.sha256), workspace.write('a.ts', 'second edit', before.sha256),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'first edit');
  await workspace.write('new.ts', 'new file', 'absent');
  await assert.rejects(() => workspace.write('new.ts', 'clobber', 'absent'), /Conflict/);
  await assert.rejects(() => workspace.write('missing/new.ts', 'no', 'absent'));
  assert.equal((await readdir(root)).filter(n => n.startsWith('.chat2local-edit-')).length, 0);
});

test('recursive listing and snapshot omit sensitive files without following links', async t => {
  const { workspace, root, base } = await fixture(t);
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'b.ts'), 'safe');
  await writeFile(join(root, '.env'), 'SECRET=not-copied');
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'x'), 'no');
  assert.equal((await workspace.list('.', false)).entries.some(e => e.path === 'src/b.ts'), false);
  assert.equal((await workspace.list('.', true)).entries.some(e => e.path === 'src/b.ts'), true);
  const snapshot = join(base, 'snapshot'); const result = await workspace.snapshot(snapshot);
  assert.equal(result.files, 2); assert.equal(result.omitted, 2);
  await assert.rejects(() => readFile(join(snapshot, '.env')));
  await writeFile(join(snapshot, 'a.ts'), 'independent');
  assert.notEqual(await readFile(join(root, 'a.ts'), 'utf8'), 'independent');
});

test('glob semantics support root and nested files, escape regex syntax and reject unsupported syntax', () => {
  assert.equal(globRegex('**/x').test('ax'), false); assert.ok(globRegex('**/x').test('a/x'));
  assert.ok(globRegex('**/*.ts').test('a.ts')); assert.ok(globRegex('**/*.ts').test('src/a.ts'));
  assert.equal(globRegex('*.ts').test('src/a.ts'), false);
  assert.ok(globRegex('file?.ts').test('file1.ts')); assert.ok(globRegex('a(1).ts').test('a(1).ts'));
  assert.equal(globRegex('a.ts').test('ax ts'), false);
  assert.throws(() => globRegex('[abc]')); assert.throws(() => globRegex('{a,b}'));
});

test('store is private, rejects identifier traversal and excludes simultaneous writers', async t => {
  const { base } = await fixture(t);
  const path = join(base, 'state'), store = await Store.open(path); t.after(() => store.close());
  assert.equal((await lstat(path)).mode & 0o777, 0o700);
  await assert.rejects(() => Store.open(path), /in use/);
  await assert.rejects(() => store.read('jobs', '../outside'), /identifier/);
});

test('jobs reserve idempotency keys before effects and reject changed input', async t => {
  const { base } = await fixture(t); const store = await Store.open(join(base, 'state')); const jobs = new Jobs(store);
  t.after(async () => { await jobs.shutdown(); await store.close(); }); await jobs.init();
  let calls = 0; const task = async () => { calls++; await delay(10); return { ok: true }; };
  const [a, b] = await Promise.all([jobs.start('session', 'key', 'kind', { x: 1, y: 2 }, task), jobs.start('session', 'key', 'kind', { y: 2, x: 1 }, task)]);
  assert.equal(a.id, b.id); assert.equal(calls, 1);
  await assert.rejects(() => jobs.start('session', 'key', 'kind', { x: 2 }, task), /different input/);
  const terminal = await jobs.get('session', a.id, 0, 1000); assert.equal(terminal.status, 'succeeded');
  assert.deepEqual(terminal.result, { ok: true });
  await assert.rejects(() => jobs.get('other-session', a.id), /not found/);
});

test('job cancellation is terminal and cannot be overwritten by success', async t => {
  const { base } = await fixture(t); const store = await Store.open(join(base, 'state')); const jobs = new Jobs(store);
  t.after(async () => { await jobs.shutdown(); await store.close(); }); await jobs.init();
  const job = await jobs.start('s', 'cancel', 'test', {}, async ({ signal }) => {
    await new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true })); return 'partial';
  });
  const done = await jobs.cancel('s', job.id); assert.equal(done.status, 'cancelled');
});

test('restart marks unfinished jobs interrupted and does not replay the same key', async t => {
  const { base } = await fixture(t); const path = join(base, 'state'); let store = await Store.open(path);
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const record: JobRecord = { id, session_id: 's', key: 'key', fingerprint: sha256('{"input":{},"kind":"test"}'), kind: 'test', status: 'running', created_at: 'now', events: [], dropped_events: 0 };
  await store.save('jobs', record); await store.close(); store = await Store.open(path);
  const jobs = new Jobs(store); t.after(async () => { await jobs.shutdown(); await store.close(); }); await jobs.init();
  assert.equal((await jobs.get('s', id)).status, 'interrupted');
  const resumed = await jobs.start('s', 'key', 'test', {}, async () => { throw new Error('MUST NOT RUN'); });
  assert.equal(resumed.status, 'interrupted');
});

test('job events are bounded and cursor-paged', async t => {
  const { base } = await fixture(t); const store = await Store.open(join(base, 'state')); const jobs = new Jobs(store);
  t.after(async () => { await jobs.shutdown(); await store.close(); }); await jobs.init();
  const job = await jobs.start('s', 'logs', 'test', {}, async ({ log }) => { for (let i = 0; i < 150; i++) log(String(i)); return null; });
  const first = await jobs.get('s', job.id, 0, 1000); assert.equal(first.events.length, 50); assert.equal(first.next_cursor, 50);
  const second = await jobs.get('s', job.id, first.next_cursor); assert.equal(second.events[0].text, '50'); assert.equal(second.dropped_events, 50);
});

test('process exit status distinguishes failure, timeout and cancellation', async () => {
  const error = await runProcess(process.execPath, ['-e', 'console.error("problem");process.exit(7)'], { timeout: 2000, env: {} });
  assert.equal(error.exit_code, 7); assert.match(error.stderr, /problem/);
  const timed = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 50, env: {} });
  assert.equal(timed.timed_out, true); assert.notEqual(timed.exit_code, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => runProcess(process.execPath, ['-e', 'process.exit(0)'], { timeout: 100, signal: controller.signal }), /Cancelled/);
});

test('process output limit is enforced', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024))'], { timeout: 2000, env: {} });
  assert.equal(result.output_limited, true);
});

test('backend environment never forwards API keys or node injection variables', () => {
  assert.equal(backendEnv().OPENAI_API_KEY, undefined); assert.equal(backendEnv().CONTROL_PLANE_API_KEY, undefined);
  assert.equal(backendEnv(true).NODE_OPTIONS, undefined);
});

test('Docker arguments do not expose host capabilities, secrets or mounts', () => {
  const args = dockerArgs('test', 'node:22-alpine');
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never', '--user=65534:65534']) assert.ok(args.includes(flag));
  for (const flag of ['--privileged', '--pid=host', '--network=host', '--mount', '-v']) assert.equal(args.includes(flag), false);
});

test('sandbox fails closed when the operator has not configured an image', async () => {
  const sandbox = new Sandbox(loadConfig({}));
  await assert.rejects(() => sandbox.code('return 42', 1000, { signal: new AbortController().signal, log() {} }, async () => null), /No host fallback/);
});

test('worker program maps in order and returns values (test-only isolated Node process)', async () => {
  // This test executes only this fixed fixture in a disposable CI/assistant environment, never a connected host.
  const program = 'return await tools.map([3,1,2], async x => x * 2, 2)';
  const result = await runProcess(process.execPath, ['--input-type=module', '--eval', WORKER_SOURCE], {
    timeout: 2000, input: JSON.stringify({ type: 'run', code: program }) + '\n', keepStdin: true, env: {},
  });
  assert.equal(result.exit_code, 0); assert.deepEqual(JSON.parse(result.stdout).result, [6,2,4]);
});


test('separate sessions cannot both commit an edit based on the same hash', async t => {
  const { workspace, root } = await fixture(t, true);
  const another = await Workspace.create(root, true);
  const before = await workspace.read('a.ts');
  const outcomes = await Promise.allSettled([
    workspace.write('a.ts', 'session one', before.sha256),
    another.write('a.ts', 'session two', before.sha256),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
});
