import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
const idle = (fix, id) => waitFor(async () => { const chat = await fix.request('/api/chats/' + id); return !chat.running && chat.cost.calls ? chat : false; });
async function folder(fix, name) { const root = join(fix.directory, name); await mkdir(root); return { ...(await fix.request('/api/workspaces', { path: root, confirm: true })), root }; }

test('agent memory defaults remain project-private, updates preserve scope, and multi-project creation needs an explicit choice', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const one = await folder(fix, 'one'), two = await folder(fix, 'two'), service = fix.app.memories;
  await fix.request('/api/settings', { memoryMode: 'automatic' }, 'PATCH');
  const body = { operation: 'upsert', title: 'Project decision', content: 'Use a private local project architecture.', category: 'decision', tags: ['architecture'] };
  const first = (await service.change(body, 'AI · scope test', [one.id])).entry; assert.equal(first.workspaceId, one.id);
  const updated = (await service.change({ ...body, id: first.id, revision: first.revision, content: 'Keep the updated project decision private.' }, 'AI · scope test', [one.id])).entry; assert.equal(updated.workspaceId, one.id);
  assert.doesNotMatch((await service.context('decision', [])).text, /updated project decision/); assert.match((await service.context('decision', [one.id])).text, /updated project decision/);
  await assert.rejects(service.change({ operation: 'delete', id: updated.id, revision: updated.revision }, 'AI · scope test', [two.id]), /different workspace/);
  await assert.rejects(service.change({ ...body, content: 'Choose the project deliberately.' }, 'AI · scope test', [one.id, two.id]), /explicitly/);
  const global = (await service.change({ ...body, workspaceId: null, category: 'preference', content: 'Prefer concise technical answers.' }, 'AI · scope test', [one.id, two.id])).entry; assert.equal(global.workspaceId, null);
  await fix.request('/api/settings', { memoryMode: 'review' }, 'PATCH'); await assert.rejects(service.change({ ...body, content: 'Requires renewed approval.' }, 'AI · scope test', [one.id]), /approval/);
  await fix.request('/api/settings', { memoryMode: 'off' }, 'PATCH'); assert.doesNotMatch((await service.context('', [one.id])).text, /private|concise technical answers/); await assert.rejects(service.change(body, 'AI · scope test', [one.id]), /disabled/);
});

test('project write denial and intervening edits during approval cannot mutate the current file', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); }); const row = await folder(fix, 'review'), selection = await connect(fix, mock, { model: 'resource-write' });
  const saved = await fix.request('/api/resources/save', { workspaceId: row.id, path: 'Note.md', revision: null, content: '# Original' });
  const chat = await fix.request('/api/chats', { selection, workspaceIds: [row.id] }); await fix.request('/api/chats/' + chat.id + '/messages', { text: JSON.stringify({ workspaceId: row.id, path: 'Note.md', content: '# Proposed update', revision: saved.file.revision }) });
  let approval = await waitFor(async () => (await fix.request('/api/chats/' + chat.id)).approvals[0]); await writeFile(join(row.root, 'Note.md'), '# External content written during approval'); await fix.request('/api/chats/' + chat.id + '/approve', { id: approval.id, allow: true });
  const final = await idle(fix, chat.id); assert.equal(await readFile(join(row.root, 'Note.md'), 'utf8'), '# External content written during approval'); assert.ok(final.messages.some(message => message.role === 'tool' && message.status === 'error'));
  const denied = await fix.request('/api/chats', { selection, workspaceIds: [row.id] }); await fix.request('/api/chats/' + denied.id + '/messages', { text: JSON.stringify({ workspaceId: row.id, path: 'Denied.md', content: '# Denied', revision: null }) });
  approval = await waitFor(async () => (await fix.request('/api/chats/' + denied.id)).approvals[0]); await fix.request('/api/chats/' + denied.id + '/approve', { id: approval.id, allow: false }); await idle(fix, denied.id); await assert.rejects(access(join(row.root, 'Denied.md')));
});

test('cancelling exposed reasoning preserves actual partial content and leaves missing usage unpriced', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock, { model: 'reasoning' }), chat = await fix.request('/api/chats', { selection }); await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Think about this question.' });
  await waitFor(async () => (await fix.request('/api/chats/' + chat.id)).partialThinking); await fix.request('/api/chats/' + chat.id + '/stop', {});
  const stopped = await fix.request('/api/chats/' + chat.id); assert.equal(stopped.running, false); assert.ok(stopped.messages.some(message => message.thinking?.includes('Provider-exposed reasoning'))); assert.equal(stopped.cost.unpriced, 1); assert.equal(stopped.cost.estimated, 0);
});
