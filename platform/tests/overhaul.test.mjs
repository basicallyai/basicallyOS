import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { createApp } from '../server.mjs';
import { catalogModel, createModelCatalog, reasoningPayload } from '../model-catalog.mjs';
import { normalizeModel } from '../providers.mjs';
import { mathToken } from '../web/math.js';
import { applyStreamDelta, mergeStreamSnapshot } from '../web/stream-state.js';
const idle = (fix, id) => waitFor(async () => { const chat = await fix.request('/api/chats/' + id); return !chat.running && chat.cost.calls ? chat : false; });

test('built-in nested notes need no attachment, retain their identity and content after a full server restart, and use existing search/backlinks/history', async t => {
  const fix = await fixture(); let reopened; t.after(async () => { await reopened?.close(); await fix.close(); }); const notes = (await fix.request('/api/workspaces')).workspaces;
  assert.equal(notes.length, 1); assert.equal(notes[0].managed, 'notes'); const row = notes[0];
  await fix.request('/api/resources/save', { workspaceId: row.id, path: 'Nested/Equation.md', content: '# Equation\n\n[[Other]]\n\n$$x^2$$', revision: null });
  await fix.request('/api/resources/save', { workspaceId: row.id, path: 'Other.md', content: '# Other\nSearchable persistent knowledge.', revision: null });
  assert.equal((await fix.request('/api/resources/links', { ref: { workspaceId: row.id, path: 'Other.md' } })).incoming.length, 1);
  assert.equal((await fix.request('/api/resources/search', { query: 'persistent' })).total, 1);
  await assert.rejects(fix.request('/api/workspaces/' + row.id, undefined, 'DELETE'), /cannot be detached/);
  await fix.app.close(); const app = await createApp({ root: fix.directory, home: join(fix.directory, 'home'), port: 0, local: fix.app.local }); reopened = app;
  assert.equal(app.resources.list()[0].id, row.id); assert.match((await app.resources.read({ workspaceId: row.id, path: 'Nested/Equation.md' })).content, /x\^2/);
  const plan = await app.resources.plan({ action: 'delete', workspaceId: row.id, path: 'Other.md', revision: (await app.resources.read({ workspaceId: row.id, path: 'Other.md' })).revision }), result = await app.resources.commit(plan);
  await app.resources.undo(result.operationId); assert.match(await readFile(join(row.root, 'Other.md'), 'utf8'), /persistent/);
});

test('managed notes enforce conversation scope and reviewed AI changes without any attached project', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); }); const notes = fix.app.resources.list()[0], selection = await connect(fix, mock, { model: 'resource-write' });
  const input = JSON.stringify({ workspaceId: notes.id, path: 'AI.md', revision: null, content: '# Approved note' });
  const privateChat = await fix.request('/api/chats', { selection }); await fix.request('/api/chats/' + privateChat.id + '/messages', { text: input }); assert.ok((await idle(fix, privateChat.id)).messages.some(row => row.role === 'tool' && row.status === 'error'));
  const scoped = await fix.request('/api/chats', { selection, workspaceIds: [notes.id] }); await fix.request('/api/chats/' + scoped.id + '/messages', { text: input }); const approval = await waitFor(async () => (await fix.request('/api/chats/' + scoped.id)).approvals[0]);
  assert.match(approval.preview.changes[0].diff, /Approved note/); await fix.request('/api/chats/' + scoped.id + '/approve', { id: approval.id, allow: true }); await idle(fix, scoped.id); assert.match(await readFile(join(notes.root, 'AI.md'), 'utf8'), /Approved note/);
});

test('live metadata preserves authoritative limits/rates/capabilities, unknown fields stay unknown, and catalog requests are cached/coalesced', async () => {
  const router = catalogModel({ id: 'vendor/model', context_length: 200000, top_provider: { max_completion_tokens: 12000 }, pricing: { prompt: '0.000002', completion: '0.000008', input_cache_read: '0.0000002' }, architecture: { input_modalities: ['text', 'image', 'audio'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning', 'structured_outputs'] }, 'https://openrouter.ai/api/v1');
  assert.equal(router.cost.input, 2); assert.equal(router.cost.output, 8); assert.ok(Math.abs(router.cost.cacheRead - .2) < 1e-12); assert.equal(router.cost.cacheWrite, null); assert.equal(router.contextWindow, 200000); assert.equal(router.vision, true); assert.equal(router.tools, true); assert.equal(router.capabilities.structuredOutput, true); assert.equal(router.reasoningConfig.format, 'openrouter');
  const unknown = catalogModel({ id: 'opaque', pricing: { input: 123 } }, 'https://api.openai.com/v1'); assert.equal(unknown.contextWindow, null); assert.equal(unknown.cost, null); assert.equal(unknown.reasoningConfig, null); assert.equal(unknown.tools, null); assert.equal(normalizeModel({ id: 'opaque' }).maxTokens, null);
  let calls = 0; const catalog = createModelCatalog({ fetcher: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return new Response(JSON.stringify({ data: [{ id: 'opaque' }] })); } });
  const provider = { baseUrl: 'https://custom.example/v1', apiKey: 'secret' }; await Promise.all([catalog(provider), catalog(provider), catalog(provider)]); assert.equal(calls, 1); await catalog(provider); assert.equal(calls, 1); await catalog(provider, { refresh: true }); assert.equal(calls, 2);
  let retries = 0; const limited = createModelCatalog({ fetcher: async () => { retries++; return new Response('', { status: 429, headers: { 'retry-after': '1' } }); } }); await assert.rejects(limited(provider), /429/); await assert.rejects(limited(provider, { refresh: true }), /429/); assert.equal(retries, 1);
});

test('automatic metadata API uses only the selected endpoint credentials and represents unknown IDs explicitly', async t => {
  const fix = await fixture(), mock = await mockProvider(), other = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); await other.close(); }); await connect(fix, mock);
  const found = await fix.request('/api/providers/metadata', { providerId: 'test', baseUrl: mock.baseUrl, modelId: 'test-model' }); assert.equal(found.status, 'found'); assert.equal(found.model.contextWindow, 128000); assert.equal(found.model.cost.input, 1.5); assert.equal(found.model.tools, true);
  assert.equal((await fix.request('/api/providers/metadata', { baseUrl: mock.baseUrl, modelId: 'unknown' })).status, 'unknown');
  assert.equal((await fix.request('/api/providers/metadata', { providerId: 'test', baseUrl: other.baseUrl, modelId: 'test-model' })).model.maxTokens, 1024);
  assert.equal(other.catalogRequests[0].auth, undefined); assert.equal(mock.catalogRequests[0].auth, 'Bearer test-private-key');
});

