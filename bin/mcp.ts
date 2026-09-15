#!/usr/bin/env bun
import { Transform } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { createServer } from '../src/server.js';

async function main() {
  if (process.platform === 'win32') throw new Error('Native Windows is not validated. Use a Linux VM/WSL workspace and runtime.');
  const runtime = await Runtime.create(loadConfig());
  const { server, drain } = createServer(runtime);
  let lineBytes = 0;
  const input = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    for (const byte of chunk) {
      lineBytes = byte === 10 ? 0 : lineBytes + 1;
      if (lineBytes > 1024 * 1024) { callback(new Error('MCP frame exceeds 1 MiB')); return; }
    }
    callback(null, chunk);
  } });
  const transport = new StdioServerTransport(input, process.stdout);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    process.stdin.unpipe(input);
    await drain(); await server.close(); process.stdin.destroy(); input.destroy();
  })();
  process.once('SIGINT', () => { void stop().catch(console.error); });
  process.once('SIGTERM', () => { void stop().catch(console.error); });
  input.on('error', e => { console.error(`[chat2local] ${e.message}`); process.exitCode = 1; void stop().catch(console.error); });
  process.stdin.once('end', () => { void stop().catch(e => { console.error(e); process.exitCode = 1; }); });
  await server.connect(transport);
  process.stdin.pipe(input);
  console.error('[chat2local] stdio ready; policy loaded, no backend executed');
}
main().catch(e => { console.error(`[chat2local] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
