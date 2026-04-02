#!/usr/bin/env node
'use strict';

const { spawn, spawnSync, execSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Parse CLI arguments
const argv = process.argv.slice(2);
const hostIdx = argv.indexOf('--host');
const HOST = hostIdx !== -1 ? argv[hostIdx + 1] : null;
if (!HOST) {
  process.stderr.write('Error: --host <hostname> is required\n');
  process.stderr.write('Usage: mcp-ssh-remote --host <hostname>\n');
  process.exit(1);
}

// --- SSH ControlMaster multiplexing ---
const CONTROL_DIR = path.join(os.tmpdir(), 'mcp-ssh-remote');
const CONTROL_PATH = path.join(CONTROL_DIR, `ctrl-${HOST}`);
const SSH_TIMEOUT = 30;
const LONG_TIMEOUT = 600; // 10 minutes for long-running commands

try { fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 }); } catch {}

function startControlMaster() {
  // Check if a control socket already exists and is alive
  const check = spawnSync('ssh', ['-O', 'check', '-o', `ControlPath=${CONTROL_PATH}`, HOST],
    { encoding: 'utf8', timeout: 5000 });
  if (check.status === 0) return; // already running

  // Clean up stale socket
  try { fs.unlinkSync(CONTROL_PATH); } catch {}

  // Start a new ControlMaster in the background
  const result = spawnSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_TIMEOUT}`,
    '-o', 'ControlMaster=yes',
    '-o', `ControlPath=${CONTROL_PATH}`,
    '-o', 'ControlPersist=600',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-N', '-f',
    HOST
  ], { encoding: 'utf8', timeout: (SSH_TIMEOUT + 5) * 1000 });

  if (result.status !== 0) {
    process.stderr.write(`Warning: ControlMaster failed: ${result.stderr}\n`);
  }
}

function stopControlMaster() {
  spawnSync('ssh', ['-O', 'exit', '-o', `ControlPath=${CONTROL_PATH}`, HOST],
    { encoding: 'utf8', timeout: 5000 });
}

// Start multiplexed connection on boot
startControlMaster();
process.on('exit', stopControlMaster);
process.on('SIGINT', () => { stopControlMaster(); process.exit(0); });
process.on('SIGTERM', () => { stopControlMaster(); process.exit(0); });

function sshArgs() {
  return [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_TIMEOUT}`,
    '-o', `ControlPath=${CONTROL_PATH}`,
    '-o', 'ControlMaster=auto',
    HOST
  ];
}

