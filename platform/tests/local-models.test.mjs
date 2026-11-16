import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { LocalWorker } from '../local-worker.mjs';

async function complete(fix, id) { return waitFor(async () => { const chat = await fix.request('/api/chats/' + id); return !chat.running && chat.cost.calls ? chat : false; }); }

test('trusted local loading and naming use authenticated routes and preserve the explicit trust choice', async t => {
  const requests = [];
  const fix = await fixture({ local: { request: async (path, body) => { requests.push({ path, body }); return { phase: 'ready', model: 'folder-id', displayName: body?.name || 'My local model', models: [] }; }, close: async () => {} } }); t.after(() => fix.close());
  await fix.request('/api/local/load', { id: 'folder-id', device: 'cpu', trust: true });
  assert.deepEqual(requests[0], { path: '/load', body: { id: 'folder-id', device: 'cpu', trust: true } });
  await fix.request('/api/local/name', { id: 'folder-id', name: 'My tiny model' });
  assert.deepEqual(requests[1], { path: '/name', body: { id: 'folder-id', name: 'My tiny model' } });
  const unauthenticated = await fetch(fix.app.address + '/api/local/name', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fix.app.address }, body: '{}' });
  assert.equal(unauthenticated.status, 401); assert.equal(requests.length, 2);
});

test('local connection uses the configured display name and actual worker limits, never invented 32k context', async () => {
  const worker = new LocalWorker('.'); worker.port = 1234;
  worker.request = async () => ({ phase: 'ready', model: 'folder-id', displayName: 'My tiny model', contextWindow: 384, maxTokens: 96 });
  const connection = await worker.connection();
  assert.equal(connection.models[0].name, 'My tiny model'); assert.equal(connection.models[0].id, 'local-model'); assert.equal(connection.models[0].contextWindow, 384); assert.equal(connection.models[0].maxTokens, 96);
  worker.request = async () => ({ phase: 'ready', model: 'folder-id' });
  await assert.rejects(worker.connection(), /verified context/);
});

test('complete custom model imports retain Python source as inert bytes and reject other executable files', async t => {
  const fix = await fixture(); t.after(() => fix.close());
  const data = new FormData();
  const code = 'raise RuntimeError("must not execute during upload")';
  for (const [name, text] of [['custom/config.json', '{"model_type":"custom","auto_map":{"AutoConfig":"configuration_custom.Config"}}'], ['custom/tokenizer.json', '{}'], ['custom/model.safetensors', 'weights'], ['custom/configuration_custom.py', code]]) data.append('files', new Blob([text]), name);
  const response = await fetch(fix.app.address + '/api/local/upload', { method: 'POST', headers: { Cookie: fix.cookie, Origin: fix.app.address }, body: data });
  assert.equal(response.status, 201); const result = await response.json();
  assert.equal(await readFile(join(fix.directory, 'local-models', result.id, 'configuration_custom.py'), 'utf8'), code);
  await access(join(fix.directory, 'local-models', result.id, 'model.safetensors'));
  const bad = new FormData(); bad.append('files', new Blob(['executable']), 'run.exe');
  assert.equal((await fetch(fix.app.address + '/api/local/upload', { method: 'POST', headers: { Cookie: fix.cookie, Origin: fix.app.address }, body: bad })).status, 400);
});

test('real Pi responses persist actual output-token speed and configured display name across refresh/export/import', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock), chat = await fix.request('/api/chats', { selection });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Hello.' });
  let view = await complete(fix, chat.id), message = view.messages.find(row => row.role === 'assistant');
  assert.equal(message.displayName, 'Test model'); assert.equal(message.performance.outputTokens, 20); assert.equal(message.performance.basis, 'request-to-completion');
  assert.ok(message.performance.elapsedMs > 0); assert.equal(message.performance.tokensPerSecond, 20 / (message.performance.elapsedMs / 1000));
  assert.deepEqual((await fix.request('/api/chats/' + chat.id)).messages.find(row => row.role === 'assistant').performance, message.performance);
  const original = structuredClone(message.performance), backup = await fix.request('/api/chats/' + chat.id + '/export');
  const imported = await fix.request('/api/chats/import', backup), restored = await fix.request('/api/chats/' + imported.imported[0].id);
  assert.deepEqual(restored.messages.find(row => row.role === 'assistant').performance, original);
  const malformed = structuredClone(backup); malformed.entries[0].chat.messages.find(row => row.role === 'assistant').performance.elapsedMs = -1;
  await assert.rejects(fix.request('/api/chats/import', malformed), /speed measurement/);
  await fix.request('/api/chats/' + chat.id + '/regenerate', {}); await waitFor(() => !fix.app.runtime.active.size);
  view = await fix.request('/api/chats/' + chat.id); message = view.messages.find(row => row.role === 'assistant'); assert.ok(message.performance.elapsedMs > 0);
  assert.deepEqual((await fix.app.store.chat(chat.id)).revisions[0].messages.find(row => row.role === 'assistant').performance, original);
});

test('missing usage and interrupted responses never receive fabricated speed measurements', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const missing = await connect(fix, mock, { id: 'missing', model: 'no-usage' }), chat = await fix.request('/api/chats', { selection: missing });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'No invented speed.' });
  assert.equal((await complete(fix, chat.id)).messages.find(row => row.role === 'assistant').performance, null);
  const slow = await connect(fix, mock, { id: 'slow', model: 'slow' }), stopped = await fix.request('/api/chats', { selection: slow });
  await fix.request('/api/chats/' + stopped.id + '/messages', { text: 'Stop this.' });
  await waitFor(async () => (await fix.request('/api/chats/' + stopped.id)).partial);
  await fix.request('/api/chats/' + stopped.id + '/stop', {});
  assert.equal((await fix.request('/api/chats/' + stopped.id)).messages.find(row => row.role === 'assistant').performance, null);
});
