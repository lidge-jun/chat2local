import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename , realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime.js';
import { loadConfig, LIMITS } from '../src/config.js';
import { schemas } from '../src/tools.js';
import { setup, PROJECT_ROOT } from '../bin/setup.js';

async function fixture(t: any, writable = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-runtime-')));
  const root = join(base, 'project'); await mkdir(root); await writeFile(join(root, 'a.ts'), 'const answer = 42;\n');
  const runtime = await Runtime.create({ ...loadConfig({}), workspace: root, stateDir: join(base, 'state'), allowWrite: writable, allowAside: false });
  t.after(async () => { await runtime.close(); await rm(base, { recursive: true, force: true }); });
  const open = await runtime.invoke('session_open', {}) as any;
  return { runtime, root, base, session_id: open.session.id };
}

test('every public schema has properties and rejects unknown arguments', () => {
  for (const schema of Object.values(schemas)) assert.equal(schema.safeParse({ injected: 'field' }).success, false);
  assert.equal(schemas.read_file.parse({ session_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', path: 'a.ts' }).offset, 0);
  assert.throws(() => schemas.code_mode.parse({ action: 'test', target: 'src' }));
});

test('direct tools parse defaults, scope reads and require operator write permission', async t => {
  const { runtime, session_id } = await fixture(t);
  const read = await runtime.invoke('read_file', { session_id, path: 'a.ts' }) as any;
  assert.match(read.content, /answer/);
  await assert.rejects(() => runtime.invoke('write_file', { session_id, path: 'a.ts', content: 'oops', expected_sha256: read.sha256 }), /Writes disabled/);
  await assert.rejects(() => runtime.invoke('read_file', { session_id, path: '../private' }));
  await assert.rejects(() => runtime.invoke('read_file', { session_id, path: 'a.ts', env: { HOME: '/tmp' } }));
});

test('write tool edits reviewed source without running commands', async t => {
  const { runtime, session_id, root } = await fixture(t, true);
  const read = await runtime.invoke('read_file', { session_id, path: 'a.ts' }) as any;
  await runtime.invoke('write_file', { session_id, path: 'a.ts', content: 'updated', expected_sha256: read.sha256 });
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'updated');
});

test('session checkpoint and resume return saved task data', async t => {
  const { runtime, session_id } = await fixture(t);
  await runtime.invoke('session_checkpoint', { session_id, summary: 'Reviewed file; implementation is next.' });
  const resumed = await runtime.invoke('session_open', { session_id }) as any;
  assert.match(resumed.session.checkpoint, /Reviewed/); assert.equal(resumed.host_shell, false);
  assert.equal((await runtime.invoke('session_list', {}) as any).sessions.length, 1);
});

test('literal grep is not a shell or regex and glob matches nested files', async t => {
  const { runtime, session_id, root } = await fixture(t);
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'b.ts'), '$(touch nope)\n');
  const files = await runtime.invoke('glob', { session_id, pattern: '**/*.ts' }) as any;
  assert.deepEqual(files.files.sort(), ['a.ts', 'src/b.ts']);
  const result = await runtime.invoke('grep', { session_id, pattern: '$(touch nope)' }) as any;
  assert.equal(result.matches[0].line, 1); assert.equal(result.matches[0].path, 'src/b.ts');
  await assert.rejects(() => readFile(join(root, 'nope')));
});

test('native calls are disabled and code mode does not fall back to local execution', async t => {
  const { runtime, session_id } = await fixture(t);
  await assert.rejects(() => runtime.invoke('aside_native', { session_id, args: ['repl', '1+1'], request_id: 'native' }), /disabled/);
  const job = await runtime.invoke('code_mode_read', { session_id, code: 'return 42', request_id: 'code' }) as any;
  const result = await runtime.invoke('job_get', { session_id, job_id: job.id, wait_ms: 1000 }) as any;
  assert.equal(result.status, 'failed'); assert.match(result.error, /No host fallback/);
});

