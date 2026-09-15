import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), 'chat2local-mcp-'));
  const root = join(base, 'project'); await mkdir(root); await writeFile(join(root, 'example.txt'), 'hello MCP');

  const env = { PATH: process.env.PATH!, HOME: base, CHAT2LOCAL_ALLOW_WRITE: '0', CHAT2LOCAL_ALLOW_ASIDE: '0', CHAT2LOCAL_WORKSPACE: root, CHAT2LOCAL_STATE_DIR: join(base, 'state') };
  return { root, base, env };
}

test('real MCP SDK client initializes, discovers schemas/defaults, calls tools and reads instructions', async t => {
  const { env, base } = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/bin/mcp.js')], env, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.close(); await rm(base, { recursive: true, force: true }); }); await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'chat2local');
  assert.match(client.getInstructions() || '', /primary planner/);
  const listed = await client.listTools();
  const read = listed.tools.find(t => t.name === 'read_file')!;
  assert.ok(read.inputSchema.properties?.path); assert.ok(read.inputSchema.required?.includes('path'));
  assert.equal(listed.tools.find(t => t.name === 'code_mode_read')?.annotations?.readOnlyHint, true);
  assert.equal(listed.tools.find(t => t.name === 'code_mode')?.annotations?.readOnlyHint, false);
  const opened = await client.callTool({ name: 'session_open', arguments: {} }) as any;
  const session_id = opened.structuredContent.session.id;
  const result = await client.callTool({ name: 'read_file', arguments: { session_id, path: 'example.txt' } }) as any;
  assert.equal(result.structuredContent.content, 'hello MCP');
  const denied = await client.callTool({ name: 'read_file', arguments: { session_id, path: '../secret' } });
  assert.equal(denied.isError, true);
  const guide = await client.readResource({ uri: 'chat2local://guide' }); assert.equal(guide.contents.length, 1);
});

test('EOF drains an asynchronous tools/call response instead of process.exit racing it', async t => {
  const { env, base } = await fixture(t);
  const child = spawn(process.execPath, [resolve('dist/bin/mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.kill('SIGKILL'); await rm(base, { recursive: true, force: true }); });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b.toString(); }); child.stderr.on('data', b => { stderr += b.toString(); });
  const closed = new Promise<number | null>(r => child.on('close', r));
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_open', arguments: {} } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  assert.equal(await closed, 0, stderr); clearTimeout(timer);
  const responses = stdout.trim().split('\n').map(s => JSON.parse(s));
  assert.equal(responses.length, 2); assert.ok(responses.find(r => r.id === 2)?.result?.structuredContent?.session?.id);
});
