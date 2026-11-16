/** Workspace tools for Pi Agent. Mutations and shell execution require per-call approval. */
import { readFile, readdir, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { spawn } from 'node:child_process';

export async function workspacePath(root, path = '.', write = false) {
  if (typeof path !== 'string' || path.length > 2000 || isAbsolute(path) || path.includes('\0')) throw new Error('Use a relative workspace path.');
  const base = await realpath(root), target = resolve(base, path);
  const inside = value => { const r = relative(base, value); return !isAbsolute(r) && r !== '..' && !r.startsWith('..\\') && !r.startsWith('../'); };
  if (!inside(target)) throw new Error('The path must stay inside this conversation’s workspace.');
  let current = target;
  while (true) {
    try { if (!inside(await realpath(current))) throw new Error('Symlinks must stay inside the workspace.'); break; }
    catch (error) { if (!write || error.code !== 'ENOENT') throw error; current = dirname(current); }
  }
  return target;
}
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = description => ({ type: 'string', description });
const result = value => ({ content: [{ type: 'text', text: value }], details: {} });
export function workspaceTools(root) {
  return [
    { name: 'list_files', label: 'List files', description: 'List a directory inside this conversation’s workspace. Use . for the root.',
      parameters: schema({ path: text('Relative directory path, or .') }),
      async execute(_id, args) {
        const path = await workspacePath(root, args.path);
        const rows = await readdir(path, { withFileTypes: true });
        return result(rows.slice(0, 300).map(row => `${row.isDirectory() ? 'directory' : row.isSymbolicLink() ? 'link' : 'file'}\t${row.name}`).join('\n') || '(empty directory)');
      } },
    { name: 'read_file', label: 'Read file', description: 'Read a UTF-8 text file from this conversation’s workspace (up to 512 KB).',
      parameters: schema({ path: text('Relative file path') }),
      async execute(_id, args) {
        const path = await workspacePath(root, args.path);
        if ((await stat(path)).size > 512 * 1024) throw new Error('File is larger than 512 KB.');
        const value = await readFile(path, 'utf8');
        if (value.includes('\0')) throw new Error('This is a binary file, not UTF-8 text.');
        return result(value);
      } },
    { name: 'write_file', label: 'Write file', description: 'Write a UTF-8 file inside the workspace. Requires user approval; overwrites existing content.',
      executionMode: 'sequential', parameters: schema({ path: text('Relative file path'), content: text('Complete file contents') }),
      async execute(_id, args, signal) {
        signal?.throwIfAborted();
        if (Buffer.byteLength(args.content) > 2 * 1024 * 1024) throw new Error('Files are limited to 2 MB per write.');
        const path = await workspacePath(root, args.path, true);
        await mkdir(dirname(path), { recursive: true });
        await workspacePath(root, args.path, true);
        await writeFile(path, args.content, { encoding: 'utf8', signal });
        return result('Saved ' + args.path);
      } },
    { name: 'run_command', label: 'Run command', description: 'Run a shell command from the workspace, with user approval. NOT a security sandbox: the shell has the user’s permissions. Timeout: 60 seconds.',
      executionMode: 'sequential', parameters: schema({ command: text('Shell command to execute') }),
      async execute(_id, args, signal, onUpdate) {
        if (args.command.length > 12000) throw new Error('Command is too long.');
        return result(await runCommand(args.command, root, signal, onUpdate));
      } },
  ];
}
export function runCommand(command, cwd, signal, onUpdate) {
  return new Promise((accept, reject) => {
    signal?.throwIfAborted();
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : '/bin/bash', windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command], {
      cwd, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', truncated = false, lastUpdate = 0, settled = false;
    const stop = () => {
      if (!child.pid) return;
      if (windows) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(stop, 60000);
    signal?.addEventListener('abort', stop, { once: true });
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
      const value = (truncated ? '[Output truncated to the last 32 KB]\n' : '') + output;
      if (signal?.aborted) reject(new Error('Command stopped.'));
      else if (error) reject(new Error(error + (value ? '\n' + value : '')));
      else accept(value || '(no output)');
    };
    const collect = chunk => {
      output += chunk.toString(); if (output.length > 32768) { output = output.slice(-32768); truncated = true; }
      if (Date.now() - lastUpdate > 250) { lastUpdate = Date.now(); onUpdate?.(result(output)); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => finish(error.message));
    child.once('close', code => finish(code === 0 ? null : 'Command exited with code ' + code));
  });
}
