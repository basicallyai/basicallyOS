import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';

test('an interrupted request remains unpriced after restart; dangling tool calls get explicit interruption results', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock), chat = await fix.app.store.createChat(selection);
  chat.messages = [{ role: 'user', content: 'Earlier request', timestamp: Date.now() - 1000 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'interrupted-tool', name: 'write_file', arguments: { path: 'old.txt', content: 'unfinished' } }],
      api: 'openai-completions', provider: 'test', model: 'test-model', timestamp: Date.now() - 900, stopReason: 'toolUse',
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  chat.inFlight = { id: 'lost-request', provider: 'test', model: 'test-model', time: Date.now() - 500 };
  await fix.app.store.saveChat(chat);
  const view = await fix.request('/api/chats/' + chat.id);
  assert.equal(view.cost.unpriced, 1); assert.equal(view.messages.find(message => message.role === 'tool').status, 'interrupted');
  assert.match(view.error, /interrupted/);
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Continue carefully.' });
  await waitFor(() => !fix.app.runtime.active.has(chat.id));
  const current = await fix.request('/api/chats/' + chat.id);
  assert.equal(current.cost.calls, 2); assert.equal(current.cost.unpriced, 1); assert.equal(current.cost.estimated, 1);
  const recovered = mock.requests[0].body.messages.find(message => message.role === 'tool'); assert.match(recovered.content, /interrupted/);
  assert.equal((await fix.app.store.chat(chat.id)).inFlight, undefined);
});

test('event stream carries model deltas and settlement without saved API credentials', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock), chat = await fix.request('/api/chats', { selection });
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(fix.app.address + '/api/events', { headers: { Cookie: fix.cookie }, signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader(); let output = '';
  const consuming = (async () => {
    const decoder = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break; output += decoder.decode(value); if (output.includes('"type":"settled"')) break; }
  })();
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Stream please.' });
  await Promise.race([consuming, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('SSE timeout')), 6000); timer.unref(); })]);
  assert.match(output, /"type":"delta"/); assert.match(output, /"type":"settled"/); assert.doesNotMatch(output, /test-private-key/);
  controller.abort(); await reader.cancel().catch(() => {});
});