function ssh(remoteCmd, timeout = SSH_TIMEOUT) {
  // Wrap in login shell so ~/.bashrc / /etc/profile.d are sourced (Slurm, conda, etc.)
  const wrappedCmd = `bash -l -c ${shellQuote(remoteCmd)}`;
  const result = spawnSync('ssh', [...sshArgs(), wrappedCmd],
    { encoding: 'utf8', timeout: (timeout + 5) * 1000 });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
    error: result.error?.message ?? null
  };
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Pipe content via stdin to avoid ARG_MAX limits
function sshWithStdin(remoteCmd, stdinData, timeout = SSH_TIMEOUT) {
  const wrappedCmd = `bash -l -c ${shellQuote(remoteCmd)}`;
  const result = spawnSync('ssh', [...sshArgs(), wrappedCmd], {
    input: stdinData,
    encoding: 'utf8',
    timeout: (timeout + 5) * 1000,
    maxBuffer: 50 * 1024 * 1024 // 50MB
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
    error: result.error?.message ?? null
  };
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function safePath(p) {
  return p.replace(/'/g, "'\\''");
}

const TOOLS = [
  {
    name: 'execute_command',
    description: `Run a shell command on ${HOST} and return stdout/stderr`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 600)' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: `Read the contents of a file on ${HOST}. Supports offset/limit for large files.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the remote file' },
        offset: { type: 'number', description: 'Start reading from this line number (1-based)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: `Write text content to a file on ${HOST} (creates parent dirs if needed)`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the remote file' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: `Replace a unique string in a file on ${HOST}. old_string must match exactly once.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the remote file' },
        old_string: { type: 'string', description: 'The exact text to find (must be unique in the file)' },
        new_string: { type: 'string', description: 'The replacement text' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_directory',
    description: `List files in a directory on ${HOST}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to directory' }
      },
      required: ['path']
    }
  },
  {
    name: 'grep_files',
    description: `Search file contents on ${HOST} using grep. Returns matching lines with file paths and line numbers.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in' },
        include: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.py")' },
        max_results: { type: 'number', description: 'Maximum number of matching lines (default 100)' },
        case_insensitive: { type: 'boolean', description: 'Case insensitive search (default false)' }
      },
      required: ['pattern', 'path']
    }
  },
  {
    name: 'glob_files',
    description: `Find files by glob pattern on ${HOST}`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.py")' },
        path: { type: 'string', description: 'Base directory to search from' }
      },
      required: ['pattern', 'path']
    }
  },
  // --- Slurm tools ---
  {
    name: 'slurm_status',
    description: `Show Slurm job queue for current user on ${HOST}. Lists running and pending jobs.`,
    inputSchema: {
      type: 'object',
      properties: {
        all_users: { type: 'boolean', description: 'Show jobs from all users (default: current user only)' }
      }
    }
  },
  {
    name: 'slurm_submit',
    description: `Submit a Slurm batch job on ${HOST}. Provide either a script path or inline script content.`,
    inputSchema: {
      type: 'object',
      properties: {
        script_path: { type: 'string', description: 'Absolute path to an existing .sh script to submit' },
        script_content: { type: 'string', description: 'Inline bash script content (will be written to a temp file and submitted)' },
        partition: { type: 'string', description: 'Slurm partition (e.g. gpu31, gpu33)' },
        job_name: { type: 'string', description: 'Job name' },
        gpus: { type: 'number', description: 'Number of GPUs to request' },
        nodes: { type: 'number', description: 'Number of nodes' },
        time: { type: 'string', description: 'Time limit (e.g. "24:00:00")' },
        extra_args: { type: 'string', description: 'Additional sbatch arguments (e.g. "--mem=64G --cpus-per-task=8")' }
      }
    }
  },
  {
    name: 'slurm_cancel',
    description: `Cancel a Slurm job on ${HOST}`,
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Slurm job ID to cancel' }
      },
      required: ['job_id']
    }
  },
  {
    name: 'slurm_job_info',
    description: `Get detailed info about a Slurm job on ${HOST} (running, pending, or recently completed)`,
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Slurm job ID' }
      },
      required: ['job_id']
    }
  },
  {
    name: 'slurm_log',
    description: `Read the stdout/stderr log of a Slurm job on ${HOST}. Shows the tail by default.`,
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Slurm job ID' },
        lines: { type: 'number', description: 'Number of lines from the end (default 100)' },
        stderr: { type: 'boolean', description: 'Read stderr log instead of stdout (default false)' }
      },
      required: ['job_id']
    }
  },
  // --- Sync tools ---
  {
    name: 'rsync_to_remote',
    description: `Rsync a local directory to ${HOST}. Uses the same SSH connection (bastion-aware).`,
    inputSchema: {
      type: 'object',
      properties: {
        local_path: { type: 'string', description: 'Local directory to sync from' },
        remote_path: { type: 'string', description: 'Remote directory to sync to' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Patterns to exclude (e.g. ["__pycache__", ".git", "*.pyc", "wandb"])' },
        dry_run: { type: 'boolean', description: 'Preview changes without syncing (default false)' },
        delete: { type: 'boolean', description: 'Delete remote files not present locally (default false)' }
      },
      required: ['local_path', 'remote_path']
    }
  },
  {
    name: 'git_pull_remote',
    description: `Pull latest git changes in a remote directory on ${HOST}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Remote git repo directory' },
        branch: { type: 'string', description: 'Branch to pull (default: current)' }
      },
      required: ['path']
    }
  }
];

