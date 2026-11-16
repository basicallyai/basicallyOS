import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';

async function setup(t, options) {
  const mock = await mockProvider(), fix = await fixture(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock, options), chat = await fix.request('/api/chats', { selection });
  return { ...fix, mock, selection, chat };
}
async function settled(fix, id) { return waitFor(async () => { const chat = await fix.request('/api/chats/' + id); return !chat.running && chat.cost.calls ? chat : false; }); }

test('real Pi streaming persists transcript and user-rate-estimated usage without exposing keys', async t => {
  const fix = await setup(t);
  const initial = await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Hello', selection: fix.selection });
  assert.equal(initial.running, true);
  const chat = await settled(fix, fix.chat.id);
  assert.match(chat.messages.find(message => message.role === 'assistant').text, /Hello/);
  assert.equal(chat.cost.estimated, 1); assert.equal(chat.cost.tokens, 120); assert.ok(Math.abs(chat.cost.usd - .00014) < 1e-9);
  assert.equal(fix.mock.requests[0].auth, 'Bearer test-private-key');
  assert.ok(fix.mock.requests[0].body.tools.length >= 4);
  const disk = JSON.parse(await readFile(join(fix.directory, 'home/app/chats', chat.id + '.json'), 'utf8'));
  assert.ok(disk.messages.some(message => message.role === 'system')); assert.equal(disk.ledger.length, 1);
  assert.doesNotMatch(JSON.stringify(chat), /test-private-key/);
  const regen = await fix.request('/api/chats/' + chat.id + '/regenerate', {}); assert.equal(regen.running, true);
  await waitFor(async () => { const current = await fix.request('/api/chats/' + chat.id); return !current.running && current.cost.calls === 2; });
  const saved = await fix.app.store.chat(chat.id); assert.equal(saved.revisions.length, 1); assert.equal(saved.ledger.length, 2);
});

test('file writes wait for explicit approval and tool follow-ups count in the same conversation', async t => {
  const fix = await setup(t, { model: 'tools' });
  await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Make a file.' });
  const approval = await waitFor(async () => (await fix.request('/api/chats/' + fix.chat.id)).approvals[0]);
  const path = join(fix.directory, 'workspaces', fix.chat.id, 'result.txt');
  await assert.rejects(access(path));
  await fix.request('/api/chats/' + fix.chat.id + '/approve', { id: approval.id, allow: true });
  const chat = await settled(fix, fix.chat.id);
  assert.equal(await readFile(path, 'utf8'), 'Approved file contents');
  assert.equal(chat.cost.calls, 2); assert.equal(chat.cost.estimated, 2); assert.equal(chat.messages.find(message => message.role === 'tool').status, 'done');
  await assert.rejects(fix.request('/api/chats/' + fix.chat.id + '/approve', { id: approval.id, allow: true }), /expired/);
});

test('denied and cancelled approvals never execute a write', async t => {
  const fix = await setup(t, { model: 'tools' });
  await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Write a file.' });
  let approval = await waitFor(async () => (await fix.request('/api/chats/' + fix.chat.id)).approvals[0]);
  await fix.request('/api/chats/' + fix.chat.id + '/approve', { id: approval.id, allow: false });
  const chat = await settled(fix, fix.chat.id); assert.equal(chat.messages.find(message => message.role === 'tool').status, 'error');
  await assert.rejects(access(join(fix.directory, 'workspaces', fix.chat.id, 'result.txt')));
  const another = await fix.request('/api/chats', { selection: fix.selection });
  await fix.request('/api/chats/' + another.id + '/messages', { text: 'Write a file.' });
  approval = await waitFor(async () => (await fix.request('/api/chats/' + another.id)).approvals[0]);
  await fix.request('/api/chats/' + another.id + '/stop', {});
  await assert.rejects(access(join(fix.directory, 'workspaces', another.id, 'result.txt')));
  await assert.rejects(fix.request('/api/chats/' + another.id + '/approve', { id: approval.id, allow: true }), /expired/);
});

test('stopping streamed generation settles the run and does not label missing usage as free', async t => {
  const fix = await setup(t, { model: 'slow' });
  await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Keep going.' });
  await waitFor(async () => (await fix.request('/api/chats/' + fix.chat.id)).partial.length > 0);
  await assert.rejects(fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Double send' }), /already running/);
  await fix.request('/api/chats/' + fix.chat.id + '/stop', {});
  const chat = await fix.request('/api/chats/' + fix.chat.id); assert.equal(chat.running, false); assert.equal(chat.approvals.length, 0); assert.equal(chat.cost.unpriced, 1);
});

test('unknown prices and missing token usage are not fabricated as a zero-dollar estimate', async t => {
  const fix = await setup(t, { cost: null });
  await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Hello' });
  const chat = await settled(fix, fix.chat.id); assert.equal(chat.cost.unpriced, 1); assert.equal(chat.cost.estimated, 0);
  const selection = await connect(fix, fix.mock, { id: 'no-usage', model: 'no-usage' });
  const another = await fix.request('/api/chats', { selection }); await fix.request('/api/chats/' + another.id + '/messages', { text: 'Hello' });
  assert.equal((await settled(fix, another.id)).cost.unpriced, 1);
});

test('OpenRouter actual USD takes precedence over configured estimates', async t => {
  const fix = await setup(t, { id: 'openrouter', model: 'reported' });
  await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Hello' });
  const chat = await settled(fix, fix.chat.id); assert.equal(chat.cost.reported, 1); assert.equal(chat.cost.usd, .0123);
});

test('request limit stops autonomous tool loops without further paid requests', async t => {
  const fix = await setup(t, { model: 'loop' });
  await fix.request('/api/settings', { maxTurns: 2 }, 'PATCH');
  await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Loop' });
  const chat = await settled(fix, fix.chat.id); assert.equal(chat.cost.calls, 2); assert.match(chat.error, /limit/); assert.equal(fix.mock.requests.length, 2);
});

test('anonymous compatible endpoints do not receive a made-up or ambient Authorization header', async t => {
  const fix = await setup(t);
  const provider = (await fix.request('/api/bootstrap')).providers.find(row => row.id === fix.selection.provider);
  await fix.request('/api/providers', { ...provider, requiresKey: false, clearKey: true });
  await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Hello anonymously.' });
  await settled(fix, fix.chat.id); assert.equal(fix.mock.requests[0].auth, undefined);
});

test('API errors are visible and do not strand a conversation as running', async t => {
  const fix = await setup(t, { model: 'failure' });
  await fix.request('/api/chats/' + fix.chat.id + '/messages', { text: 'Hello' });
  const chat = await settled(fix, fix.chat.id); assert.match(chat.error, /rejected/); assert.equal(chat.running, false); assert.equal(chat.cost.unpriced, 1);
});
