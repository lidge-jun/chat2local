/**
 * Codex-like tools for MCP server
 * Exposes file operations, shell execution, and subagent spawning
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";

// Type definitions
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SubagentResult {
  output: string;
  exitCode: number;
  agentId?: string;
  duration: number;
}

export const DEFAULT_WORKSPACE = process.env.CODEX_MCP_WORKSPACE || join(homedir(), "developer", "new", "700_projects");
export const MAX_READ_BYTES = 256 * 1024;
export const MAX_EXEC_BYTES = 256 * 1024;
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;

// Tool schemas
export const readFileSchema = z.object({
  path: z.string().describe("Path to the file to read (relative to workspace or absolute)"),
  offset: z.number().int().min(0).default(0).describe("Byte offset to start reading from"),
  limit: z.number().int().min(1).max(MAX_READ_BYTES).default(MAX_READ_BYTES).describe("Maximum bytes to read"),
});

export const writeFileSchema = z.object({
  path: z.string().describe("Path to the file to write (relative to workspace or absolute)"),
  content: z.string().describe("Content to write to the file"),
  createDirs: z.boolean().default(true).describe("Create parent directories if they don't exist"),
});

export const listDirSchema = z.object({
  path: z.string().describe("Directory path to list (relative to workspace or absolute)"),
  recursive: z.boolean().default(false).describe("List subdirectories recursively"),
  pattern: z.string().optional().describe("Glob pattern to filter files (e.g., '*.ts')"),
});

export const execCommandSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory for the command (defaults to workspace)"),
  timeout: z.number().int().min(1000).max(DEFAULT_EXEC_TIMEOUT_MS * 10).default(DEFAULT_EXEC_TIMEOUT_MS).describe("Timeout in milliseconds"),
  env: z.record(z.string()).optional().describe("Environment variables to set"),
});

export const grepSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().describe("Directory or file to search in"),
  recursive: z.boolean().default(true).describe("Search recursively"),
  caseSensitive: z.boolean().default(false).describe("Case-sensitive search"),
  maxResults: z.number().int().min(1).max(1000).default(100).describe("Maximum number of results"),
});

export const globSchema = z.object({
  pattern: z.string().describe("Glob pattern (e.g., '**/*.ts')"),
  path: z.string().default(".").describe("Base directory to search from"),
});

export const spawnSubagentSchema = z.object({
  prompt: z.string().describe("Prompt/instructions for the subagent"),
  model: z.enum(["fast", "standard", "deep"]).default("fast").describe("Model tier to use"),
  workdir: z.string().optional().describe("Working directory for the subagent"),
  timeout: z.number().int().min(1000).max(DEFAULT_SUBAGENT_TIMEOUT_MS * 5).default(DEFAULT_SUBAGENT_TIMEOUT_MS).describe("Timeout in milliseconds"),
  env: z.record(z.string()).optional().describe("Environment variables"),
});

export const codeModeSchema = z.object({
  action: z.enum(["analyze", "refactor", "test", "document", "debug"]).describe("Code operation to perform"),
  target: z.string().describe("Target file, directory, or code snippet"),
  context: z.string().optional().describe("Additional context for the operation"),
  output: z.enum(["inline", "file", "diff"]).default("inline").describe("How to return the result"),
});

// Helper functions
function resolvePath(path: string): string {
  if (isAbsolute(path)) return resolve(path);
  return resolve(DEFAULT_WORKSPACE, path);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

// Tool implementations
export async function readFileTool(input: z.infer<typeof readFileSchema>): Promise<string> {
  const path = resolvePath(input.path);
  const buffer = await readFile(path);
  const slice = buffer.subarray(input.offset, input.offset + input.limit);
  return slice.toString("utf-8");
}

export async function writeFileTool(input: z.infer<typeof writeFileSchema>): Promise<{ success: boolean; path: string }> {
  const path = resolvePath(input.path);
  if (input.createDirs) {
    await ensureDir(join(path, ".."));
  }
  await writeFile(path, input.content, "utf-8");
  return { success: true, path };
}

export async function listDirTool(input: z.infer<typeof listDirSchema>): Promise<Array<{ name: string; type: "file" | "directory"; size?: number }>> {
  const path = resolvePath(input.path);
  const entries = await readdir(path, { withFileTypes: true });
  const results: Array<{ name: string; type: "file" | "directory"; size?: number }> = [];
  
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    const stats = await stat(entryPath);
    results.push({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      size: entry.isFile() ? stats.size : undefined,
    });
  }
  
  if (input.pattern) {
    const regex = new RegExp(input.pattern.replace(/\*/g, ".*"));
    return results.filter(r => regex.test(r.name));
  }
  
  return results;
}