function handleToolCall(name, args) {
  // --- execute_command ---
  if (name === 'execute_command') {
    const timeout = Math.min(args.timeout || SSH_TIMEOUT, LONG_TIMEOUT);
    const r = ssh(args.command, timeout);
    const out = r.error
      ? `ERROR: ${r.error}\nstderr: ${r.stderr}`
      : (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ''));
    return { content: [{ type: 'text', text: out || '(no output)' }] };
  }

  // --- read_file ---
  if (name === 'read_file') {
    const sp = safePath(args.path);
    let cmd;
    if (args.offset && args.limit) {
      cmd = `sed -n '${args.offset},${args.offset + args.limit - 1}p' '${sp}' | cat -n`;
    } else if (args.offset) {
      cmd = `tail -n +${args.offset} '${sp}' | cat -n`;
    } else if (args.limit) {
      cmd = `head -n ${args.limit} '${sp}' | cat -n`;
    } else {
      cmd = `cat -n '${sp}'`;
    }
    const r = ssh(cmd, 60);
    if (r.error || r.status !== 0)
      return { content: [{ type: 'text', text: `Error reading file: ${r.stderr || r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout }] };
  }

  // --- write_file ---
  if (name === 'write_file') {
    const sp = safePath(args.path);
    const dir = safePath(path.posix.dirname(args.path));
    // Pipe via stdin to handle large files and special characters
    const r = sshWithStdin(`mkdir -p '${dir}' && cat > '${sp}'`, args.content, 120);
    if (r.error || r.status !== 0)
      return { content: [{ type: 'text', text: `Error writing file: ${r.stderr || r.error}` }], isError: true };
    return { content: [{ type: 'text', text: `Written to ${args.path}` }] };
  }

  // --- edit_file ---
  if (name === 'edit_file') {
    const sp = safePath(args.path);

    // First check the old_string occurs exactly once
    const countR = sshWithStdin(
      `python3 -c "
import sys
content = open('${sp}', 'r').read()
old = sys.stdin.read()
count = content.count(old)
print(count)
"`, args.old_string, 30);

    if (countR.error || countR.status !== 0)
      return { content: [{ type: 'text', text: `Error: ${countR.stderr || countR.error}` }], isError: true };

    const count = parseInt(countR.stdout.trim(), 10);
    if (count === 0)
      return { content: [{ type: 'text', text: `Error: old_string not found in ${args.path}` }], isError: true };
    if (count > 1)
      return { content: [{ type: 'text', text: `Error: old_string found ${count} times in ${args.path} (must be unique)` }], isError: true };

    // Perform the replacement using python to handle multiline and special chars safely
    const editPayload = JSON.stringify({ old: args.old_string, new: args.new_string });
    const editR = sshWithStdin(
      `python3 -c "
import sys, json
data = json.load(sys.stdin)
content = open('${sp}', 'r').read()
content = content.replace(data['old'], data['new'], 1)
open('${sp}', 'w').write(content)
print('OK')
"`, editPayload, 30);

    if (editR.error || editR.status !== 0)
      return { content: [{ type: 'text', text: `Error editing file: ${editR.stderr || editR.error}` }], isError: true };
    return { content: [{ type: 'text', text: `Edited ${args.path}` }] };
  }

  // --- list_directory ---
  if (name === 'list_directory') {
    const sp = safePath(args.path);
    const r = ssh(`ls -la '${sp}'`);
    if (r.error || r.status !== 0)
      return { content: [{ type: 'text', text: `Error listing directory: ${r.stderr || r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout }] };
  }

  // --- grep_files ---
  if (name === 'grep_files') {
    const sp = safePath(args.path);
    const maxResults = args.max_results || 100;
    const flags = ['-rn', '--color=never'];
    if (args.case_insensitive) flags.push('-i');
    if (args.include) flags.push(`--include='${args.include}'`);
    const r = ssh(`grep ${flags.join(' ')} '${safePath(args.pattern)}' '${sp}' | head -n ${maxResults}`, 60);
    if (r.error)
      return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
    if (r.status === 1)
      return { content: [{ type: 'text', text: 'No matches found.' }] };
    if (r.status !== 0 && r.status !== 1)
      return { content: [{ type: 'text', text: `Error: ${r.stderr}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout || 'No matches found.' }] };
  }

  // --- glob_files ---
  if (name === 'glob_files') {
    const sp = safePath(args.path);
    const pattern = safePath(args.pattern);
    const r = ssh(`find '${sp}' -path '${pattern}' -type f 2>/dev/null | head -n 200`, 60);
    if (r.error || r.status !== 0)
      return { content: [{ type: 'text', text: `Error: ${r.stderr || r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout || 'No files found.' }] };
  }

  // --- slurm_status ---
  if (name === 'slurm_status') {
    const userFlag = args.all_users ? '' : '-u $USER';
    const r = ssh(`squeue ${userFlag} -o "%.10i %.12P %.30j %.8u %.2t %.12M %.6D %R" 2>&1`, 30);
    if (r.error)
      return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout + (r.stderr ? `\n${r.stderr}` : '') }] };
  }

  // --- slurm_submit ---
  if (name === 'slurm_submit') {
    let scriptPath = args.script_path;

    // If inline content provided, write it to a temp file
    if (!scriptPath && args.script_content) {
      const tmpPath = `/tmp/mcp_sbatch_${Date.now()}.sh`;
      const writeR = sshWithStdin(`cat > '${tmpPath}' && chmod +x '${tmpPath}'`, args.script_content, 15);
      if (writeR.error || writeR.status !== 0)
        return { content: [{ type: 'text', text: `Error writing script: ${writeR.stderr || writeR.error}` }], isError: true };
      scriptPath = tmpPath;
    }

    if (!scriptPath)
      return { content: [{ type: 'text', text: 'Error: provide either script_path or script_content' }], isError: true };

    const sbatchArgs = [];
    if (args.partition) sbatchArgs.push(`-p ${args.partition}`);
    if (args.job_name) sbatchArgs.push(`-J ${args.job_name}`);
    if (args.gpus) sbatchArgs.push(`--gres=gpu:${args.gpus}`);
    if (args.nodes) sbatchArgs.push(`-N ${args.nodes}`);
    if (args.time) sbatchArgs.push(`-t ${args.time}`);
    if (args.extra_args) sbatchArgs.push(args.extra_args);

    const r = ssh(`sbatch ${sbatchArgs.join(' ')} '${safePath(scriptPath)}' 2>&1`, 30);
    if (r.error)
      return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout + (r.stderr ? `\n${r.stderr}` : '') }] };
  }

  // --- slurm_cancel ---
  if (name === 'slurm_cancel') {
    const r = ssh(`scancel ${args.job_id} 2>&1`, 15);
    if (r.error)
      return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout || `Cancelled job ${args.job_id}` }] };
  }

  // --- slurm_job_info ---
  if (name === 'slurm_job_info') {
    const r = ssh(`scontrol show job ${args.job_id} 2>&1`, 15);
    if (r.error)
      return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout + (r.stderr ? `\n${r.stderr}` : '') }] };
  }

  // --- slurm_log ---
  if (name === 'slurm_log') {
    const lines = args.lines || 100;
    // First find the log file path from job info
    const infoR = ssh(`scontrol show job ${args.job_id} 2>&1`, 15);
    if (infoR.error)
      return { content: [{ type: 'text', text: `Error: ${infoR.error}` }], isError: true };

    const field = args.stderr ? 'StdErr' : 'StdOut';
    const match = infoR.stdout.match(new RegExp(`${field}=(.+?)(?:\\s|$)`));
    if (!match)
      return { content: [{ type: 'text', text: `Could not find ${field} path for job ${args.job_id}. Job info:\n${infoR.stdout}` }] };

    const logPath = match[1].trim();
    const r = ssh(`tail -n ${lines} '${safePath(logPath)}' 2>&1`, 60);
    if (r.error)
      return { content: [{ type: 'text', text: `Error reading log: ${r.error}` }], isError: true };
    return { content: [{ type: 'text', text: `=== ${field}: ${logPath} (last ${lines} lines) ===\n${r.stdout}` }] };
  }

  // --- rsync_to_remote ---
  if (name === 'rsync_to_remote') {
    const localPath = args.local_path.endsWith('/') ? args.local_path : args.local_path + '/';
    const remoteDest = `${HOST}:${args.remote_path}`;

    const rsyncArgs = [
      '-avz',
      '-e', `ssh -o BatchMode=yes -o ConnectTimeout=${SSH_TIMEOUT} -o ControlPath=${CONTROL_PATH} -o ControlMaster=auto`
    ];

    if (args.dry_run) rsyncArgs.push('--dry-run');
    if (args.delete) rsyncArgs.push('--delete');
    if (args.exclude) {
      for (const pattern of args.exclude) {
        rsyncArgs.push('--exclude', pattern);
      }
    }
    rsyncArgs.push(localPath, remoteDest);

    const result = spawnSync('rsync', rsyncArgs, {
      encoding: 'utf8',
      timeout: LONG_TIMEOUT * 1000,
      maxBuffer: 50 * 1024 * 1024
    });

    if (result.error)
      return { content: [{ type: 'text', text: `Error: ${result.error.message}` }], isError: true };
    if (result.status !== 0)
      return { content: [{ type: 'text', text: `rsync failed (exit ${result.status}):\n${result.stderr}` }], isError: true };

    const prefix = args.dry_run ? '[DRY RUN] ' : '';
    return { content: [{ type: 'text', text: `${prefix}Synced ${args.local_path} → ${HOST}:${args.remote_path}\n${result.stdout}` }] };
  }

  // --- git_pull_remote ---
  if (name === 'git_pull_remote') {
    const sp = safePath(args.path);
    const branch = args.branch ? ` origin ${args.branch}` : '';
    const r = ssh(`cd '${sp}' && git pull${branch} 2>&1`, 60);
    if (r.error)
      return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
    return { content: [{ type: 'text', text: r.stdout + (r.stderr ? `\n${r.stderr}` : '') }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

function dispatch(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-ssh-remote', version: '2.0.0' }
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
