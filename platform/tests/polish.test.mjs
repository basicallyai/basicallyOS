import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockProvider, waitFor } from './helpers.mjs';
import { createModelCatalog, reasoningPayload } from '../model-catalog.mjs';
import { normalizeProvider, resolveConnection } from '../providers.mjs';
import { recencyWeight } from '../memories.mjs';

const day = 86400000;
async function source(fix, title, text, days = 0, extra = {}) {
  const chat = await fix.app.store.createChat();
  Object.assign(chat, { title, updatedAt: Date.now() - days * day, ...extra });
  chat.inputs = [{ text, timestamp: chat.updatedAt, files: [], workspaceIds: chat.workspaceIds }];
  await fix.app.store.saveChat(chat); return chat;
}

test('chat recall uses relevance and smooth recency without an age cutoff or deletion', async t => {
  const fix = await fixture(); t.after(() => fix.close());
  const old = await source(fix, 'Old relevant', 'Tokenizer vocabulary architecture uses byte pair tokens.', 3650);
  const fresh = await source(fix, 'Fresh relevant', 'Tokenizer vocabulary architecture uses byte pair tokens.');
  const unrelated = await source(fix, 'Fresh unrelated', 'Baking sourdough bread with a cast iron oven.');
  const weak = await source(fix, 'Fresh weak match', 'Tokenizer recipes hiking cycling sailing music gardening ceramics kitchen holidays shopping.');
  const rows = await fix.app.memories.historyContext('tokenizer vocabulary architecture', [], 'another-chat');
  assert.equal(rows[0].chatId, fresh.id); assert.ok(rows.some(row => row.chatId === old.id));
  assert.ok(!rows.some(row => row.chatId === unrelated.id));
  assert.ok(rows.find(row => row.chatId === old.id).score > 0);
  assert.ok(!rows.some(row => row.chatId === weak.id) || rows.findIndex(row => row.chatId === old.id) < rows.findIndex(row => row.chatId === weak.id), 'old highly relevant material outranks a weak fresh match');
  assert.ok(recencyWeight(Date.now() - 100000 * day) > .55);
  assert.equal((await fix.app.store.list(true)).length, 4);
  const context = await fix.app.memories.context('tokenizer vocabulary architecture', [], { chatId: fresh.id });
  assert.match(context.text, /Old relevant/); assert.doesNotMatch(context.text, /Fresh relevant/);
  assert.ok(context.sources.some(row => row.chatId === old.id));
});

