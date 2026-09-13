# Codex MCP Server

Deployment-ready MCP server for ChatGPT web with Codex tools, fast subagent support, and official tunnel-client integration.

## Features

- **Codex-like Tools**: File operations, shell execution, code search
- **Fast Subagent Spawning**: Parallel task execution with unlimited subagents
- **Code Mode**: Analyze, refactor, test, document, and debug operations
- **Easy Onboarding**: One-command setup with automatic tunnel configuration
- **Official Integration**: Uses OpenAI's Secure MCP Tunnel (no gray zones)
- **Persistent**: Launchd service keeps server running across reboots

## Quick Start

### 1. Prerequisites

- macOS (for launchd integration)
- [Bun](https://bun.sh) installed
- OpenAI API key with tunnel permissions

### 2. Setup

```bash
# Clone the repository
git clone <your-repo-url> codex-mcp-server
cd codex-mcp-server

# Run setup (installs dependencies, tunnel-client, launchd service)
bun run bin/setup.ts --api-key "your-openai-api-key" --connector-name "Codex MCP"
```

### 3. Configure ChatGPT

1. Open https://chatgpt.com
2. Go to **Settings → Security and login → Enable Developer Mode**
3. Go to **Plugins → Create new developer mode app**:
   - Name: `Codex MCP`
   - Connection type: **Tunnel**
   - Select your tunnel from the list
4. Set permissions: **Allow all actions** (or configure specific tools)

### 4. Use in ChatGPT

```
@Codex MCP list_dir .
@Codex MCP read_file package.json
@Codex MCP exec_command "git status"
@Codex MCP grep "function" src/
@Codex MCP spawn_subagent "analyze this codebase"
```

## Available Tools

### File Operations

- `read_file` - Read file contents
- `write_file` - Write file contents
- `list_dir` - List directory contents

### Command Execution

- `exec_command` - Execute shell commands

### Search

- `grep` - Search for patterns in files
- `glob` - Find files matching patterns

### Subagent Spawning

- `spawn_subagent` - Spawn fast subagents for parallel tasks

### Code Operations

- `code_mode` - Analyze, refactor, test, document, debug

## Configuration

### Environment Variables

- `CODEX_MCP_WORKSPACE` - Default workspace directory (default: `~/developer/new/700_projects`)
- `OPENAI_API_KEY` - OpenAI API key (required)

### Config Directory

All configuration is stored in `~/.codex-mcp-server/`:

- `bin/tunnel-client` - Tunnel client binary
- `tunnel/profiles/codex-mcp-server.yaml` - Tunnel profile
- `logs/` - Log files

## Management

### Start/Stop Service

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.codex-mcp-server.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.codex-mcp-server.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.codex-mcp-server.plist
launchctl load ~/Library/LaunchAgents/com.codex-mcp-server.plist
```

### View Logs

```bash
tail -f ~/.codex-mcp-server/logs/tunnel.stdout.log
tail -f ~/.codex-mcp-server/logs/tunnel.stderr.log
```

### Check Status

```bash
~/.codex-mcp-server/bin/tunnel-client runtimes status codex-mcp-server
```

## Development

### Run Locally (without tunnel)

```bash
bun run bin/mcp.ts --stdio
```

### Test Tools

```bash
# Test read_file
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"package.json"}}}' | bun run bin/mcp.ts --stdio

# Test exec_command
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"exec_command","arguments":{"command":"ls -la"}}}' | bun run bin/mcp.ts --stdio
```

## Architecture

```
┌─────────────┐
│ ChatGPT Web │
└──────┬──────┘
       │ MCP Protocol
       ▼
┌──────────────────┐
│ OpenAI Tunnel    │
│ Service          │
└──────┬───────────┘
       │ HTTPS
       ▼
┌──────────────────┐
│ tunnel-client    │
│ (local)          │
└──────┬───────────┘
       │ stdio
       ▼
┌──────────────────┐
│ Codex MCP Server │
│ (this project)   │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Local Filesystem │
│ Shell Commands   │
│ Subagents        │
└──────────────────┘
```

## Security

- Uses OpenAI's official Secure MCP Tunnel (no public endpoints)
- All communication over HTTPS
- Workspace is sandboxed to configured directory
- Launchd service runs with user permissions
- API key stored in local profile only

## Troubleshooting

### Server not responding

```bash
# Check if service is running
launchctl list | grep codex-mcp-server

# Check logs
tail -50 ~/.codex-mcp-server/logs/tunnel.stderr.log

# Restart service
launchctl unload ~/Library/LaunchAgents/com.codex-mcp-server.plist
launchctl load ~/Library/LaunchAgents/com.codex-mcp-server.plist
```

### Tunnel not connecting

```bash
# Check tunnel status
~/.codex-mcp-server/bin/tunnel-client runtimes status codex-mcp-server

# Verify API key
cat ~/.codex-mcp-server/tunnel/profiles/codex-mcp-server.yaml

# Test tunnel manually
~/.codex-mcp-server/bin/tunnel-client run --profile ~/.codex-mcp-server/tunnel/profiles/codex-mcp-server.yaml
```

### Permission errors

```bash
# Remove quarantine attributes
xattr -cr ~/.codex-mcp-server/bin/tunnel-client
xattr -cr ~/Library/LaunchAgents/com.codex-mcp-server.plist

# Fix permissions
chmod +x ~/.codex-mcp-server/bin/tunnel-client
```

## Uninstall

```bash
# Stop and remove service
launchctl unload ~/Library/LaunchAgents/com.codex-mcp-server.plist
rm ~/Library/LaunchAgents/com.codex-mcp-server.plist

# Remove config directory
rm -rf ~/.codex-mcp-server

# Remove project
cd ..
rm -rf codex-mcp-server
```

## References

- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT Developer Mode](https://platform.openai.com/docs/guides/developer-mode)
- [Model Context Protocol](https://modelcontextprotocol.io)

## License

MIT
