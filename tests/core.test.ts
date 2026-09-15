import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, readdir, lstat, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, sha256, globRegex, blockedName, within } from '../src/policy.js';
import { Store, type JobRecord } from '../src/store.js';
import { Jobs } from '../src/jobs.js';
import { loadConfig } from '../src/config.js';
import { runProcess, backendEnv } from '../src/process.js';
import { dockerArgs, Sandbox } from '../src/sandbox.js';
import { buildSeatbeltProfile, seatbeltArgs, SEATBELT_EXECUTABLE } from '../src/seatbelt-policy.js';
import { realpathSync } from 'node:fs';
import { WORKER_SOURCE } from '../src/worker-source.js';

async function fixture(t: any, writable = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'); await mkdir(root);
  await writeFile(join(root, 'a.ts'), 'first line\nconst answer = 42;\n안녕 🌏\n');
  return { base, root, workspace: await Workspace.create(root, writable) };
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

test('personal defaults enable writes and native Aside without enabling unsandboxed code execution', () => {
  const config = loadConfig({}, 'linux');
  assert.equal(config.allowWrite, true); assert.equal(config.allowAside, true);
  assert.equal(config.asidePermission, 'full-access'); assert.equal(config.workerImage, undefined);
  // Without an image, a non-macOS host has no execution backend at all.
  assert.equal(config.sandboxBackend, 'none');
});

test('explicit operator restrictions override personal defaults', () => {
  const config = loadConfig({ CHAT2LOCAL_ALLOW_WRITE: '0', CHAT2LOCAL_ALLOW_ASIDE: '0', CHAT2LOCAL_ASIDE_PERMISSION: 'guard' });
  assert.equal(config.allowWrite, false); assert.equal(config.allowAside, false); assert.equal(config.asidePermission, 'guard');
  assert.equal(loadConfig({ CHAT2LOCAL_ALLOW_WRITE: '1' }).allowWrite, true);
  assert.equal(loadConfig({ CHAT2LOCAL_ALLOW_ASIDE: '1' }).allowAside, true);
});

test('ambiguous permissions fail startup instead of silently escalating privileges', () => {
  for (const key of ['CHAT2LOCAL_ALLOW_WRITE', 'CHAT2LOCAL_ALLOW_ASIDE']) {
    for (const value of ['', 'true', 'false', 'yes', 'no', '2'])
      assert.throws(() => loadConfig({ [key]: value }), /must be 0 or 1/);
  }
  assert.throws(() => loadConfig({ CHAT2LOCAL_ASIDE_PERMISSION: 'ask' }), /must be guard or full-access/);
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

test('sandbox fails closed when no backend is available on the platform', async () => {
  const sandbox = new Sandbox(loadConfig({}, 'linux'));
  await assert.rejects(() => sandbox.code('return 42', 1000, { signal: new AbortController().signal, log() {} }, async () => null), /No host fallback/);
});

test('backend selection prefers the platform sandbox and never invents one', () => {
  // The interpreter is resolved from PATH, so a realistic PATH is part of the input.
  const withNode = { PATH: process.env.PATH };
  // macOS needs no installation: Seatbelt ships with the OS.
  assert.equal(loadConfig(withNode, 'darwin').sandboxBackend, 'seatbelt');
  // Other platforms require an explicitly provisioned image.
  assert.equal(loadConfig(withNode, 'linux').sandboxBackend, 'none');
  assert.equal(loadConfig({ ...withNode, CHAT2LOCAL_WORKER_IMAGE: 'node:22-alpine' }, 'linux').sandboxBackend, 'docker');
  // With no interpreter at all, macOS has no usable backend and must not claim one.
  assert.equal(loadConfig({ PATH: '' }, 'darwin').sandboxBackend, 'none');
  // An explicit operator choice always wins over auto-selection.
  assert.equal(loadConfig({ ...withNode, CHAT2LOCAL_SANDBOX: 'docker', CHAT2LOCAL_WORKER_IMAGE: 'node:22-alpine' }, 'darwin').sandboxBackend, 'docker');
  assert.equal(loadConfig({ ...withNode, CHAT2LOCAL_SANDBOX: 'none' }, 'darwin').sandboxBackend, 'none');
  assert.throws(() => loadConfig({ ...withNode, CHAT2LOCAL_SANDBOX: 'seatbelt' }, 'linux'), /requires macOS/);
  assert.throws(() => loadConfig({ ...withNode, CHAT2LOCAL_SANDBOX: 'vm' }, 'darwin'), /must be seatbelt, docker or none/);
});

test('CodexClaw entry must live outside the workspace, because write_file can rewrite it', async t => {
  // Demonstrated escalation, not a hypothetical: codexclaw_native executes this
  // file on the host outside the sandbox, while write_file can edit anything in
  // the workspace. An in-workspace entry therefore upgrades a scoped file write
  // into arbitrary host code execution.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-cxc-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, 'workspace');
  const inside = join(workspace, 'codexclaw', 'bin', 'codexclaw.mjs');
  const outside = join(base, 'external', 'codexclaw.mjs');
  await mkdir(join(workspace, 'codexclaw', 'bin'), { recursive: true });
  await mkdir(join(base, 'external'), { recursive: true });
  await writeFile(inside, 'console.log(1);');
  await writeFile(outside, 'console.log(1);');

  assert.throws(() => loadConfig({ PATH: process.env.PATH, CHAT2LOCAL_WORKSPACE: workspace,
    CHAT2LOCAL_CODEXCLAW_ENTRY: inside }, 'darwin'), /outside the writable workspace/);

  // An external entry is accepted.
  assert.equal(loadConfig({ PATH: process.env.PATH, CHAT2LOCAL_WORKSPACE: workspace,
    CHAT2LOCAL_CODEXCLAW_ENTRY: outside }, 'darwin').codexclawEntry, await realpath(outside));

  // A symlink placed in the workspace must not smuggle an "external" target past
  // the check, and an external symlink must resolve to its real location.
  const link = join(workspace, 'link.mjs');
  await symlink(outside, link);
  assert.throws(() => loadConfig({ PATH: process.env.PATH, CHAT2LOCAL_WORKSPACE: workspace,
    CHAT2LOCAL_CODEXCLAW_ENTRY: link }, 'darwin'), /outside the writable workspace/);
});

test('CodexClaw adapter stays disabled unless the operator names an entry', () => {
  // There is no auto-discovery: a discovered path is exactly the path an attacker
  // can create inside a directory the model can already write to.
  const config = loadConfig({ PATH: process.env.PATH }, 'darwin');
  assert.equal(config.codexclawEntry, undefined);
  assert.throws(() => loadConfig({ PATH: process.env.PATH,
    CHAT2LOCAL_CODEXCLAW_ENTRY: '/nonexistent/codexclaw.mjs' }, 'darwin'), /not readable/);
});

test('Seatbelt profile denies by default, scopes writes and never opts into the network', () => {
  const { policy, params } = buildSeatbeltProfile({ readableRoots: ['/tmp/read'], writableRoots: ['/tmp/write'] });
  assert.match(policy, /^\(version 1\)/);
  assert.match(policy, /\(deny default\)/);
  // Network stays denied by omission: no allow rule may appear anywhere.
  assert.equal(/\(allow network-outbound/.test(policy), false);
  assert.equal(/\(allow network-inbound/.test(policy), false);
  assert.equal(/\(allow network-bind/.test(policy), false);
  // Paths are passed as parameters, never interpolated into policy text.
  assert.equal(policy.includes('/tmp/write'), false);
  assert.match(policy, /\(allow file-write\*\n {2}\(subpath \(param "CHAT2LOCAL_WRITABLE_ROOT_0"\)\)\)/);
  // Values are the RESOLVED paths; on macOS /tmp resolves to /private/tmp.
  assert.deepEqual(params.map(([key]) => key), ['CHAT2LOCAL_READABLE_ROOT_0', 'CHAT2LOCAL_WRITABLE_ROOT_0']);
  assert.deepEqual(params.map(([, value]) => value), [realpathSync.native('/tmp') + '/read', realpathSync.native('/tmp') + '/write']);
  // The sandbox must not be able to unlink the root anchoring its own policy.
  assert.match(policy, /deny file-write-unlink[\s\S]*CHAT2LOCAL_WRITABLE_ROOT_0/);
});

test('Seatbelt argv uses the absolute system binary and rejects unquotable roots', () => {
  assert.equal(SEATBELT_EXECUTABLE, '/usr/bin/sandbox-exec');
  const args = seatbeltArgs('(version 1)', [['ROOT', '/tmp/x']], ['/bin/sh', '-c', 'echo hi']);
  assert.deepEqual(args, ['-p', '(version 1)', '-DROOT=/tmp/x', '--', '/bin/sh', '-c', 'echo hi']);
  // -D has no escape syntax, so a newline must fail loudly rather than truncate the policy.
  assert.throws(() => seatbeltArgs('(version 1)', [['ROOT', '/tmp/a\nb']], ['/bin/sh']), /unsupported character/);
});

test('Seatbelt profile keeps the three rules a live probe proved are load-bearing', () => {
  // Each assertion here corresponds to a concrete observed failure, not a guess.
  const { policy } = buildSeatbeltProfile({ readableRoots: ['/tmp/read'], writableRoots: ['/tmp/write'] });
  // 1. Without OpenSSL config access, node aborts during startup with a BIO_new_file error.
  assert.match(policy, /\(subpath "\/System\/Library\/OpenSSL"\)/);
  // 2. Readable is not sufficient to execute: the loader needs file-map-executable
  //    for system binaries and for the interpreter's own root.
  assert.match(policy, /\(allow file-map-executable[\s\S]*\(subpath "\/usr\/bin"\)/);
  assert.match(policy, /\(allow file-map-executable\n {2}\(subpath \(param "CHAT2LOCAL_READABLE_ROOT_0"\)\)\)/);
});

test('Seatbelt roots are resolved, because /tmp and /var are symlinks on macOS', { skip: process.platform !== 'darwin' }, () => {
  // Seatbelt matches the resolved path, so an unresolved /tmp root silently
  // matches nothing and every access inside it is denied.
  const { params } = buildSeatbeltProfile({ readableRoots: [], writableRoots: ['/tmp'] });
  assert.deepEqual(params, [['CHAT2LOCAL_WRITABLE_ROOT_0', '/private/tmp']]);
  // A path that does not exist yet still resolves through its parent.
  const pending = buildSeatbeltProfile({ readableRoots: [], writableRoots: ['/tmp/not-created-yet'] });
  assert.deepEqual(pending.params, [['CHAT2LOCAL_WRITABLE_ROOT_0', '/private/tmp/not-created-yet']]);
});

test('Seatbelt worker launch fixes cwd and sets no process-count rlimit', { skip: process.platform !== 'darwin' }, () => {
  const config = { ...loadConfig({ PATH: process.env.PATH }, 'darwin'), sandboxBackend: 'seatbelt' as const, nodeBinary: '/usr/local/bin/node' };
  const prelude = new Sandbox(config).codeLaunch('/tmp/scratch').args.find(a => a.includes('ulimit'));
  assert.ok(prelude, 'expected an rlimit prelude');
  // node calls process.cwd() while bootstrapping --input-type=module; inheriting an
  // unreadable cwd aborts the worker with EPERM before user code runs.
  assert.match(prelude!, /cd '\/tmp\/scratch'/);
  assert.match(prelude!, /PWD='\/tmp\/scratch'/);
  // ulimit -u counts processes per UID on macOS, not per tree: a small value fails
  // immediately on a normal desktop session and a safe value bounds nothing.
  assert.equal(/ulimit -u/.test(prelude!), false);
  assert.match(prelude!, /ulimit -n /);
});

test('Seatbelt code worker gets a scratch-only writable root and no project access', { skip: process.platform !== 'darwin' }, () => {
  const config = { ...loadConfig({ PATH: process.env.PATH }, 'darwin'), sandboxBackend: 'seatbelt' as const,
    nodeBinary: '/usr/local/bin/node', workspace: '/Users/op/project' };
  const launch = new Sandbox(config).codeLaunch('/tmp/scratch');
  assert.equal(launch.binary, SEATBELT_EXECUTABLE);
  // Seatbelt leaves no daemon-side state, so there is nothing to clean up.
  assert.equal(launch.containerName, undefined);
  const policy = launch.args[launch.args.indexOf('-p') + 1];
  const definitions = launch.args.filter(a => a.startsWith('-D'));
  // The only writable root is the disposable scratch directory.
  const writable = definitions.filter(d => d.startsWith('-DCHAT2LOCAL_WRITABLE_ROOT_'));
  assert.equal(writable.length, 1);
  assert.match(writable[0]!, /scratch$/);
  // Code mode reaches files through broker RPC, so the project is never readable.
  assert.equal(definitions.some(d => d.includes('/Users/op/project')), false);
  assert.equal(/\(allow network/.test(policy), false);
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


test('UTF-8 byte pagination reconstructs Korean and emoji without replacement characters', async t => {
  const { workspace, root } = await fixture(t);
  const text = 'ab한🌏글z';
  await writeFile(join(root, 'unicode.txt'), text);
  const pages: string[] = [];
  let offset = 0;
  while (true) {
    const page = await workspace.read('unicode.txt', offset, 4);
    pages.push(page.content);
    assert.ok(Buffer.byteLength(page.content) <= 4);
    assert.equal(page.sha256, sha256(text));
    if (page.next_offset === null) break;
    assert.ok(page.next_offset > offset);
    offset = page.next_offset;
  }
  assert.deepEqual(pages, ['ab', '한', '🌏', '글z']);
  assert.equal(pages.join(''), text);
  await assert.rejects(() => workspace.read('unicode.txt', 3, 4), /UTF-8 boundary/);
  await assert.rejects(() => workspace.read('unicode.txt', 2, 2), /too small/);
  assert.equal((await workspace.read('unicode.txt', 100, 4)).content, '');
});

test('text reads reject invalid UTF-8 rather than silently corrupting source', async t => {
  const { workspace, root } = await fixture(t);
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(() => workspace.read('invalid.txt'), /not valid UTF-8/);
});

test('cached workspace roots fail closed after replacement by a symlink', async t => {
  const { workspace, root, base } = await fixture(t, true);
  const outside = join(base, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'a.ts'), 'outside fixture');
  await rename(root, join(base, 'moved-project')); await symlink(outside, root);
  await assert.rejects(() => workspace.read('a.ts'), /Workspace root changed/);
  await assert.rejects(() => workspace.list('.'), /Workspace root changed/);
  await assert.rejects(() => workspace.write('a.ts', 'changed', sha256('outside fixture')), /Workspace root changed/);
  assert.equal(await readFile(join(outside, 'a.ts'), 'utf8'), 'outside fixture');
});
