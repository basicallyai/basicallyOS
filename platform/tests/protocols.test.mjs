import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mockProvider, waitFor } from './helpers.mjs';

test('user-defined Responses endpoint streams using the explicitly saved key', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  await fix.request('/api/providers', { id: 'test-responses', name: 'My endpoint', api: 'openai-responses', baseUrl: mock.baseUrl,
    apiKey: 'native-private-key', requiresKey: true, models: [{ id: 'native-test', name: 'Native model', tools: false, vision: false,
      maxTokens: 1024, contextWindow: 128000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
  const chat = await fix.request('/api/chats', { selection: { provider: 'test-responses', model: 'native-test' } });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Hello native API.' });
  const view = await waitFor(async () => { const current = await fix.request('/api/chats/' + chat.id); return !current.running && current.cost.calls ? current : false; });
  assert.equal(view.error, null); assert.match(view.messages.find(message => message.role === 'assistant').text, /Responses/);
  assert.equal(view.cost.estimated, 1); assert.equal(view.cost.tokens, 120); assert.ok(Math.abs(view.cost.usd - .00014) < 1e-9);
  assert.equal(mock.requests[0].auth, 'Bearer native-private-key'); assert.doesNotMatch(JSON.stringify(view), /native-private-key/);
});
