#!/usr/bin/env bun
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const sourcePath = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = resolve(dirname(sourcePath), basename(dirname(dirname(sourcePath))) === 'dist' ? '../..' : '..');
const entryPath = join(PROJECT_ROOT, sourcePath.endsWith('.ts') ? 'bin/mcp.ts' : 'dist/bin/mcp.js');
export const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/** Generates a launch wrapper only. Never installs, downloads, starts services or writes API keys. */
export async function setup(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    workspace: { type: 'string' }, 'tunnel-id': { type: 'string' },
    output: { type: 'string', default: join(PROJECT_ROOT, '.chat2local-local') },
    write: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  }, strict: true });
  if (values.help || !values.workspace) {
    return 'Usage: bun run setup --workspace /absolute/source/project [--tunnel-id tunnel_...] [--write]\n'
      + 'Dry run by default. --write creates only a private launcher; no dependencies, tunnel or service is installed.\n'
      + 'Provide CONTROL_PLANE_API_KEY only to tunnel-client, never as a chat/tool argument.';
  }
  const workspace = await realpath(resolve(values.workspace));
  const output = resolve(values.output!);
  const wrapper = join(output, 'mcp.sh');
  // Bun executes this source; the path is anchored to this script rather than caller cwd.
  const contents = '#!/bin/sh\nset -eu\n'
    + `export CHAT2LOCAL_WORKSPACE=${quote(workspace)}\n`
    + '# Personal defaults: writes and Aside enabled. Set CHAT2LOCAL_ALLOW_WRITE=0 / CHAT2LOCAL_ALLOW_ASIDE=0 to disable.\n'
    + '# Code mode still requires a provisioned CHAT2LOCAL_WORKER_IMAGE; there is no host fallback.\n'
    + `exec ${quote(process.execPath)} ${quote(entryPath)}\n`;
  const id = values['tunnel-id'];
  if (id && !/^tunnel_[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid tunnel ID');
  if (values.write) {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(wrapper, contents, { flag: 'wx', mode: 0o700 });
  }
  return `${values.write ? 'Created' : 'Dry run; would create'}: ${wrapper}\n\n${contents}\n`
    + 'Install tunnel-client using the official supported installer on a provisioning machine.\n'
    + 'Run these commands yourself after reviewing the launcher and setting CONTROL_PLANE_API_KEY:\n'
    + `tunnel-client init --sample sample_mcp_stdio_local --profile chat2local --tunnel-id ${quote(id || 'YOUR_TUNNEL_ID')} --mcp-command ${quote(wrapper)}\n`
    + 'tunnel-client doctor --profile chat2local --explain\n'
    + 'tunnel-client run --profile chat2local\n\n'
    + 'Only report connection success after doctor/runtime readiness and a real ChatGPT session_open call.\n'
    + 'Do not run two active stdio runtimes with the same tunnel ID. No launchd or existing profile was changed.';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup(process.argv.slice(2)).then(console.log).catch(e => { console.error(e.message); process.exitCode = 1; });
}
