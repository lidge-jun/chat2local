import type { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Runtime } from './runtime.js';
import { schemas, descriptions, readTools, externalTools, type ToolName } from './tools.js';
import { INSTRUCTIONS } from './instructions.js';

export function toolResult(value: unknown): CallToolResult {
  const data = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  if ('image' in data) {
    const image = data.image as { data: string; mimeType: string };
    return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType },
      { type: 'text', text: JSON.stringify({ name: data.name, sha256: data.sha256 }) }],
      structuredContent: { name: data.name, sha256: data.sha256 } };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

export function createServer(runtime: Runtime) {
  const server = new McpServer({ name: 'chat2local', version: '1.1.0' }, { instructions: INSTRUCTIONS });
  const active = new Set<Promise<unknown>>();
  let draining = false;
  for (const name of Object.keys(schemas) as ToolName[]) {
    server.registerTool(name, {
      description: descriptions[name], inputSchema: schemas[name].shape as z.ZodRawShape,
      annotations: { readOnlyHint: readTools.has(name), destructiveHint: !readTools.has(name),
        idempotentHint: readTools.has(name) && name !== 'code_mode_read', openWorldHint: externalTools.has(name) },
    }, async (args, extra) => {
      if (draining) return { isError: true, content: [{ type: 'text', text: 'Runtime is shutting down' }] };
      const promise = runtime.invoke(name, args, extra.signal);
      active.add(promise);
      try { return toolResult(await promise); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      finally { active.delete(promise); }
    });
  }
  server.registerResource('workflow-guide', 'chat2local://guide', { mimeType: 'text/plain', description: 'Chat-first operating instructions' }, async () => ({
    contents: [{ uri: 'chat2local://guide', mimeType: 'text/plain', text: INSTRUCTIONS }],
  }));
  return { server, drain: async () => { draining = true; await Promise.allSettled(active); await runtime.close(); } };
}