test('reasoning controls serialize only advertised per-model settings into the real Pi request', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  for (const [id, api, model, config] of [['controlled', 'openai-completions', 'reasoning', { format: 'openai', levels: ['low', 'high'] }], ['native', 'openai-responses', 'native-reasoning', { format: 'openai', levels: ['low'] }], ['unconfigured', 'openai-completions', 'reasoning-alt', null]]) {
    await fix.request('/api/providers', { id, name: id, api, baseUrl: mock.baseUrl, apiKey: 'key', models: [{ id: model, contextWindow: 128000, maxTokens: 1024, reasoning: true, reasoningConfig: config, tools: false }] });
    await fix.request('/api/settings', { reasoningOverrides: { [id + '/' + model]: config?.levels.at(-1) || 'high' } }, 'PATCH'); const chat = await fix.request('/api/chats', { selection: { provider: id, model } }); await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Question' }); await idle(fix, chat.id);
    const body = mock.requests.at(-1).body; if (id === 'controlled') assert.equal(body.reasoning_effort, 'high'); else if (id === 'native') assert.deepEqual(body.reasoning, { effort: 'low' }); else { assert.equal(body.reasoning, undefined); assert.equal(body.reasoning_effort, undefined); }
  }
  assert.deepEqual(reasoningPayload({ reasoning_effort: 'high' }, { reasoning: true, reasoningConfig: { format: 'openrouter', levels: ['low'] } }, 'openai-completions', 'low'), { reasoning: { effort: 'low' } });
  assert.throws(() => normalizeModel({ id: 'bad', reasoningConfig: { format: 'invented', levels: ['maximum'] } }), /documented/);
});

test('math tokenization covers all four delimiters, incomplete displays, escaping and ordinary prices', () => {
  for (const source of ['$x^2$', String.raw`\(x^2\)`]) assert.equal(mathToken(source).tex, 'x^2');
  for (const source of ['$$\nx^2\n$$', String.raw`\[x^2\]`]) { assert.equal(mathToken(source, true).display, true); assert.equal(mathToken(source, true).tex.trim(), 'x^2'); }
  assert.equal(mathToken('$$unfinished', true).pending, true); assert.equal(mathToken(String.raw`\$x$`), undefined); assert.equal(mathToken('$5 and $10'), undefined); assert.equal(mathToken('$ x$'), undefined);
});

test('stream snapshots never duplicate/revert newer deltas; stale assistant chunks and gaps are handled explicitly', () => {
  const chat = { id: 'chat', running: true, runId: 'run', streamId: 'a', streamRevision: 1, partial: 'Hello', partialThinking: '' }, delta = { runId: 'run', streamId: 'a', revision: 2, offset: 5, text: ' world' };
  assert.equal(applyStreamDelta(chat, 'delta', delta), true); assert.equal(applyStreamDelta(chat, 'delta', delta), false); assert.equal(chat.partial, 'Hello world');
  const snapshot = mergeStreamSnapshot(chat, { ...chat, streamRevision: 1, partial: 'Hello' }); assert.equal(snapshot.partial, 'Hello world');
  assert.equal(applyStreamDelta(chat, 'delta', { ...delta, revision: 3, offset: 90 }), 'resync');
  const settled = { ...chat, streamRevision: 4, partial: '' }; assert.equal(applyStreamDelta(settled, 'delta', delta), false);
  assert.equal(applyStreamDelta(chat, 'thinking', { ...delta, streamId: 'b', revision: 4, offset: 0, text: 'New thought' }), true); assert.equal(chat.partial, ''); assert.equal(chat.partialThinking, 'New thought');
});