test('history recall respects opt-outs, workspace scopes, historical imports, secrets and content budgets', async t => {
  const fix = await fixture(); t.after(() => fix.close());
  const root = join(fix.directory, 'scoped'); await mkdir(root);
  const folder = await fix.request('/api/workspaces', { path: root, confirm: true });
  const scoped = await source(fix, 'Scoped source', 'Tokenizer private vocabulary design', 0, { workspaceIds: [folder.id] });
  const optedOut = await source(fix, 'Opted out', 'Tokenizer private vocabulary design', 0, { memoryDisabled: true });
  const backup = await fix.request('/api/chats/' + optedOut.id + '/export');
  const imported = await fix.request('/api/chats/import', backup);
  assert.equal((await fix.app.store.chat(imported.imported[0].id)).memoryDisabled, true, 'import preserves a source chat opt-out');
  const malformed = structuredClone(backup); malformed.entries[0].chat.inputs[0].workspaceIds = {};
  await assert.rejects(fix.request('/api/chats/import', malformed), /workspace scope/);
  await source(fix, 'Historical import', 'Tokenizer private vocabulary design', 0, { historicalWorkspaceIds: [folder.id] });
  await source(fix, 'Secret', 'Tokenizer api_key=sk-not-for-retrieval123456789 vocabulary');
  await source(fix, 'Old input scope', 'Tokenizer vocabulary design', 0, { workspaceIds: [] }).then(async chat => { chat.inputs[0].workspaceIds = [folder.id]; await fix.app.store.saveChat(chat); });
  assert.equal((await fix.app.memories.historyContext('tokenizer vocabulary', [], '')).length, 0);
  const allowed = await fix.app.memories.historyContext('tokenizer vocabulary', [folder.id], '');
  assert.ok(allowed.some(row => row.chatId === scoped.id));
  assert.ok(allowed.every(row => !['Secret', 'Opted out', 'Historical import'].includes(row.title)));
  await fix.request('/api/workspaces/' + folder.id, undefined, 'DELETE');
  assert.equal((await fix.app.memories.historyContext('tokenizer vocabulary', [folder.id], '')).length, 0, 'revoked grants cannot be used by a later recall call');
  const large = await source(fix, 'Large', 'Tokenizer vocabulary '.repeat(4000));
  large.messages.push({ role: 'toolResult', content: [{ type: 'text', text: 'HIDDEN_TOOL_CONTENT tokenizer vocabulary' }] });
  large.inputs[0].files.push({ name: 'attachment', data: 'HIDDEN_ATTACHMENT tokenizer vocabulary' }); await fix.app.store.saveChat(large);
  const context = await fix.app.memories.context('tokenizer vocabulary', []);
  assert.doesNotMatch(context.text, /HIDDEN_TOOL_CONTENT|HIDDEN_ATTACHMENT/);
  assert.ok((await fix.app.memories.historyContext('tokenizer vocabulary', [], '')).reduce((sum, row) => sum + row.excerpt.length + 220, 0) <= 4000);
  assert.doesNotMatch((await fix.app.memories.context('tokenizer vocabulary', [], { disabled: true })).text, /Large|Scoped source/);
  await fix.request('/api/settings', { memoryMode: 'off' }, 'PATCH');
  assert.doesNotMatch((await fix.app.memories.context('tokenizer vocabulary', [])).text, /Large|Scoped source/);
});

test('provider metadata selects exact endpoint rates, coalesces by route and rejects ambiguous names', async () => {
  const requests = [];
  const catalog = createModelCatalog({ fetcher: async (url, options) => {
    requests.push({ url, auth: options.headers.Authorization });
    return new Response(JSON.stringify({ data: { name: 'Exact model', architecture: { input_modalities: ['text'] }, endpoints: [
      { provider_name: 'Provider One', tag: 'one/fp8', context_length: 32000, max_completion_tokens: 4000, pricing: { prompt: '0.000002', completion: '0.000008', input_cache_read: '0.0000002' }, supported_parameters: ['tools'] },
      { provider_name: 'Provider One', tag: 'one/fp16', context_length: 16000, max_completion_tokens: 2000, pricing: { prompt: '0.000004', completion: '0.000012' } },
    ] } }));
  } });
  const connection = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'private' }, options = { modelId: 'maker/exact', upstreamProvider: 'one/fp8' };
  const [one, two] = await Promise.all([catalog(connection, options), catalog(connection, options)]);
  assert.equal(requests.length, 1); assert.deepEqual(one, two);
  const model = one.models[0]; assert.deepEqual(model.cost, { input: 2, output: 8, cacheRead: .2, cacheWrite: null });
  assert.equal(model.contextWindow, 32000); assert.equal(model.maxTokens, 4000); assert.equal(model.metadata.upstreamProvider, 'one/fp8');
  assert.match(requests[0].url, /\/models\/maker\/exact\/endpoints$/);
  await assert.rejects(catalog(connection, { ...options, upstreamProvider: 'Provider One' }), /multiple endpoints/);
  await assert.rejects(catalog(connection, { ...options, upstreamProvider: 'Not present' }), /not advertised/);
  const missing = (await catalog(connection, { ...options, upstreamProvider: 'one/fp16' })).models[0]; assert.equal(missing.cost.cacheRead, null);
  await assert.rejects(catalog({ baseUrl: 'https://elsewhere.example/v1' }, options), /OpenRouter/);
});

