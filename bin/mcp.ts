#!/usr/bin/env bun
/**
 * Codex MCP Server - Stdio Implementation
 * Simple JSON-RPC over stdio without external MCP SDK dependency
 */

import {
  readFileSchema,
  writeFileSchema,
  listDirSchema,
  execCommandSchema,
  grepSchema,
  globSchema,
  spawnSubagentSchema,
  codeModeSchema,
  asideReplSchema,
  codexExecSchema,
  readFileTool,
  writeFileTool,
  listDirTool,
  execCommandTool,
  grepTool,
  globTool,
  spawnSubagentTool,
  codeModeTool,
  asideReplTool,
  codexExecTool,
} from "../src/tools.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const tools: Record<string, { schema: unknown; handler: (input: any) => Promise<unknown>; description: string }> = {
  read_file: { schema: readFileSchema, handler: readFileTool, description: "Read contents of a file from the workspace" },
  write_file: { schema: writeFileSchema, handler: writeFileTool, description: "Write content to a file in the workspace" },
  list_dir: { schema: listDirSchema, handler: listDirTool, description: "List files and directories in a path" },
  exec_command: { schema: execCommandSchema, handler: execCommandTool, description: "Execute a shell command in the workspace" },
  grep: { schema: grepSchema, handler: grepTool, description: "Search for a pattern in files" },
  glob: { schema: globSchema, handler: globTool, description: "Find files matching a glob pattern" },
  spawn_subagent: { schema: spawnSubagentSchema, handler: spawnSubagentTool, description: "Spawn an aside exec subagent for browser tasks" },
  code_mode: { schema: codeModeSchema, handler: codeModeTool, description: "Perform code operations (analyze, refactor, test, document, debug)" },
  aside_repl: { schema: asideReplSchema, handler: asideReplTool, description: "Run Playwright-style JavaScript in Aside Browser" },
  codex_exec: { schema: codexExecSchema, handler: codexExecTool, description: "Run codex exec non-interactively for code tasks" },
};

function createResponse(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function createErrorResponse(id: string | number, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  // List tools
  if (method === "tools/list") {
    const toolList = Object.entries(tools).map(([name, { description }]) => ({
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    }));
    return createResponse(id, { tools: toolList });
  }

  // Call tool
  if (method === "tools/call") {
    const { name, arguments: args } = params as { name: string; arguments: unknown };
    
    console.error(`[chat2local] tools/call name=${name} args=`, JSON.stringify(args));
    
    if (!tools[name]) {
      return createErrorResponse(id, -32601, `Tool not found: ${name}`);
    }

    try {
      const result = await tools[name].handler(args);
      return createResponse(id, {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (error) {
      return createErrorResponse(id, -32603, error instanceof Error ? error.message : "Unknown error");
    }
  }

  // Ping
  if (method === "ping") {
    return createResponse(id, {});
  }

  return createErrorResponse(id, -32601, `Method not found: ${method}`);
}

// Main loop
async function main() {
  console.error("[chat2local] Started on stdio");
  
  let buffer = "";
  
  process.stdin.on("data", async (chunk) => {
    buffer += chunk.toString();
    
    // Process complete JSON objects
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      
      if (!line) continue;
      
      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        const response = await handleRequest(request);
        console.log(JSON.stringify(response));
      } catch (error) {
        console.error("[chat2local] Parse error:", error);
        const errorResponse = createErrorResponse(0, -32700, "Parse error");
        console.log(JSON.stringify(errorResponse));
      }
    }
  });

  process.stdin.on("end", () => {
    console.error("[chat2local] stdin closed, exiting");
    process.exit(0);
  });

  // Keep alive
  process.stdin.resume();
}

main().catch((error) => {
  console.error("[chat2local] Fatal error:", error);
  process.exit(1);
});
