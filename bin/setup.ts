#!/usr/bin/env bun
/**
 * Codex MCP Server - Easy Onboarding Setup
 * Automates installation, tunnel-client setup, and ChatGPT connector configuration
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const PROJECT_ROOT = resolve(process.cwd(), "..");
const CONFIG_DIR = join(homedir(), ".codex-mcp-server");
const TUNNEL_PROFILE_NAME = "codex-mcp-server";

interface SetupConfig {
  workspace?: string;
  tunnelId?: string;
  apiKey?: string;
  connectorName?: string;
}

function log(message: string) {
  console.log(`[setup] ${message}`);
}

function error(message: string) {
  console.error(`[setup] ERROR: ${message}`);
  process.exit(1);
}

function run(command: string, cwd?: string): string {
  try {
    return execSync(command, {
      cwd: cwd || PROJECT_ROOT,
      encoding: "utf-8",
      stdio: "pipe",
    }).toString().trim();
  } catch (e: any) {
    throw new Error(`Command failed: ${command}\n${e.message}`);
  }
}

function checkBun(): void {
  log("Checking Bun installation...");
  try {
    const version = run("bun --version");
    log(`Bun ${version} found`);
  } catch {
    error("Bun is not installed. Install it from https://bun.sh");
  }
}

function installDependencies(): void {
  log("Installing dependencies...");
  run("bun install");
  log("Dependencies installed");
}

function ensureConfigDir(): void {
  log("Creating config directory...");
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(join(CONFIG_DIR, "logs"), { recursive: true });
  mkdirSync(join(CONFIG_DIR, "tunnel", "profiles"), { recursive: true });
  log(`Config directory: ${CONFIG_DIR}`);
}

function downloadTunnelClient(): void {
  log("Downloading tunnel-client...");
  const binPath = join(CONFIG_DIR, "bin", "tunnel-client");
  
  if (existsSync(binPath)) {
    log("tunnel-client already exists");
    return;
  }
  
  mkdirSync(join(CONFIG_DIR, "bin"), { recursive: true });
  
  // Download from OpenAI releases
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/openai/tunnel-client/releases/latest/download/tunnel-client-darwin-${arch}`;
  
  run(`curl -L -o "${binPath}" "${url}"`);
  run(`chmod +x "${binPath}"`);
  
  // Remove quarantine
  try {
    run(`xattr -cr "${binPath}"`);
  } catch {
    // Ignore if xattr fails
  }
  
  log(`tunnel-client installed: ${binPath}`);
}

function createTunnelProfile(apiKey: string): void {
  log("Creating tunnel profile...");
  
  const profilePath = join(CONFIG_DIR, "tunnel", "profiles", `${TUNNEL_PROFILE_NAME}.yaml`);
  const mcpPath = join(PROJECT_ROOT, "bin", "mcp.ts");
  
  const profile = `# Codex MCP Server Tunnel Profile
api_key: ${apiKey}
runtime_command:
  - bun
  - ${mcpPath}
  - --stdio
working_directory: ${PROJECT_ROOT}
env:
  CODEX_MCP_WORKSPACE: ${process.env.CODEX_MCP_WORKSPACE || join(homedir(), "developer", "new", "700_projects")}
`;
  
  writeFileSync(profilePath, profile);
  log(`Profile created: ${profilePath}`);
}

function installLaunchdService(): void {
  log("Installing launchd service...");
  
  const plistPath = join(homedir(), "Library", "LaunchAgents", "com.codex-mcp-server.plist");
  const binPath = join(CONFIG_DIR, "bin", "tunnel-client");
  const profilePath = join(CONFIG_DIR, "tunnel", "profiles", `${TUNNEL_PROFILE_NAME}.yaml`);
  
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex-mcp-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
    <string>run</string>
    <string>--profile</string>
    <string>${profilePath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/${process.env.USER}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${join(CONFIG_DIR, "logs", "tunnel.stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(CONFIG_DIR, "logs", "tunnel.stderr.log")}</string>
</dict>
</plist>`;
  
  writeFileSync(plistPath, plist);
  
  // Load the service
  try {
    run(`launchctl unload "${plistPath}" 2>/dev/null || true`);
    run(`launchctl load "${plistPath}"`);
    log("Launchd service installed and loaded");
  } catch (e) {
    log("Warning: Could not load launchd service automatically");
    log(`Please run: launchctl load "${plistPath}"`);
  }
}

function printInstructions(apiKey: string, connectorName: string): void {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║                    Codex MCP Server - Setup Complete                       ║
╚════════════════════════════════════════════════════════════════════════════╝

Next steps:

1. Open ChatGPT web: https://chatgpt.com

2. Go to Settings → Security and login → Enable Developer Mode

3. Go to Plugins → Create new developer mode app:
   - Name: ${connectorName}
   - Connection type: Tunnel
   - Select your tunnel from the list

4. Set permissions:
   - Enable "Allow all actions" for full access
   - Or configure specific tool permissions

5. Use in ChatGPT:
   @${connectorName} list_dir .
   @${connectorName} read_file package.json
   @${connectorName} exec_command "git status"

Configuration:
- Config dir: ${CONFIG_DIR}
- Tunnel profile: ${TUNNEL_PROFILE_NAME}
- Logs: ${join(CONFIG_DIR, "logs")}

To uninstall:
  launchctl unload ~/Library/LaunchAgents/com.codex-mcp-server.plist
  rm ~/Library/LaunchAgents/com.codex-mcp-server.plist
  rm -rf ${CONFIG_DIR}

Documentation: https://github.com/openai/tunnel-client
`);
}

async function main() {
  const args = process.argv.slice(2);
  const config: SetupConfig = {};
  
  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) {
      config.workspace = args[i + 1];
      i++;
    } else if (args[i] === "--api-key" && args[i + 1]) {
      config.apiKey = args[i + 1];
      i++;
    } else if (args[i] === "--connector-name" && args[i + 1]) {
      config.connectorName = args[i + 1];
      i++;
    }
  }
  
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  const connectorName = config.connectorName || "Codex MCP";
  
  if (!apiKey) {
    error("OpenAI API key required. Set OPENAI_API_KEY or use --api-key");
  }
  
  log("Starting Codex MCP Server setup...");
  
  checkBun();
  installDependencies();
  ensureConfigDir();
  downloadTunnelClient();
  createTunnelProfile(apiKey);
  installLaunchdService();
  printInstructions(apiKey, connectorName);
  
  log("Setup complete!");
}

main().catch((e) => {
  error(e.message);
});
