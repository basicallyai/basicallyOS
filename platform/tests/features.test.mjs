import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';

const idle = (fix, id) => waitFor(async () => { const chat = await fix.request('/api/chats/' + id); return !chat.running && chat.cost.calls ? chat : false; });
async function upload(fix, files) {
  const data = new FormData(); for (const [name, content] of files) data.append('files', new Blob([content]), name);
  const response = await fetch(fix.app.address + '/api/local/upload', { method: 'POST', headers: { Cookie: fix.cookie, Origin: fix.app.address }, body: data });
  return { status: response.status, data: await response.json() };
}
test('shared MEMORY.md is durable, conflict checked, and refreshed on every message', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const memory = await fix.request('/api/memory'); assert.match(memory.path, /MEMORY\.md$/);
  const saved = await fix.request('/api/memory', { content: '# Memory\nUse concise answers.', revision: memory.revision }, 'PUT');
  await assert.rejects(fix.request('/api/memory', { content: 'stale', revision: memory.revision }, 'PUT'), /changed/);
  const selection = await connect(fix, mock), chat = await fix.request('/api/chats', { selection });
  await fix.request('/api/chats/' + chat.id, { instructions: 'Speak plainly.' }, 'PATCH');
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Hello' }); await idle(fix, chat.id);
  assert.match(JSON.stringify(mock.requests[0].body.messages), /concise answers/); assert.match(JSON.stringify(mock.requests[0].body.messages), /Speak plainly/);
  await fix.request('/api/memory', { content: '# Memory\nNew durable preference.', revision: saved.revision }, 'PUT');
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Next message' });
  await waitFor(() => !fix.app.runtime.active.has(chat.id));
  const system = mock.requests.at(-1).body.messages.filter(row => row.role === 'system' || row.role === 'developer');
  assert.match(JSON.stringify(system), /New durable preference/); assert.doesNotMatch(JSON.stringify(system), /Use concise answers/);
  assert.equal(await readFile(memory.path, 'utf8'), '# Memory\nNew durable preference.');
});

test('model memory writes require one-time approval; denial and concurrent edits are respected', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock, { model: 'memory' });
  for (const mode of ['deny', 'allow', 'conflict']) {
    const initial = await fix.request('/api/memory'), chat = await fix.request('/api/chats', { selection });
    await fix.request('/api/chats/' + chat.id + '/messages', { text: JSON.stringify({ content: '# Memory\nApproved preference: ' + mode, revision: initial.revision }) });
    const approval = await waitFor(async () => (await fix.request('/api/chats/' + chat.id)).approvals[0]);
    assert.equal(approval.tool, 'write_memory'); assert.equal((await fix.request('/api/memory')).content, initial.content);
    if (mode === 'conflict') await fix.request('/api/memory', { content: '# Memory\nUser wins.', revision: initial.revision }, 'PUT');
    await fix.request('/api/chats/' + chat.id + '/approve', { id: approval.id, allow: mode !== 'deny' });
    await idle(fix, chat.id);
    const actual = (await fix.request('/api/memory')).content;
    assert.equal(actual, mode === 'deny' ? initial.content : mode === 'allow' ? '# Memory\nApproved preference: allow' : '# Memory\nUser wins.');
  }
});

test('complete backup round trip retains transcripts, system history, revisions, usage and binary workspace files', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock), chat = await fix.request('/api/chats', { selection });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Unique searchable sentence', files: [{ name: 'notes.md', type: 'text/markdown', data: Buffer.from('# Attached').toString('base64') }] }); await idle(fix, chat.id);
  await fix.request('/api/chats/' + chat.id + '/regenerate', {}); await waitFor(() => !fix.app.runtime.active.has(chat.id));
  await fix.request('/api/chats/' + chat.id, { instructions: 'Remember this chat instruction.', pinned: true }, 'PATCH');
  const root = join(fix.directory, 'workspaces', chat.id); await mkdir(join(root, 'empty-dir')); await writeFile(join(root, '.private-note'), 'hidden file'); await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 255]));
  const backup = await fix.request('/api/chats/' + chat.id + '/export');
  assert.doesNotMatch(JSON.stringify(backup), /test-private-key/);
  const result = await fix.request('/api/chats/import', backup), importedId = result.imported[0].id;
  assert.notEqual(importedId, chat.id);
  const original = await fix.app.store.chat(chat.id), restored = await fix.app.store.chat(importedId);
  for (const key of ['messages', 'ledger', 'inputs', 'revisions', 'instructions', 'pinned', 'selection']) assert.deepEqual(restored[key], original[key], key);
  assert.deepEqual(await readFile(join(fix.directory, 'workspaces', importedId, 'binary.bin')), Buffer.from([0, 1, 255]));
  await access(join(fix.directory, 'workspaces', importedId, 'empty-dir'));
  const search = await fix.request('/api/chats?q=searchable%20sentence'); assert.equal(search.chats.length, 2); assert.ok(search.chats.every(row => row.snippet.includes('searchable')));
  const before = (await fix.request('/api/chats')).chats.length;
  for (const mutate of [copy => copy.entries[0].files.push({ path: '../escape.txt', data: '' }), copy => copy.entries[0].chat.messages.push({ role: 'untrusted-role', content: '' }), copy => copy.entries[0].chat.ledger[0].usd = -1, copy => copy.entries[0].files.push({ path: 'binary.bin/child', data: '' })]) {
    const bad = structuredClone(backup); mutate(bad); await assert.rejects(fix.request('/api/chats/import', bad));
    assert.equal((await fix.request('/api/chats')).chats.length, before);
  }
  await fix.request('/api/chats/' + importedId, undefined, 'DELETE');
  await assert.rejects(fix.app.store.chat(importedId), /not found/); await assert.rejects(access(join(fix.directory, 'workspaces', importedId)));
  assert.equal((await fix.app.store.chat(chat.id)).id, chat.id);
});