test('provider override persists and pins actual Pi requests; new rates do not rewrite past ledger totals', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const connection = { id: 'router', name: 'Router', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: false,
    models: [{ id: 'maker/exact', upstreamProvider: 'one/fp8', contextWindow: 32000, maxTokens: 1000, cost: { input: 2, output: 8, cacheRead: null, cacheWrite: null } }] };
  await fix.request('/api/providers', connection);
  assert.equal(fix.app.store.config.providers[0].models[0].upstreamProvider, 'one/fp8');
  fix.app.runtime.connectionResolver = (config, selection) => resolveConnection({ ...config, providers: config.providers.map(row => ({ ...row, baseUrl: mock.baseUrl })) }, selection);
  const chat = await fix.request('/api/chats', { selection: { provider: 'router', model: 'maker/exact' } });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Answer without tools.' });
  await waitFor(() => !fix.app.runtime.active.size);
  assert.deepEqual(mock.requests[0].body.provider, { only: ['one/fp8'], allow_fallbacks: false });
  let stored = await fix.app.store.chat(chat.id); const first = structuredClone(stored.ledger[0]);
  assert.equal(first.kind, 'estimated'); assert.ok(Math.abs(first.usd - .00036) < 1e-10); assert.equal(first.upstreamProvider, 'one/fp8');
  connection.models[0].upstreamProvider = 'one/fp16'; connection.models[0].cost = { input: 4, output: 12, cacheRead: null, cacheWrite: null };
  await fix.request('/api/providers', connection);
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Another answer.' }); await waitFor(() => !fix.app.runtime.active.size);
  stored = await fix.app.store.chat(chat.id); assert.deepEqual(stored.ledger[0], first); assert.ok(Math.abs(stored.ledger[1].usd - .00064) < 1e-10);
  assert.deepEqual(mock.requests[1].body.provider, { only: ['one/fp16'], allow_fallbacks: false });
  connection.models[0].cost = null; await fix.request('/api/providers', connection);
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Unknown rate answer.' }); await waitFor(() => !fix.app.runtime.active.size);
  const unpriced = (await fix.app.store.chat(chat.id)).ledger.at(-1); assert.equal(unpriced.kind, 'unpriced'); assert.equal(unpriced.usd, null);
  const invalid = { ...connection, baseUrl: 'https://custom.example/v1' }; assert.throws(() => normalizeProvider(invalid), /OpenRouter/);
  assert.deepEqual(reasoningPayload({}, { upstreamProvider: 'one/fp8' }, 'openai-completions'), { provider: { only: ['one/fp8'], allow_fallbacks: false } });
});

test('actual Pi requests contain weighted recall with inspectable sources and memory off excludes it', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  await source(fix, 'Older vocabulary design', 'Tokenizer vocabulary should use byte pair encoding.', 1000);
  const config = { id: 'plain', name: 'Plain', api: 'openai-completions', baseUrl: mock.baseUrl, requiresKey: false, models: [{ id: 'test-model', contextWindow: 128000, maxTokens: 1000 }] };
  await fix.request('/api/providers', config); const chat = await fix.request('/api/chats', { selection: { provider: 'plain', model: 'test-model' } });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'What tokenizer vocabulary did we discuss?' }); await waitFor(() => !fix.app.runtime.active.size);
  assert.match(JSON.stringify(mock.requests[0].body.messages), /Older vocabulary design/);
  const view = await fix.request('/api/chats/' + chat.id); assert.ok(view.memorySources.sources.some(row => row.title === 'Older vocabulary design'));
  await fix.request('/api/chats/' + chat.id, { memoryDisabled: true }, 'PATCH');
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'What tokenizer vocabulary did we discuss?' }); await waitFor(() => !fix.app.runtime.active.size);
  assert.doesNotMatch(JSON.stringify(mock.requests[1].body.messages), /Older vocabulary design/);
  assert.deepEqual((await fix.request('/api/chats/' + chat.id)).memorySources.sources, []);
});