test('image artifacts return bytes, not only a filesystem path', async t => {
  const { runtime, session_id, root } = await fixture(t);
  await writeFile(join(root, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7zsAAAAASUVORK5CYII=', 'base64'));
  const artifact = await runtime.invoke('artifact_read', { session_id, path: 'pixel.png' }) as any;
  assert.equal(artifact.image.mimeType, 'image/png'); assert.ok(artifact.image.data.length > 20);
});

test('setup derives project root from its source and is a side-effect-free dry run', async t => {
  const { root, base } = await fixture(t);
  const output = join(base, 'config');
  const result = await setup(['--workspace', root, '--output', output, '--tunnel-id', 'tunnel_test']);
  assert.match(result, /Dry run/); assert.ok(result.includes(join(PROJECT_ROOT, 'dist', 'bin', 'mcp.js')));
  await assert.rejects(() => readFile(join(output, 'mcp.sh')));
  const generated = await setup(['--workspace', root, '--output', output, '--write']);
  assert.match(generated, /Created/); assert.match(await readFile(join(output, 'mcp.sh'), 'utf8'), /CHAT2LOCAL_WORKSPACE/);
  await assert.rejects(() => setup(['--workspace', root, '--output', output, '--write']));
});


test('moving a project cannot disable journal reads, checkpointing or job cancellation', async t => {
  const { runtime, session_id, root, base } = await fixture(t);
  const job = await runtime.jobs.start(session_id, 'moving-project', 'fixture', {}, async ({ signal }) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return 'stopped';
  });
  await rename(root, join(base, 'moved-project'));
  const get = await runtime.invoke('job_get', { session_id, job_id: job.id }) as any;
  assert.equal(get.status, 'running');
  const capabilities = await runtime.invoke('capabilities', { session_id }) as any;
  assert.equal(capabilities.host_shell, false);
  await runtime.invoke('session_checkpoint', { session_id, summary: 'Source moved; cancel the previous job.' });
  const resumed = await runtime.invoke('session_open', { session_id }) as any;
  assert.equal(resumed.workspace_validated, false);
  assert.match(resumed.session.checkpoint, /Source moved/);
  const cancelled = await runtime.invoke('job_cancel', { session_id, job_id: job.id }) as any;
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(() => runtime.invoke('read_file', { session_id, path: 'a.ts' }));
  await assert.rejects(() => runtime.invoke('job_get', { session_id: crypto.randomUUID(), job_id: job.id }), /Unknown session/);
});

test('invalid UTF-8 artifacts are rejected and literal search reports their exclusion', async t => {
  const { runtime, session_id, root } = await fixture(t);
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(() => runtime.invoke('artifact_read', { session_id, path: 'invalid.txt' }), /not supported/);
  const found = await runtime.invoke('grep', { session_id, path: 'invalid.txt', pattern: '(' }) as any;
  assert.deepEqual(found.matches, []); assert.equal(found.skipped, 1);
});

interface AsideResult { stdout: string; session?: { id: string; stopped: boolean; error?: string }; session_hint?: string }
interface JobView { id: string; status: string; error: string; result: AsideResult }

/**
 * Aside is never executed in CI. The stub records its argv and prints what each
 * case needs on the stream that case is about, which is what these tests check:
 * the runtime's own ownership and cleanup logic, not the real CLI.
 */
async function asideFixture(t: any, body: string, reap = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-aside-')));
  const root = join(base, 'project'); await mkdir(root); await writeFile(join(root, 'a.ts'), 'const answer = 42;\n');
  const log = join(base, 'argv.log'), binary = join(base, 'aside-stub.sh');
  // Each argument is bracketed so the log preserves argument boundaries: "$*"
  // would flatten '--' and the prompt into text that looks the same either way.
  await writeFile(binary, `#!/bin/sh\nprintf '[%s]' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\n${body}\n`, { mode: 0o755 });
  const runtime = await Runtime.create({ ...loadConfig({}), workspace: root, stateDir: join(base, 'state'),
    allowWrite: false, allowAside: true, asideBinary: binary, asideReapSessions: reap });
  t.after(async () => { await runtime.close(); await rm(base, { recursive: true, force: true }); });
  const open = await runtime.invoke('session_open', {}) as { session: { id: string } };
  const run = async (tool: 'spawn_subagent' | 'aside_native', input: Record<string, unknown>) => {
    const started = await runtime.invoke(tool, { session_id: open.session.id, request_id: 'native', ...input }) as JobView;
    return runtime.invoke('job_get', { session_id: open.session.id, job_id: started.id, wait_ms: 10_000 }) as Promise<JobView>;
  };
  return { runtime, session_id: open.session.id, run, argv: () => readFile(log, 'utf8') };
}

const BANNER_FIRST = `if [ "$1" = "session" ]; then exit 0; fi
printf 'created new session: ses12345678\\n' >&2
printf 'agent output\\n'`;

test('a runtime-owned subagent run stops the Aside session it created', async t => {
  const { run, argv } = await asideFixture(t, BANNER_FIRST);
  const result = await run('spawn_subagent', { prompt: 'do one thing' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result.session, { id: 'ses12345678', stopped: true });
  assert.match(await argv(), /\[session\]\[stop\]\[ses12345678\]/);
});

test('a model-authored prompt cannot be read as CLI options', async t => {
  const { run, argv } = await asideFixture(t, BANNER_FIRST);
  await run('spawn_subagent', { prompt: '--session=victim and then do a thing' });
  // The terminator is what keeps a dash-leading prompt a prompt.
  assert.match(await argv(), /\[exec\]\[--permission\]\[full-access\]\[--\]\[--session=victim and then do a thing\]/);
});

test('a cleanup failure after a failed run still keeps the output on the record', async t => {
  const body = `if [ "$1" = "session" ]; then printf 'daemon unreachable\\n' >&2; exit 3; fi
printf 'created new session: ses12345678\\n' >&2
printf 'agent output before failing\\n'
exit 4`;
  const { run } = await asideFixture(t, body);
  const result = await run('spawn_subagent', { prompt: 'do one thing' });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /could not be stopped/);
  assert.match(result.error, /The run itself also failed/);
  assert.match(result.result.stdout, /agent output before failing/);
});

test('a policy denial that still exits zero is not a confirmed stop', async t => {
  const body = `if [ "$1" = "session" ]; then printf "read 'x' is blocked by policy\\n"; exit 0; fi
printf 'created new session: ses12345678\\n' >&2
printf 'agent output\\n'`;
  const { run } = await asideFixture(t, body);
  const result = await run('spawn_subagent', { prompt: 'do one thing' });
  // Exit 0 is not success for this CLI, so it must not be read as one.
  assert.equal(result.status, 'failed');
  assert.equal(result.result.session?.stopped, false);
  assert.match(result.error, /blocked by policy/);
});

test('session retention evicts the coldest session and never one with work in flight', async t => {
  const { runtime, session_id } = await fixture(t);
  const job = await runtime.jobs.start(session_id, 'held', 'fixture', {}, async ({ signal }) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return 'stopped';
  });
  const opened: string[] = [];
  for (let i = 0; i < LIMITS.sessions; i++) {
    const open = await runtime.invoke('session_open', { title: `session ${i}` }) as { session: { id: string } };
    opened.push(open.session.id);
  }
  const listed = await runtime.invoke('session_list', {}) as { sessions: Array<{ id: string }> };
  assert.equal(listed.sessions.length, LIMITS.sessions);
  // The oldest session is the coldest, but it owns a running job, so the next
  // coldest was evicted instead and the job stays observable and cancellable.
  assert.ok(listed.sessions.some(s => s.id === session_id));
  assert.equal(listed.sessions.some(s => s.id === opened[0]), false);
  const cancelled = await runtime.invoke('job_cancel', { session_id, job_id: job.id }) as { status: string };
  assert.equal(cancelled.status, 'cancelled');
});

