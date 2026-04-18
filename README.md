# mcp-ssh-remote

An MCP (Model Context Protocol) server that wraps the **system `ssh` binary** to execute commands on remote hosts — with full support for `ProxyCommand`, bastion hosts, jump hosts, and any configuration in `~/.ssh/config`.

Built for workflows where your GPU/HPC server is behind a bastion host, has no internet access, and you want to develop locally with Claude Code while running jobs remotely.

## Why this exists

Most SSH-based MCP servers (e.g. `@fangjunjie/ssh-mcp-server`) use Node's `ssh2` library internally, which **does not support `ProxyCommand`**. If your remote server is behind a bastion host or requires a custom proxy setup defined in `~/.ssh/config`, those servers simply cannot connect.

This server has no SSH implementation of its own — it calls the system `ssh` binary directly, so it inherits everything your shell SSH already supports: `ProxyCommand`, `ProxyJump`, identity files, `ControlMaster`, port forwarding, and so on.

## Features

- **Works with any `~/.ssh/config` setup** — ProxyCommand, ProxyJump, magic-user auto-forward bastions
- **Optional SSH ControlMaster multiplexing** — opt in with `MCP_SSH_MULTIPLEX=1` for hosts where it works (off by default; see [SSH multiplexing](#ssh-multiplexing))
- **Login shell wrapping** — commands run via `bash -l` so your full environment (conda, Slurm, modules) is always available
- **Slurm integration** — submit, cancel, monitor jobs and read logs directly
- **rsync support** — sync local directories to the remote server through the bastion
- **Safe file operations** — large file writes piped via stdin (no shell arg limits), edit files with find-and-replace

## SSH multiplexing

Multiplexing is **off by default**. Many jump hosts — especially magic-user auto-forward bastions (e.g. `user/target_ip/target_user`) — permit only one session per TCP connection. Every follow-up call then fails with `Session open refused by peer`, leaks stderr into the response, and flakes under load.

With multiplexing off, each call opens a fresh SSH connection. Slightly slower per call, but correct and reliable.

For hosts where multiplexing works (plain direct SSH, standard ProxyJump over a jumphost that supports session forwarding), opt in via env var:

```json
{
  "mcpServers": {
    "ssh-remote": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-ssh-remote/index.js", "--host", "myserver"],
      "env": {"MCP_SSH_MULTIPLEX": "1"}
    }
  }
}
```

## Requirements

- Node.js >= 14
- System `ssh` and `rsync` installed (openssh)
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

### File Operations

| Tool | Description |
|---|---|
| `execute_command` | Run any shell command (configurable timeout, up to 10 min) |
| `read_file` | Read a remote file (supports `offset` and `limit` for large files) |
| `write_file` | Write content to a remote file (creates parent dirs, handles large files) |
| `edit_file` | Find-and-replace a unique string in a remote file |
| `list_directory` | List files in a remote directory (`ls -la`) |
| `grep_files` | Search file contents with regex (recursive, with file filtering) |
| `glob_files` | Find files by glob pattern |

### Slurm Job Management

| Tool | Description |
|---|---|
| `slurm_status` | Show job queue (current user or all users) |
| `slurm_submit` | Submit a batch job (from script path or inline script content) |
| `slurm_cancel` | Cancel a job by ID |
| `slurm_job_info` | Get detailed job info (`scontrol show job`) |
| `slurm_log` | Tail stdout/stderr logs of a running or completed job |
| `slurm_array_summary` | Concise summary of an array job: completed/running/pending/failed counts, failed task IDs |
| `slurm_resubmit_failed` | Identify failed tasks in an array job and resubmit only those |

### Sync & Utilities

| Tool | Description |
|---|---|
| `rsync_to_remote` | Rsync a local directory to the remote host (with exclude patterns, dry-run, delete) |
| `rsync_from_remote` | Rsync a remote directory to local (pull results back) |
| `git_pull_remote` | Pull latest git changes in a remote directory |
| `tail_file` | Read the last N lines of a remote file (useful for monitoring logs) |
| `disk_usage` | Check disk usage of a file or directory (with optional depth) |

## Typical Workflow

```
1. Edit code locally           →  Claude Code's native Edit/Write tools
2. Sync to remote              →  rsync_to_remote (quick) or git push + git_pull_remote (committed)
3. Submit a Slurm job          →  slurm_submit
4. Monitor training            →  slurm_status + slurm_log
5. Read results                →  read_file, grep_files
```

Example conversation:
```
You:    "Change the learning rate to 1e-4 in train.py"
Claude: [edits local file]

You:    "Sync and submit on gpu31 with 4 GPUs"
Claude: [rsync_to_remote] → [slurm_submit -p gpu31 --gres=gpu:4]

You:    "How's it going?"
Claude: [slurm_status] → [slurm_log]
```

## Usage

```
node index.js --host <hostname>
```

`<hostname>` must match a host you can reach with `ssh <hostname>` — an IP, a hostname, or a `Host` alias from `~/.ssh/config`.

## License

MIT
