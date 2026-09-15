import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile , realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const enabled = process.env.CHAT2LOCAL_BUNDLE_TESTS === '1';
for (const restricted of [false, true]) {
  test(`standalone bundle initializes without node_modules; restricted=${restricted}`, { skip: !enabled, timeout: 15000 }, async t => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'chat2local-bundle-')));
    const project = join(base, 'project'); await mkdir(project);
    await writeFile(join(project, 'example.txt'), 'bundle input');
    const entry = join(base, 'chat2local.mjs');
    await copyFile(resolve('release/chat2local.mjs'), entry);
    // The copied bundle has no adjacent dependencies and Bun auto-install is disabled.
    // No native Aside or Docker adapter is ever invoked by this deployment test.
    const env: Record<string, string> = {
      PATH: process.env.PATH!, HOME: base, BUN_INSTALL_AUTO: 'disable',
      CHAT2LOCAL_WORKSPACE: project, CHAT2LOCAL_STATE_DIR: join(base, 'state'),
      CHAT2LOCAL_ASIDE_BINARY: join(base, 'forbidden-aside'),
      CHAT2LOCAL_DOCKER_BINARY: join(base, 'forbidden-docker'),
    };
    if (restricted) {
      env.CHAT2LOCAL_ALLOW_WRITE = '0'; env.CHAT2LOCAL_ALLOW_ASIDE = '0';
      env.CHAT2LOCAL_ASIDE_PERMISSION = 'guard';
    }
    const transport = new StdioClientTransport({
      command: process.env.CHAT2LOCAL_TEST_BUN || 'bun', args: [entry], cwd: base, env, stderr: 'pipe',
    });
    const client = new Client({ name: 'standalone-deployment-test', version: '1' });
    let stderr = '';
    t.after(async () => {
      try { await client.close(); } finally { await rm(base, { recursive: true, force: true }); }
    });
    transport.stderr?.on('data', b => { stderr += b.toString(); });
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, '1.2.0', stderr);
    const opened = await client.callTool({ name: 'session_open', arguments: {} }) as any;
    assert.equal(opened.isError, undefined, JSON.stringify(opened));
    assert.equal(opened.structuredContent.write_enabled, !restricted);
    assert.equal(opened.structuredContent.native_aside_enabled, !restricted);
    assert.equal(opened.structuredContent.native_aside_permission, restricted ? 'guard' : 'full-access');
    assert.equal(opened.structuredContent.host_shell, false);
    assert.equal(opened.structuredContent.code_mode_configured, false);
    const session_id = opened.structuredContent.session.id;
    const file = await client.callTool({ name: 'read_file', arguments: { session_id, path: 'example.txt' } }) as any;
    assert.equal(file.structuredContent.content, 'bundle input');
    const edit = await client.callTool({ name: 'write_file', arguments: {
      session_id, path: 'example.txt', content: 'bundle output', expected_sha256: file.structuredContent.sha256,
    } }) as any;
    assert.equal(Boolean(edit.isError), restricted);
    assert.equal(await readFile(join(project, 'example.txt'), 'utf8'), restricted ? 'bundle input' : 'bundle output');
    const listed = await client.listTools();
    assert.ok(listed.tools.some(tool => tool.name === 'aside_native'));
    assert.ok(listed.tools.some(tool => tool.name === 'code_mode'));
  });
}
