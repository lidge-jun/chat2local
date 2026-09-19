import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/runtime.js';
import { Gate } from '../src/gate.js';
import { Workspace } from '../src/policy.js';
import { Store } from '../src/store.js';
import { loadConfig, LIMITS, type Config } from '../src/config.js';

const deferred = () => {
  let release!: () => void;
  return { release: () => release(), promise: new Promise<void>(resolve => { release = resolve; }) };
};
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 10));

test('the gate admits up to its limit, queues the rest first-come, and never exceeds it', async () => {
  const gate = new Gate(2);
  const holds = [deferred(), deferred(), deferred(), deferred()];
  const order: number[] = [];
  let active = 0, peak = 0;
  const runs = holds.map((hold, index) => gate.run(async () => {
    order.push(index); peak = Math.max(peak, ++active);
    await hold.promise; active--;
  }));
  await settle();
  assert.deepEqual(order, [0, 1], 'only the limit may start');
  holds[0].release();
  await settle();
  assert.deepEqual(order, [0, 1, 2], 'a freed slot goes to the longest waiter');
  for (const hold of holds) hold.release();
  await Promise.all(runs);
  await gate.drain();
  assert.equal(peak, 2);
  assert.deepEqual(gate.stats(), { limit: 2, active: 0, waiting: 0 });
});

test('a caller that aborts while queued gives up its place instead of holding a slot', async () => {
  const gate = new Gate(1);
  const hold = deferred();
  const running = gate.run(() => hold.promise);
  const controller = new AbortController();
  let started = false;
  const cancelled = gate.run(async () => { started = true; }, controller.signal);
  const behind = gate.run(async () => 'admitted');
  controller.abort();
  await assert.rejects(() => cancelled, /Cancelled while waiting/);
  assert.equal(started, false, 'an aborted waiter must never run its task');
  hold.release();
  assert.equal(await behind, 'admitted', 'the next waiter still gets the freed slot');
  await running;
  assert.deepEqual(gate.stats(), { limit: 1, active: 0, waiting: 0 });
});

test('an already-cancelled call never reaches the privileged task', async () => {
  const gate = new Gate(1);
  const controller = new AbortController(); controller.abort();
  let started = false;
  await assert.rejects(() => gate.run(async () => { started = true; }, controller.signal), /Cancelled while waiting/);
  assert.equal(started, false);
  assert.equal(gate.stats().active, 0);
});

test('an operator can restore strictly serial privileged execution, and a bad ceiling fails startup', () => {
  assert.equal(loadConfig({}).nativeConcurrency, LIMITS.nativeConcurrency);
  assert.equal(loadConfig({ CHAT2LOCAL_NATIVE_CONCURRENCY: '1' }).nativeConcurrency, 1);
  for (const value of ['0', '-1', '2.5', 'many', '', String(LIMITS.concurrency + 1)])
    assert.throws(() => loadConfig({ CHAT2LOCAL_NATIVE_CONCURRENCY: value }), /must be an integer from 1 to/);
});

/**
 * Neither adapter binary is ever the real CLI.
 *
 * Each stub records that it started and then waits a bounded time for its peer
 * to start too. Concurrent runs meet and print 'overlap'; a run that had to wait
 * its turn prints 'alone' after its own bound expires, so a regression fails on
 * a readable assertion instead of hanging the suite.
 */
function rendezvous(marks: string, peers: number): string {
  return [
    '#!/bin/sh',
    ': > "' + marks + '/$$"',
    'waited=0',
    'while [ "$(ls "' + marks + '" | wc -l)" -lt ' + peers + ' ] && [ "$waited" -lt 60 ]; do',
    '  sleep 0.1; waited=$((waited+1))',
    'done',
    'if [ "$(ls "' + marks + '" | wc -l)" -ge ' + peers + ' ]; then echo overlap; else echo alone; fi',
    '',
  ].join('\n');
}

interface JobView { id: string; status: string; error?: string; result?: { stdout: string } }

