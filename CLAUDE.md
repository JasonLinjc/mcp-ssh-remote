# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Project overview

MCP server that wraps the system `ssh` binary (not a Node `ssh2` implementation) so it inherits everything `~/.ssh/config` supports: `ProxyCommand`, `ProxyJump`, magic-user bastions, identity files, etc. Single file: `index.js`. No build step, no dependencies beyond Node stdlib.

## Running

```bash
# Direct
node index.js --host <hostname>

# Smoke test: pipe JSON-RPC to stdin, watch stdout
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_command","arguments":{"command":"hostname"}}}' \
  | node index.js --host <hostname>
```

`<hostname>` must resolve via `ssh <hostname>` from the user's shell.

## Architecture

JSON-RPC stdio server. Lines in → dispatch → lines out.

- **`dispatch(msg)`** (bottom of file) routes `initialize`, `tools/list`, `tools/call`. `tools/call` → `handleToolCall(name, args)`.
- **`handleToolCall`** is the big `if` chain — one branch per tool.
- **`ssh(remoteCmd, timeout)`** is the core transport. Wraps the command in `bash -l -c <quoted>` (login shell so conda/Slurm/modules load), runs `spawnSync('ssh', [...sshArgs(), wrappedCmd])`, returns `{stdout, stderr, status, error}`. One retry on `ETIMEDOUT`.
- **`sshWithStdin(remoteCmd, stdinData, timeout)`** — same, but pipes large input via stdin to avoid `ARG_MAX`. Used for `write_file`, `edit_file`.
- **`sshArgs()`** returns the ssh CLI args. Branches on `NO_MULTIPLEX`.

## SSH multiplexing (important)

Multiplexing is **off by default** — `NO_MULTIPLEX = process.env.MCP_SSH_MULTIPLEX !== '1'`. Many jump hosts permit only one session per TCP connection (e.g. magic-user auto-forward bastions where the username encodes the target: `user/target_ip/target_user`). With multiplexing on, call #1 works, call #2+ hit `Session open refused by peer`, ssh client falls back to fresh connection per call, stderr noise leaks into every response, and under load the fresh connections flake.

With `NO_MULTIPLEX=true`:
- `startControlMaster`, `stopControlMaster`, `ensureConnection` short-circuit return.
- `sshArgs()` returns `ControlMaster=no ControlPath=none`.
- Each call opens a fresh SSH connection. Correct and reliable.

With `MCP_SSH_MULTIPLEX=1` (opt in):
- `startControlMaster` opens a `-N -f` ControlMaster at `os.tmpdir()/mcp-ssh-remote/ctrl-<HOST>` on boot.
- `ensureConnection` runs `ssh -O check` before each call and respawns if dead.
- `stopControlMaster` runs on `exit`/`SIGINT`/`SIGTERM`.

## Adding a tool

1. Add an entry to the `TOOLS` array (name, description, `inputSchema`).
2. Add an `if (name === '...')` branch in `handleToolCall`.
3. Return `{content: [{type: 'text', text: ...}]}` on success, add `isError: true` on failure.

Shell-quote user-provided strings that end up in a remote command with `shellQuote()`; quote paths with `safePath()`. Prefer `sshWithStdin` over building a huge command string.

## Commit style

See `git log` for tone — short imperative title, blank line, brief body explaining *why*.

Release flow (after a behavior-changing commit): bump `version` in `package.json` if you intend to publish; otherwise leave it.

## Don't

- Don't add a Node SSH library (`ssh2`, `node-ssh`). The whole point of this server is to delegate to the system `ssh` binary so it inherits the user's SSH config.
- Don't add backoff/retry loops on top of `ssh()`. It already retries once on `ETIMEDOUT`; stacking more retries hides real failures.
- Don't log to stdout — stdout is the JSON-RPC channel. Warnings go to `process.stderr.write`.
