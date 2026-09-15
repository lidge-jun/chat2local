import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename , realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';
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