async function adapters(t: any, peers: number, overrides: Partial<Config> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-concurrency-')));
  const root = join(base, 'project');
  const marks = join(base, 'marks');
  await mkdir(root); await mkdir(marks);
  await writeFile(join(root, 'a.ts'), 'const answer = 42;\n');
  const aside = join(base, 'aside-stub.sh'), node = join(base, 'node-stub.sh');
  // The CodexClaw entry stays outside the workspace, as the runtime requires.
  const entry = join(base, 'codexclaw-entry.mjs');
  await writeFile(aside, rendezvous(marks, peers), { mode: 0o755 });
  await writeFile(node, rendezvous(marks, peers), { mode: 0o755 });
  await writeFile(entry, 'export {};\n');
  const runtime = await Runtime.create({ ...loadConfig({}), workspace: root, stateDir: join(base, 'state'),
    allowWrite: true, allowAside: true, asideBinary: aside, asideReapSessions: false,
    nodeBinary: node, codexclawEntry: entry, ...overrides });
  t.after(async () => { await runtime.close(); await rm(base, { recursive: true, force: true }); });
  const open = await runtime.invoke('session_open', {}) as { session: { id: string } };
  const session_id = open.session.id;
  const start = async (tool: 'aside_native' | 'codexclaw_native', request_id: string, args: string[]) =>
    (await runtime.invoke(tool, { session_id, request_id, args }) as JobView).id;
  const finish = (job_id: string) => runtime.invoke('job_get', { session_id, job_id, wait_ms: 10_000 }) as Promise<JobView>;
  return { start, finish };
}

test('a long Aside run does not stop the CodexClaw adapter from starting', async t => {
  const { start, finish } = await adapters(t, 2);
  const running = await start('aside_native', 'aside', ['exec', 'a long task']);
  const other = await start('codexclaw_native', 'codexclaw', ['--help']);
  const [asideJob, codexclawJob] = await Promise.all([finish(running), finish(other)]);
  assert.equal(asideJob.status, 'succeeded', asideJob.error);
  assert.equal(codexclawJob.status, 'succeeded', codexclawJob.error);
  assert.match(asideJob.result!.stdout, /overlap/);
  assert.match(codexclawJob.result!.stdout, /overlap/);
});

test('privileged calls dispatched together run together, not one after another', async t => {
  const { start, finish } = await adapters(t, 3);
  const ids = await Promise.all([
    start('aside_native', 'first', ['exec', 'one']),
    start('aside_native', 'second', ['exec', 'two']),
    start('aside_native', 'third', ['exec', 'three']),
  ]);
  for (const job of await Promise.all(ids.map(finish))) {
    assert.equal(job.status, 'succeeded', job.error);
    assert.match(job.result!.stdout, /overlap/);
  }
});

test('an operator can raise the job ceiling past the old four, and the jobs really overlap', async t => {
  const peers = 6;
  const { start, finish } = await adapters(t, peers, { maxActiveJobs: peers, nativeConcurrency: peers });
  const ids = await Promise.all(Array.from({ length: peers }, (_, i) => start('aside_native', `job-${i}`, ['exec', String(i)])));
  for (const job of await Promise.all(ids.map(finish))) {
    assert.equal(job.status, 'succeeded', job.error);
    assert.match(job.result!.stdout, /overlap/);
  }
});

test('session and job ceilings are operator-tunable and validated', () => {
  assert.equal(loadConfig({}).maxActiveJobs, LIMITS.activeJobs);
  assert.equal(loadConfig({}).maxSessions, LIMITS.sessions);
  assert.equal(loadConfig({ CHAT2LOCAL_MAX_ACTIVE_JOBS: '100' }).maxActiveJobs, 100);
  assert.equal(loadConfig({ CHAT2LOCAL_MAX_SESSIONS: '100' }).maxSessions, 100);
  assert.throws(() => loadConfig({ CHAT2LOCAL_MAX_ACTIVE_JOBS: String(LIMITS.activeJobsCeiling + 1) }), /must be an integer from 1 to/);
  assert.throws(() => loadConfig({ CHAT2LOCAL_MAX_SESSIONS: '0' }), /must be an integer from 1 to/);
});