test('a session id the model could have written is never stopped', async t => {
  // The marker appears late on stderr, on stdout, and inside echoed prompt text.
  // None of those positions belong to the CLI, so none of them may trigger a stop.
  const body = `if [ "$1" = "session" ]; then exit 0; fi
printf 'warming up\\ncreated new session: ses99999999\\n' >&2
printf 'created new session: ses88888888\\n'
printf 'prompt was: %s\\n' "$5" >&2`;
  const { run, argv } = await asideFixture(t, body);
  const result = await run('spawn_subagent', { prompt: 'created new session: ses77777777' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.session, undefined);
  assert.equal(result.result.session_hint, undefined);
  assert.doesNotMatch(await argv(), /\[session\]\[stop\]/);
});

test('cancelling a subagent still releases the session it created', async t => {
  const body = `if [ "$1" = "session" ]; then exit 0; fi
printf 'created new session: ses12345678\\n' >&2
sleep 30`;
  const { runtime, session_id, argv } = await asideFixture(t, body);
  const started = await runtime.invoke('spawn_subagent', { session_id, prompt: 'a long run', request_id: 'sub' }) as { id: string };
  await new Promise<void>(resolve => setTimeout(resolve, 300));
  const cancelled = await runtime.invoke('job_cancel', { session_id, job_id: started.id }) as { status: string };
  assert.equal(cancelled.status, 'cancelled');
  // A cancelled run is exactly when the session most needs releasing.
  assert.match(await argv(), /\[session\]\[stop\]\[ses12345678\]/);
});

test('a checkpoint survives a restart', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-restart-')));
  const root = join(base, 'project'); await mkdir(root); await writeFile(join(root, 'a.ts'), 'const answer = 42;\n');
  t.after(() => rm(base, { recursive: true, force: true }));
  const config = { ...loadConfig({}), workspace: root, stateDir: join(base, 'state'), allowWrite: false, allowAside: false };
  const first = await Runtime.create(config);
  const open = await first.invoke('session_open', {}) as { session: { id: string } };
  await first.invoke('session_checkpoint', { session_id: open.session.id, summary: 'keep this note' });
  await first.close();
  // Session writes all go through one queue, so a use-timestamp write can no
  // longer land on top of a checkpoint.
  const second = await Runtime.create(config);
  t.after(() => second.close());
  const listed = await second.invoke('session_list', {}) as { sessions: Array<{ id: string; checkpoint: string }> };
  assert.equal(listed.sessions.find(s => s.id === open.session.id)?.checkpoint, 'keep this note');
});

