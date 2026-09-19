import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime.js';
import { Gate } from '../src/gate.js';
import { loadConfig, LIMITS } from '../src/config.js';

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

async function adapters(t: any, peers: number) {
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
    nodeBinary: node, codexclawEntry: entry });
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
