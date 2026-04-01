# mcp-ssh-remote

An MCP (Model Context Protocol) server that wraps the **system `ssh` binary** to execute commands on remote hosts — with full support for `ProxyCommand`, bastion hosts, jump hosts, and any configuration in `~/.ssh/config`.

## Why this exists

Most SSH-based MCP servers (e.g. `@fangjunjie/ssh-mcp-server`) use Node's `ssh2` library internally, which **does not support `ProxyCommand`**. If your remote server is behind a bastion host or requires a custom proxy setup defined in `~/.ssh/config`, those servers simply cannot connect.

This server has no SSH implementation of its own — it calls the system `ssh` binary directly, so it inherits everything your shell SSH already supports: `ProxyCommand`, `ProxyJump`, identity files, `ControlMaster`, port forwarding, and so on.

## Requirements

- Node.js ≥ 14
- System `ssh` installed and configured (openssh)
- The target host must be reachable via `ssh <hostname>` from your terminal

## Installation

**Via npx (no install needed):**
```bash
npx mcp-ssh-remote --host myserver
```

**Or clone and run directly:**
```bash
git clone https://github.com/JasonLinjc/mcp-ssh-remote.git
node mcp-ssh-remote/index.js --host myserver
```

## Claude Code Configuration

Add to your `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "ssh-remote": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-ssh-remote/index.js", "--host", "myserver"],
      "env": {}
    }
  }
}
```

Or with npx:
```json
{
  "mcpServers": {
    "ssh-remote": {
      "type": "stdio",
      "command": "npx",
      "args": ["mcp-ssh-remote", "--host", "myserver"],
      "env": {}
    }
  }
}
```

You can also add it via the Claude Code CLI:
```bash
claude mcp add ssh-remote -- node /path/to/mcp-ssh-remote/index.js --host myserver
```

## Bastion / ProxyCommand example

If `~/.ssh/config` contains:
```
Host myserver
  HostName 10.0.0.5
  User alice
  ProxyCommand ssh bastion nc %h %p
```

Then just pass `--host myserver` — the ProxyCommand is followed automatically.

## Tools

| Tool | Description |
|---|---|
| `execute_command` | Run any shell command on the remote host |
| `read_file` | Read a remote file's contents |
| `write_file` | Write text content to a remote file |
| `list_directory` | List files in a remote directory (`ls -la`) |

## Usage

```
node index.js --host <hostname>
```

`<hostname>` must match a host you can reach with `ssh <hostname>` — an IP, a hostname, or a `Host` alias from `~/.ssh/config`.

## License

MIT