test('a hundred sessions edit a hundred different files without taking turns', async t => {
  const total = 100;
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-hundred-')));
  const root = join(base, 'project'); await mkdir(root);
  await Promise.all(Array.from({ length: total }, (_, i) => writeFile(join(root, `f${i}.txt`), 'start')));
  const runtime = await Runtime.create({ ...loadConfig({}), workspace: root, stateDir: join(base, 'state'),
    allowWrite: true, allowAside: false });
  t.after(async () => { await runtime.close(); await rm(base, { recursive: true, force: true }); });
  const sessions: string[] = [];
  for (let i = 0; i < total; i++)
    sessions.push(((await runtime.invoke('session_open', { title: `session ${i}` })) as { session: { id: string } }).session.id);
  const read = await Promise.all(sessions.map((session_id, i) =>
    runtime.invoke('read_file', { session_id, path: `f${i}.txt` }) as Promise<{ sha256: string }>));
  await Promise.all(sessions.map((session_id, i) => runtime.invoke('write_file',
    { session_id, path: `f${i}.txt`, content: `edited by ${i}`, expected_sha256: read[i].sha256 })));
  for (let i = 0; i < total; i++) assert.equal(await readFile(join(root, `f${i}.txt`), 'utf8'), `edited by ${i}`);
  const listed = await runtime.invoke('session_list', {}) as { sessions: unknown[] };
  assert.equal(listed.sessions.length, total, 'no session may be evicted at this capacity');
  // Per-file keys, released on completion: the map tracks live writers, not history.
  assert.equal(Workspace.writeLocks(), 0);
});

test('concurrent writers to one file still take turns, and only one edit lands', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-onefile-')));
  const root = join(base, 'project'); await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(join(root, 'shared.txt'), 'start');
  const workspace = await Workspace.create(root, true);
  const before = await workspace.read('shared.txt');
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
    workspace.write('shared.txt', `edit ${i}`, before.sha256)));
  // This is the property per-file locking must not lose. Twelve writers holding
  // the same expected hash are twelve people editing the same line: exactly one
  // edit may land, and everyone else is told to read again rather than silently
  // overwriting the winner.
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  for (const loser of attempts.filter(a => a.status === 'rejected') as PromiseRejectedResult[])
    assert.match(loser.reason.message, /Conflict/);
  // The winner is the first caller, not whoever finished resolving its path
  // first: the lock is taken during the call, so issue order still decides.
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'edit 0');
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.chat2local-edit-')), []);
  assert.equal(Workspace.writeLocks(), 0);
});

test('different files take separate locks; one file is still one lock', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-onefile-')));
  const root = join(base, 'project'); await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  await Promise.all([writeFile(join(root, 'a.txt'), 'a'), writeFile(join(root, 'b.txt'), 'b')]);
  const workspace = await Workspace.create(root, true);
  const [a, b] = await Promise.all([workspace.read('a.txt'), workspace.read('b.txt')]);
  assert.equal(Workspace.writeLocks(), 0);
  // The lock is taken during the call, so this observation needs no timing
  // assumption: two keys means two independent writers, not a queue with a waiter.
  const separate = [workspace.write('a.txt', 'edited a', a.sha256), workspace.write('b.txt', 'edited b', b.sha256)];
  assert.equal(Workspace.writeLocks(), 2);
  await Promise.all(separate);
  assert.equal(Workspace.writeLocks(), 0);
  const refreshed = await workspace.read('a.txt');
  const shared = [workspace.write('a.txt', 'one', refreshed.sha256), workspace.write('a.txt', 'two', refreshed.sha256)];
  assert.equal(Workspace.writeLocks(), 1);
  const [first, second] = await Promise.allSettled(shared);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'one');
  assert.equal(Workspace.writeLocks(), 0);
});

test('the journal writes independent records at once and keeps per-record order', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-journal-')));
  const store = await Store.open(join(base, 'state'));
  t.after(async () => { await store.close(); await rm(base, { recursive: true, force: true }); });
  const record = (id: string, title: string) =>
    ({ id, project: '/tmp', title, created_at: '2026-01-01T00:00:00.000Z', checkpoint: '' });
  const ids = Array.from({ length: 100 }, () => randomUUID());
  await Promise.all(ids.map((id, i) => store.save('sessions', record(id, `title ${i}`))));
  const loaded = await store.list<{ id: string; title: string }>('sessions');
  assert.equal(loaded.length, 100);
  assert.deepEqual(new Set(loaded.map(r => r.title)), new Set(ids.map((_, i) => `title ${i}`)));
  // The one ordering the journal still owes: two writes to the same record land
  // in the order they were issued, because they share a chain and nothing else does.
  await Promise.all([store.save('sessions', record(ids[0], 'first')), store.save('sessions', record(ids[0], 'second'))]);
  assert.equal((await store.read<{ title: string }>('sessions', ids[0])).title, 'second');
});