export async function execCommandTool(input: z.infer<typeof execCommandSchema>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = input.cwd ? resolvePath(input.cwd) : DEFAULT_WORKSPACE;
  
  return new Promise((resolve, reject) => {
    const proc = spawn("/bin/zsh", ["-lc", input.command], {
      cwd,
      env: { ...process.env, ...input.env },
      timeout: input.timeout,
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
      if (stdout.length > MAX_EXEC_BYTES) proc.kill();
    });
    
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > MAX_EXEC_BYTES) proc.kill();
    });
    
    proc.on("close", (code) => {
      resolve({
        stdout: stdout.slice(0, MAX_EXEC_BYTES),
        stderr: stderr.slice(0, MAX_EXEC_BYTES),
        exitCode: code ?? 0,
      });
    });
    
    proc.on("error", (err) => {
      reject(err);
    });
  });
}

export async function grepTool(input: z.infer<typeof grepSchema>): Promise<Array<{ file: string; line: number; content: string }>> {
  const path = resolvePath(input.path);
  const flags = input.caseSensitive ? "-n" : "-ni";
  const maxResults = input.maxResults.toString();
  
  return new Promise((resolve, reject) => {
    const proc = spawn("/bin/zsh", ["-lc", `grep ${flags} -m ${maxResults} -r "${input.pattern}" "${path}"`], {
      timeout: DEFAULT_EXEC_TIMEOUT_MS,
    });
    
    let stdout = "";
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    
    proc.on("close", (code) => {
      const results = stdout
        .split("\n")
        .filter(line => line.trim())
        .map(line => {
          const match = line.match(/^([^:]+):(\d+):(.*)$/);
          if (match) {
            return { file: match[1], line: parseInt(match[2]), content: match[3] };
          }
          return null;
        })
        .filter(Boolean) as Array<{ file: string; line: number; content: string }>;
      
      resolve(results.slice(0, input.maxResults));
    });
    
    proc.on("error", reject);
  });
}

export async function globTool(input: z.infer<typeof globSchema>): Promise<string[]> {
  const path = resolvePath(input.path);
  
  return new Promise((resolve, reject) => {
    const proc = spawn("/bin/zsh", ["-lc", `find "${path}" -name "${input.pattern}" -type f`], {
      timeout: DEFAULT_EXEC_TIMEOUT_MS,
    });
    
    let stdout = "";
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    
    proc.on("close", () => {
      resolve(stdout.split("\n").filter(line => line.trim()));
    });
    
    proc.on("error", reject);
  });
}

export async function spawnSubagentTool(input: z.infer<typeof spawnSubagentSchema>): Promise<SubagentResult> {
  const startTime = Date.now();
  const workdir = input.workdir ? resolvePath(input.workdir) : DEFAULT_WORKSPACE;
  const agentId = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Use codex CLI if available, otherwise fallback to direct execution
  const useCodex = await checkCodexAvailable();
  
  if (useCodex) {
    return runCodexSubagent(input, workdir, agentId, startTime);
  }
  
  // Fallback: execute prompt directly via shell
  return runShellSubagent(input, workdir, agentId, startTime);
}

async function checkCodexAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("/bin/zsh", ["-lc", "which codex"], { timeout: 5000 });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function runCodexSubagent(
  input: z.infer<typeof spawnSubagentSchema>,
  workdir: string,
  agentId: string,
  startTime: number
): Promise<SubagentResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "--model", input.model,
      "--prompt", input.prompt,
      "--workdir", workdir,
    ];
    
    const proc = spawn("codex", args, {
      cwd: workdir,
      env: { ...process.env, ...input.env, SUBAGENT_ID: agentId },
      timeout: input.timeout,
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout?.on("data", (data) => { stdout += data.toString(); });
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });
    
    proc.on("close", (code) => {
      resolve({
        output: stdout || stderr,
        exitCode: code ?? 0,
        agentId,
        duration: Date.now() - startTime,
      });
    });
    
    proc.on("error", reject);
  });
}

async function runShellSubagent(
  input: z.infer<typeof spawnSubagentSchema>,
  workdir: string,
  agentId: string,
  startTime: number
): Promise<SubagentResult> {
  return new Promise((resolve, reject) => {
    // Execute as shell command for testing
    const proc = spawn("/bin/zsh", ["-lc", `echo "Subagent would execute: ${input.prompt.replace(/"/g, '\\"')}"`], {
      cwd: workdir,
      env: { ...process.env, ...input.env },
      timeout: input.timeout,
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout?.on("data", (data) => { stdout += data.toString(); });
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });
    
    proc.on("close", (code) => {
      resolve({
        output: stdout || stderr,
        exitCode: code ?? 0,
        agentId,
        duration: Date.now() - startTime,
      });
    });
    
    proc.on("error", reject);
  });
}

export async function codeModeTool(input: z.infer<typeof codeModeSchema>): Promise<{ result: string; action: string }> {
  // This would integrate with codex for code operations
  // For now, provide a placeholder that suggests using exec_command with codex CLI
  const suggestions = {
    analyze: `codex analyze "${input.target}"`,
    refactor: `codex refactor "${input.target}" --context "${input.context || ''}"`,
    test: `codex test "${input.target}"`,
    document: `codex document "${input.target}"`,
    debug: `codex debug "${input.target}"`,
  };
  
  return {
    result: `Use exec_command with: ${suggestions[input.action]}`,
    action: input.action,
  };
}
