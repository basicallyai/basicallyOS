import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile, mkdir, symlink, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { Store } from '../store.mjs';
import { normalizeProvider, normalizeModel, validateEndpoint } from '../providers.mjs';
import { workspacePath, workspaceTools } from '../tools.mjs';
import { accounting, totalCost } from '../runtime.mjs';

test('loopback token/cookie authorization, origins, rebinding and static isolation', async t => {
  const fix = await fixture(); t.after(() => fix.close());
  assert.equal((await fetch(fix.app.address + '/api/bootstrap')).status, 401);
  assert.equal((await fetch(fix.app.address + '/?token=wrong')).status, 401);
  const login = await fetch(fix.app.url, { redirect: 'manual' }); assert.equal(login.status, 200);
  const externalLaunch = await fetch(fix.app.url, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } }); assert.equal(externalLaunch.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(fix.app.address + '/api/bootstrap', { headers: { Cookie: fix.cookie, Origin: 'https://hostile.example' } })).status, 403);
  assert.equal((await fetch(fix.app.address + '/api/chats', { method: 'POST', headers: { Cookie: fix.cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(fix.app.address + '/api/bootstrap', { headers: { Cookie: fix.cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const rebound = await new Promise((accept, reject) => { const req = httpRequest(fix.app.address + '/api/bootstrap', { headers: { Host: 'hostile.example', Cookie: fix.cookie } }, res => { res.resume(); accept(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(rebound, 403);
  const html = await fetch(fix.app.address, { headers: { Cookie: fix.cookie } }); assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await html.text(), /Space to think/);
  for (const path of ['/package.json', '/.platform-home/app/connections.json', '/node_modules/openai/package.json', '/platform/server.mjs']) {
    assert.equal((await fetch(fix.app.address + path, { headers: { Cookie: fix.cookie } })).status, 404);
  }
});

test('API/model CRUD persists keys privately, preserves keys on edit, and supports manual unknown IDs', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock, { model: 'vendor/new-unlisted-model', cost: null });
  let bootstrap = await fix.request('/api/bootstrap'), provider = bootstrap.providers.find(row => row.id === selection.provider);
  assert.equal(provider.configured, true); assert.doesNotMatch(JSON.stringify(bootstrap), /test-private-key/);
  assert.equal(provider.models[0].cost, null); assert.equal(provider.models[0].id, 'vendor/new-unlisted-model');
  await fix.request('/api/providers', { ...provider, name: 'Renamed API', apiKey: '' });
  assert.equal(fix.app.store.config.providers.find(row => row.id === selection.provider).apiKey, 'test-private-key');
  const modelList = await fix.request('/api/providers/test/discover', {}); assert.equal(modelList.models.length, 2);
  const disk = await readFile(join(fix.directory, 'home/app/connections.json'), 'utf8'); assert.match(disk, /test-private-key/);
  const chat = await fix.request('/api/chats', { selection });
  await fix.request('/api/providers/test', undefined, 'DELETE');
  assert.equal((await fix.request('/api/chats/' + chat.id)).id, chat.id);
  await assert.rejects(fix.request('/api/chats/' + chat.id + '/messages', { text: 'Hello' }), /removed/);
});

test('provider and model validation never silently sends an old key to a new endpoint', () => {
  const body = { id: 'test', name: 'Test', api: 'openai-completions', baseUrl: 'https://first.example/v1', requiresKey: true, apiKey: 'private', models: [{ id: 'abc' }] };
  const previous = normalizeProvider(body);
  assert.throws(() => normalizeProvider({ ...body, baseUrl: 'https://second.example/v1', apiKey: '' }, previous), /Re-enter/);
  assert.equal(normalizeProvider({ ...body, baseUrl: 'https://second.example/v1', apiKey: '', clearKey: true }, previous).apiKey, '');
  assert.equal(normalizeProvider({ ...body, requiresKey: false }, previous).apiKey, '');
  for (const url of ['http://remote.example/v1', 'file:///tmp/model', 'https://user:key@api.example/v1', 'https://example.com/v1/chat/completions']) assert.throws(() => validateEndpoint(url));
  assert.equal(validateEndpoint('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
  assert.throws(() => normalizeModel({ id: 'bad model' }, 'test'));
  assert.throws(() => normalizeModel({ id: 'ok', cost: { input: -1, output: 1 } }, 'test'));
  assert.throws(() => normalizeModel({ id: 'ok', maxTokens: 500, contextWindow: 300 }, 'test'));
  assert.throws(() => normalizeProvider({ ...body, models: [{ id: 'same' }, { id: 'same' }] }));
  assert.equal(normalizeModel({ id: 'user-entered-model' }, 'custom').maxTokens, null);
});

test('atomic storage serializes concurrent changes, survives reopen, and archives without destroying history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'basically-store-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); await store.initialize();
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.updateConfig(config => ({ ...config, providers: [...config.providers, { id: String(index) }] }))));
  assert.equal(store.config.providers.length, 20);
  const chat = await store.createChat(); chat.messages.push({ role: 'user', content: 'Preserved', timestamp: Date.now() }); chat.archived = true; await store.saveChat(chat);
  const reopened = new Store(directory); await reopened.initialize(); assert.equal(reopened.config.providers.length, 20);
  assert.equal((await reopened.chat(chat.id)).messages[0].content, 'Preserved'); assert.equal((await reopened.list()).length, 0);
  await assert.rejects(reopened.chat('../../connections'), /Invalid/);
});

test('workspace paths reject traversal and escaping junctions; tools stay inside the declared workspace', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'basically-path-')), root = join(directory, 'workspace'), outside = join(directory, 'outside');
  t.after(() => rm(directory, { recursive: true, force: true })); await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'private');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspacePath(root, '../outside/secret.txt'), /inside/);
  await assert.rejects(workspacePath(root, 'escape/secret.txt'), /Symlinks/);
  await assert.rejects(workspacePath(root, 'escape/new.txt', true), /Symlinks/);
  const tools = workspaceTools(root); await tools.find(tool => tool.name === 'write_file').execute('call', { path: 'nested/file.txt', content: 'ok' });
  assert.equal((await tools.find(tool => tool.name === 'read_file').execute('call', { path: 'nested/file.txt' })).content[0].text, 'ok');
});

test('uploads are durable, model-visible and downloadable; unsupported/oversized attachments are rejected', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock), chat = await fix.request('/api/chats', { selection });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Read this.', files: [{ name: '../../example.txt', type: 'text/plain', data: Buffer.from('Uploaded context.').toString('base64') }] });
  await waitFor(() => !fix.app.runtime.active.has(chat.id));
  const view = await fix.request('/api/chats/' + chat.id), file = view.messages[0].files[0];
  assert.equal(file.name, 'example.txt'); assert.equal(view.messages[0].text, 'Read this.');
  assert.match(JSON.stringify(mock.requests[0].body.messages), /Uploaded context/);
  const download = await fetch(fix.app.address + '/api/chats/' + chat.id + '/files?path=' + encodeURIComponent(file.path), { headers: { Cookie: fix.cookie } });
  assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert.equal(await download.text(), 'Uploaded context.');
  const files = await fix.request('/api/chats/' + chat.id + '/workspace'); assert.equal(files.files.length, 1);
  await assert.rejects(fix.request('/api/chats/' + chat.id + '/messages', { text: 'PDF', files: [{ name: 'bad.pdf', type: 'application/pdf', data: Buffer.from('%PDF').toString('base64') }] }), /PDF/);
  await assert.rejects(fix.request('/api/chats/' + chat.id + '/messages', { text: 'Image', files: [{ name: 'test.png', type: 'image/png', data: 'abcd' }] }), /vision/);
});

test('accounting distinguishes actual, estimated, missing usage, explicit free rates, and local inference', () => {
  const priced = { cost: { input: 1, output: 1 } }, message = { model: 'test', usage: { input: 5, output: 3, cost: { total: .01 } } };
  const rows = [accounting(message, priced, 'test'), accounting(message, { cost: null }, 'test'), accounting(message, priced, 'local'),
    accounting({ ...message, usage: { ...message.usage, cost: { total: .004, totalFromProvider: true } } }, { cost: null }, 'openrouter'),
    accounting({ ...message, usage: { input: 5, cost: { total: 0 } } }, { cost: { input: 0, output: 0 } }, 'test')];
  assert.deepEqual(rows.map(row => row.kind), ['estimated', 'unpriced', 'local', 'reported', 'estimated']);
  const cost = totalCost(rows); assert.equal(cost.calls, 5); assert.equal(cost.usd, .014); assert.equal(cost.unpriced, 1);
});