test('running chats cannot be deleted or exported; pins and per-chat settings are validated', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock, { model: 'slow' }), chat = await fix.request('/api/chats', { selection });
  await assert.rejects(fix.request('/api/chats/' + chat.id, { pinned: 'yes' }, 'PATCH'), /true or false/);
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Keep going' });
  await assert.rejects(fix.request('/api/chats/' + chat.id, undefined, 'DELETE'), /Stop/);
  await assert.rejects(fix.request('/api/chats/' + chat.id + '/export'), /Stop/);
  await assert.rejects(fix.request('/api/chats/' + chat.id, { instructions: 'changed' }, 'PATCH'), /Stop/);
  await fix.request('/api/chats/' + chat.id + '/stop', {});
});

test('local model imports accept Transformers repositories and reject GGUF/MLX or unsafe/incomplete data', async t => {
  const fix = await fixture(); t.after(() => fix.close());
  const root = join(fix.directory, 'local-models');
  let result = await upload(fix, [['my-model/config.json', '{"model_type":"test"}'], ['my-model/tokenizer.json', '{}'], ['my-model/model.safetensors', 'test-weights']]);
  assert.equal(result.status, 201); await access(join(root, result.data.id, 'config.json'));
  for (const files of [
    [['bad.gguf', 'not gguf']],
    [['../escape.gguf', 'GGUF']],
    [['evil.py', 'print(1)']],
    [['model.safetensors', 'missing config']],
    [['nul.gguf', 'GGUF']],
    [['duplicate.gguf', 'GGUF'], ['duplicate.gguf', 'GGUF']],
    [['mlx/config.json', '{"model_type":"llama","quantization":{"bits":4}}'], ['mlx/tokenizer.json', '{}'], ['mlx/model.safetensors', 'weights'], ['mlx/basically-model.json', '{"format":"mlx"}']],
  ]) {
    const response = await upload(fix, files); assert.equal(response.status, 400, JSON.stringify(response));
    assert.equal((await readdir(root)).filter(name => name.startsWith('.upload-')).length, 0);
  }
});

test('cancelled local model uploads remove partial files without adding a library entry', async t => {
  const fix = await fixture(); t.after(() => fix.close());
  const root = join(fix.directory, 'local-models');
  const request = httpRequest(fix.app.address + '/api/local/upload', { method: 'POST', headers: { Cookie: fix.cookie, Origin: fix.app.address, 'Content-Type': 'multipart/form-data; boundary=test-upload-boundary' } });
  request.on('error', () => {});
  request.write('--test-upload-boundary\r\nContent-Disposition: form-data; name="files"; filename="partial.safetensors"\r\nContent-Type: application/octet-stream\r\n\r\npartial-content');
  await waitFor(async () => { try { return (await readdir(root)).some(name => name.startsWith('.upload-')); } catch { return false; } });
  request.destroy();
  await waitFor(async () => (await readdir(root)).length === 0);
  assert.deepEqual((await fix.request('/api/bootstrap')).providers, []);
});

test('large binary files and archive state survive a complete backup round trip', async t => {
  const fix = await fixture(); t.after(() => fix.close());
  const chat = await fix.request('/api/chats', {}), root = join(fix.directory, 'workspaces', chat.id);
  await mkdir(root, { recursive: true }); const bytes = Buffer.alloc(6 * 1024 * 1024, 255); await writeFile(join(root, 'large.bin'), bytes);
  await fix.request('/api/chats/' + chat.id, { archived: true }, 'PATCH');
  const backup = await fix.request('/api/chats/export'); assert.equal(backup.entries.length, 1);
  const result = await fix.request('/api/chats/import', backup), id = result.imported[0].id;
  assert.equal(result.imported[0].archived, true); assert.equal((await fix.request('/api/chats')).chats.length, 0);
  assert.deepEqual(await readFile(join(fix.directory, 'workspaces', id, 'large.bin')), bytes);
  assert.equal((await fix.request('/api/chats?archived=1')).chats.length, 2);
  await fix.request('/api/chats/' + id, { archived: false }, 'PATCH'); assert.equal((await fix.request('/api/chats')).chats.length, 1);
});

test('model discovery can be requested before saving; icons come from the local Lucide sprite', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const result = await fix.request('/api/providers/discover', { baseUrl: mock.baseUrl, apiKey: 'unsaved-test-key' });
  assert.ok(result.models.some(row => row.id === 'test-model')); assert.deepEqual((await fix.request('/api/bootstrap')).providers, []);
  const response = await fetch(fix.app.address + '/icons.svg', { headers: { Cookie: fix.cookie } });
  assert.equal(response.status, 200); const svg = await response.text(); assert.match(svg, /symbol id="settings"/); assert.match(svg, /9\.671 4\.136/);
});
