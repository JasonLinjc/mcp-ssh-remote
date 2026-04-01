#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const readline = require('readline');

// Parse --host from CLI arguments
const argv = process.argv.slice(2);
const hostIdx = argv.indexOf('--host');
const HOST = hostIdx !== -1 ? argv[hostIdx + 1] : null;
if (!HOST) {
  process.stderr.write('Error: --host <hostname> is required\n');
  process.stderr.write('Usage: mcp-ssh-remote --host <hostname>\n');
  process.exit(1);
}

const SSH_TIMEOUT = 30;

function ssh(remoteCmd) {
  const result = spawnSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_TIMEOUT}`,
    HOST,
    remoteCmd
  ], { encoding: 'utf8', timeout: (SSH_TIMEOUT + 5) * 1000 });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
    error:  result.error?.message ?? null
  };
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const TOOLS = [
  {
    name: 'execute_command',
    description: `Run a shell command on ${HOST} and return stdout/stderr`,
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute' } },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: `Read the contents of a file on ${HOST}`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the remote file' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: `Write text content to a file on ${HOST}`,
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Absolute path to the remote file' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_directory',
    description: `List files in a directory on ${HOST}`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to directory' } },
      required: ['path']
    }
  }
];

function handleToolCall(name, args) {
  if (name === 'execute_command') {
    const r = ssh(args.command);
    const out = r.error
      ? `ERROR: ${r.error}\nstderr: ${r.stderr}`
      : (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ''));
    return { content: [{ type: 'text', text: out || '(no output)' }] };
  }

  if (name === 'read_file') {
    const safePath = args.path.replace(/'/g, "'\\''");
    const r = ssh(`cat '${safePath}'`);
    if (r.error || r.status !== 0)
      return { content: [{ type: 'text', text: `Error reading file: ${r.stderr || r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout }] };
  }

  if (name === 'write_file') {
    // Base64-encode content to safely transfer arbitrary text through two shell layers
    const b64 = Buffer.from(args.content, 'utf8').toString('base64');
    const safePath = args.path.replace(/'/g, "'\\''");
    const r = ssh(`echo '${b64}' | base64 -d > '${safePath}'`);
    if (r.error || r.status !== 0)
      return { content: [{ type: 'text', text: `Error writing file: ${r.stderr || r.error}` }], isError: true };
    return { content: [{ type: 'text', text: `Written to ${args.path}` }] };
  }

  if (name === 'list_directory') {
    const safePath = args.path.replace(/'/g, "'\\''");
    const r = ssh(`ls -la '${safePath}'`);
    if (r.error || r.status !== 0)
      return { content: [{ type: 'text', text: `Error listing directory: ${r.stderr || r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

function dispatch(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-ssh-remote', version: '1.0.0' }
    });
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    return respond(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    try {
      return respond(id, handleToolCall(params.name, params.arguments ?? {}));
    } catch (e) {
      return respondError(id, -32603, e.message);
    }
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { return respondError(null, -32700, 'Parse error'); }
  dispatch(msg);
});
rl.on('close', () => process.exit(0));
