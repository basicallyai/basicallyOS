import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFolderPicker, folderDialogs } from '../folder-picker.mjs';
import { fixture } from './helpers.mjs';

function child({ code = 0, out = '', err = '', error = null } = {}) {
  const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); process.kill = () => {};
  queueMicrotask(() => {
    if (error) { process.emit('error', error); return; }
    if (out) process.stdout.emit('data', Buffer.from(out));
    if (err) process.stderr.emit('data', Buffer.from(err));
    process.emit('close', code);
  });
  return process;
}
function fakeSpawn(handler) { const calls = []; return { calls, spawn: (command, args, options) => { calls.push({ command, args, options }); return handler(command, args); } }; }

test('native folder picker uses fixed OS dialogs without shell interpolation', () => {
  const windows = folderDialogs('win32'); assert.equal(windows[0].command, 'powershell.exe'); assert.ok(windows[0].args.includes('-STA')); assert.match(windows[0].args[3], /System\.Windows\.Forms\.OpenFileDialog/); assert.match(windows[0].args[3], /This folder\.folder/); assert.match(windows[0].args[3], /GetDirectoryName/); assert.doesNotMatch(windows[0].args.join(' '), /;\s*rm /);
  const mac = folderDialogs('darwin'); assert.equal(mac[0].command, 'osascript'); assert.match(mac[0].args.join(' '), /choose folder/);
  assert.deepEqual(folderDialogs('linux').map(row => row.command), ['zenity', 'kdialog']);
});

test('picker returns a chosen folder and treats cancellation as no selection', async () => {
  const chosen = fakeSpawn(() => child({ out: 'C:\\Work\\Notes\r\n' })), picker = createFolderPicker({ platform: 'win32', spawnFn: chosen.spawn });
  assert.deepEqual(await picker.pick(), { path: 'C:\\Work\\Notes' }); assert.equal(chosen.calls[0].options.shell, false);
  const cancelled = createFolderPicker({ platform: 'win32', spawnFn: fakeSpawn(() => child({ out: '__BASICALLY_CANCELLED__' })).spawn });
  assert.deepEqual(await cancelled.pick(), { cancelled: true });
});

test('Linux falls back to kdialog only when zenity is unavailable and reports failures', async () => {
  const calls = []; const picker = createFolderPicker({ platform: 'linux', spawnFn: (command, args) => { calls.push(command); const missing = Object.assign(new Error('missing'), { code: 'ENOENT' }); return child(command === 'zenity' ? { error: missing } : { out: '/home/user/Notes\n' }); } });
  assert.deepEqual(await picker.pick(), { path: '/home/user/Notes' }); assert.deepEqual(calls, ['zenity', 'kdialog']);
  const unavailable = createFolderPicker({ platform: 'linux', spawnFn: () => child({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }) });
  await assert.rejects(unavailable.pick(), /zenity or kdialog/);
  const failed = createFolderPicker({ platform: 'win32', spawnFn: () => child({ code: 1, err: 'dialog failed' }) });
  await assert.rejects(failed.pick(), /dialog failed/);
});

test('native picker endpoint is authenticated and attaches only after explicit selection', async () => {
  let result = { path: null }, calls = 0;
  const fix = await fixture({ folderPicker: { pick: async () => { calls++; return result; } } });
  try {
    const none = await fix.request('/api/workspaces/browse', {}); assert.deepEqual(none, { path: null }); assert.equal((await fix.request('/api/workspaces')).workspaces.length, 1);
    result = { cancelled: true }; assert.deepEqual(await fix.request('/api/workspaces/browse', {}), { cancelled: true }); assert.equal(calls, 2);
    result = { path: fix.directory }; assert.deepEqual(await fix.request('/api/workspaces/browse', {}), { path: fix.directory }); assert.equal((await fix.request('/api/workspaces')).workspaces.length, 1, 'browse never authorizes by itself');
    const unauthorised = await fetch(fix.app.address + '/api/workspaces/browse', { method: 'POST', headers: { Origin: fix.app.address } }); assert.equal(unauthorised.status, 401);
  } finally { await fix.close(); }
});