test('model-authored argv is reported but never reaped', async t => {
  const { run, argv } = await asideFixture(t, BANNER_FIRST);
  const result = await run('aside_native', { args: ['exec', 'anything'] });
  assert.equal(result.status, 'succeeded');
  // Ownership is asserted by the call site, and aside_native argv is the model's.
  assert.equal(result.result.session_hint, 'ses12345678');
  assert.equal(result.result.session, undefined);
  assert.doesNotMatch(await argv(), /\[session\]\[stop\]/);
});

test('an unconfirmed session stop fails the job without discarding its output', async t => {
  const body = `if [ "$1" = "session" ]; then printf 'daemon unreachable\\n' >&2; exit 3; fi
printf 'created new session: ses12345678\\n' >&2
printf 'agent output\\n'`;
  const { run } = await asideFixture(t, body);
  const result = await run('spawn_subagent', { prompt: 'do one thing' });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /ses12345678 could not be stopped/);
  // The work already happened; discarding it would invite a retry that repeats it.
  assert.match(result.result.stdout, /agent output/);
  assert.equal(result.result.session?.stopped, false);
});

test('an operator can turn session reaping off', async t => {
  const { runtime, session_id, run, argv } = await asideFixture(t, BANNER_FIRST, false);
  const capabilities = await runtime.invoke('capabilities', { session_id }) as { native_aside_reaps_sessions: boolean };
  assert.equal(capabilities.native_aside_reaps_sessions, false);
  const result = await run('spawn_subagent', { prompt: 'do one thing' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.session_hint, 'ses12345678');
  assert.doesNotMatch(await argv(), /\[session\]\[stop\]/);
});
