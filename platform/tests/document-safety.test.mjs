import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { fetchPublic } from '../web-search.mjs';

test('concurrent Canvas requests cannot overwrite each other or lose documents', async () => {
  const fix = await fixture(); try {
    const chat = await fix.request('/api/chats', {}), base = '/api/chats/' + chat.id + '/canvases';
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => fix.request(base, { title: 'Document ' + i, content: 'Original ' + i })));
    assert.equal((await fix.request(base)).canvases.length, 8);
    const id = rows[0].canvasId, revision = rows[0].revision;
    const updates = await Promise.allSettled(['First edit', 'Second edit'].map(content => fix.request(base + '/' + id, { revision, content }, 'PATCH')));
    assert.equal(updates.filter(row => row.status === 'fulfilled').length, 1);
    const saved = await fix.request(base + '/' + id); assert.ok(['First edit', 'Second edit'].includes(saved.content));
    const renamed = await fix.request(base + '/' + id, { revision: saved.revision, title: 'New title' }, 'PATCH'); assert.notEqual(renamed.revision, saved.revision);
    const restored = await fix.request(base + '/' + id + '/restore', { revision: renamed.revision, historyRevision: revision }); assert.equal(restored.content, 'Original 0');
    assert.equal((await fix.request(base + '/' + rows[1].canvasId)).content, 'Original 1');
  } finally { await fix.close(); }
});

test('interrupted Save to Notes recovers its association instead of creating duplicate notes', async () => {
  const fix = await fixture(); try {
    const chat = await fix.request('/api/chats', {}), base = '/api/chats/' + chat.id + '/canvases';
    const row = await fix.request(base, { title: 'Recovery', content: '# Recovery\n\nKeep every word.' });
    const finish = fix.app.canvases.finishLink;
    fix.app.canvases.finishLink = async () => { throw new Error('Simulated interruption after note commit'); };
    await assert.rejects(fix.request(base + '/' + row.canvasId + '/notes', {}), /interruption/);
    const pending = await fix.app.store.chat(chat.id); assert.ok(pending.canvases[0].pendingNote); assert.match(pending.canvases[0].content, /every word/);
    fix.app.canvases.finishLink = finish;
    const restored = await fix.request('/api/chats/' + chat.id); assert.equal(restored.canvases.length, 1); assert.ok(restored.canvases[0].noteId);
    const linked = await fix.request(base + '/' + row.canvasId + '/notes', {}); assert.equal(linked.canvasId, row.canvasId);
    const notes = fix.app.resources.list().find(row => row.managed === 'notes'); assert.equal((await fix.app.notes.find('Recovery', [notes.id])).matches.length, 1);
  } finally { await fix.close(); }
});

test('backups preserve standalone documents while imported note references confer no authorization', async () => {
  const fix = await fixture(); try {
    const chat = await fix.request('/api/chats', {}), base = '/api/chats/' + chat.id + '/canvases';
    await fix.request(base, { title: 'Standalone', content: '# Independent\n\nPrivate draft.' });
    const noteCanvas = await fix.request(base, { title: 'Linked', content: 'External knowledge' }); await fix.request(base + '/' + noteCanvas.canvasId + '/notes', {});
    const backup = await fix.request('/api/chats/' + chat.id + '/export'); const imported = await fix.request('/api/chats/import', backup);
    const all = (await fix.request('/api/chats')).chats; const copy = all.find(row => row.id !== chat.id); assert.ok(copy);
    const stored = await fix.app.runtime.get(copy.id); assert.deepEqual(stored.workspaceIds, []); assert.equal(stored.canvases.length, 2);
    assert.match((await fix.app.canvases.current(stored.canvases[0])).content, /Private draft/);
    assert.ok(stored.canvases[1].historicalNoteId); assert.equal(stored.canvases[1].noteId, undefined);
    await assert.rejects(fix.app.canvases.current(stored.canvases[1]), /historical note association/);
    assert.notEqual(stored.canvases[0].canvasId, (await fix.app.runtime.get(chat.id)).canvases[0].canvasId);
  } finally { await fix.close(); }
});

test('manual Canvas dismissal is respected for the rest of the active response', async () => {
  const fix = await fixture(), mock = await mockProvider(); try {
    const selection = await connect(fix, mock, { model: 'slow' }), chat = await fix.request('/api/chats', { selection });
    const canvas = await fix.request('/api/chats/' + chat.id + '/canvases', { title: 'Visible only on request', content: 'Keep this document' });
    await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Unrelated question' }); await waitFor(() => fix.app.runtime.active.has(chat.id));
    const run = fix.app.runtime.active.get(chat.id); await fix.app.canvases.persist(run.chat, fix.app.canvases.row(run.chat, canvas.canvasId), true);
    await fix.request('/api/chats/' + chat.id, { canvas: null }, 'PATCH');
    await fix.app.canvases.persist(run.chat, fix.app.canvases.row(run.chat, canvas.canvasId), true); assert.equal(run.chat.canvas, null);
    await assert.rejects(fix.request('/api/chats/' + chat.id + '/canvases/' + canvas.canvasId, { content: 'Race', revision: canvas.revision }, 'PATCH'), /finish/);
    await fix.request('/api/chats/' + chat.id + '/stop', {}); assert.equal((await fix.request('/api/chats/' + chat.id)).canvases.length, 1);
  } finally { await fix.close(); await mock.close(); }
});

test('Canvas presentation persists independently of document revisions and tool listing pages', async () => {
  const fix = await fixture(); try {
    const chat = await fix.request('/api/chats', {}), base = '/api/chats/' + chat.id + '/canvases', row = await fix.request(base, { title: 'Persistent view', content: 'Unchanged source' });
    await fix.request(base + '/' + row.canvasId + '/state', { sourceMode: true, scrollTop: 123 }, 'PUT');
    const current = await fix.request(base + '/' + row.canvasId); assert.equal(current.revision, row.revision); assert.equal(current.content, row.content); assert.equal(current.history, undefined); assert.equal(current.pendingNote, undefined); assert.equal(current.uiState.sourceMode, true); assert.equal(current.uiState.scrollTop, 123);
    await assert.rejects(fix.request(base + '/' + row.canvasId + '/state', { sourceMode: 'yes', scrollTop: -1 }, 'PUT'), /Invalid/);
    const stored = await fix.app.runtime.get(chat.id); stored.canvases.push(...Array.from({ length: 112 }, (_, i) => ({ canvasId: 'fake-' + i, title: 'Additional ' + i, content: 'not public metadata', history: [], generatedMath: ['secretly heavy metadata'] }))); await fix.app.store.saveChat(stored);
    const run = { chat: stored, scope: [] }, tool = fix.app.canvases.tools(run).find(row => row.name === 'list_canvases');
    const first = JSON.parse((await tool.execute('test', { offset: 0 })).content[0].text), second = JSON.parse((await tool.execute('test', { offset: 100 })).content[0].text);
    assert.equal(first.total, 113); assert.equal(first.canvases.length, 100); assert.equal(first.nextOffset, 100); assert.equal(second.canvases.length, 13); assert.equal(second.canvases[0].position, 101); assert.equal(second.nextOffset, null); assert.equal(JSON.stringify(first).includes('not public metadata'), false); assert.equal(JSON.stringify(first).includes('secretly heavy metadata'), false);
  } finally { await fix.close(); }
});

test('actual Pi web workflow follows returned links and never exposes search keys or disabled tools', async () => {
  const fix = await fixture(), mock = await mockProvider(); try {
    const selection = await connect(fix, mock, { model: 'research-flow' }), visited = [];
    await fix.request('/api/web-search', { provider: 'brave', apiKey: 'private-search-key' }, 'PUT');
    fix.app.web.transport = async (url, options) => { visited.push(url); if (url.includes('api.search.brave.com')) { assert.equal(options.headers['X-Subscription-Token'], 'private-search-key'); return { text: JSON.stringify({ web: { results: [{ title: 'Documentation', url: 'https://docs.example.com/first', description: 'A current source' }] } }) }; } return { url, type: 'text/html', text: '<html><head><title>Documentation</title></head><body><article><p>' + 'Real reference text. '.repeat(50) + '</p><a href="https://docs.example.com/next">Follow-up</a><script>fetch("http://127.0.0.1")</script></article></body></html>' }; };
    const chat = await fix.request('/api/chats', { selection }); await fix.request('/api/chats/' + chat.id, { webSearch: true }, 'PATCH'); await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Research this and check the linked details' });
    const result = await waitFor(async () => { const state = await fix.request('/api/chats/' + chat.id); return !state.running && JSON.stringify(state.messages).includes('Verified sources') ? state : null; });
    assert.equal(visited.length, 3); assert.equal(visited[2], 'https://docs.example.com/next'); assert.match(JSON.stringify(result.messages), /https:\/\/docs.example.com\/first/); assert.equal(JSON.stringify(result).includes('private-search-key'), false); assert.equal(mock.requests.length, 4);
    const disabled = await fix.request('/api/chats', { selection }); await fix.request('/api/chats/' + disabled.id + '/messages', { text: 'No web enabled' }); await waitFor(() => !fix.app.runtime.active.has(disabled.id));
    assert.equal(visited.length, 3); assert.equal(mock.requests.at(-1).body.tools.some(row => ['web_search', 'open_webpage'].includes(row.function.name)), false);
    fix.app.web.transport = async () => ({ text: 'Malformed response echoing private-search-key' }); await assert.rejects(fix.app.web.search('test'), error => !error.message.includes('private-search-key') && /unreadable/.test(error.message));
  } finally { await fix.close(); await mock.close(); }
});

test('Save to Notes commits the exact reviewed target and refuses a file created during approval', async () => {
  const fix = await fixture(), mock = await mockProvider(); try {
    const selection = await connect(fix, mock, { model: 'document-flow' }), notes = fix.app.resources.list().find(row => row.managed === 'notes'), chat = await fix.request('/api/chats', { selection, workspaceIds: [notes.id] });
    await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Create documents and save training to Notes' });
    const approval = await waitFor(async () => (await fix.request('/api/chats/' + chat.id)).approvals[0]); assert.equal(approval.tool, 'save_canvas_to_notes');
    await writeFile(join(notes.root, 'Training.md'), 'External content created after the preview');
    await fix.request('/api/chats/' + chat.id + '/approve', { id: approval.id, allow: true }); await waitFor(() => !fix.app.runtime.active.has(chat.id));
    assert.equal(await readFile(join(notes.root, 'Training.md'), 'utf8'), 'External content created after the preview'); assert.deepEqual(await readdir(notes.root), ['Training.md']);
    const stored = await fix.app.runtime.get(chat.id); assert.equal(stored.canvases[0].noteId, undefined); assert.match(stored.canvases[0].content, /Revised plan/);
  } finally { await fix.close(); await mock.close(); }
});

test('web fetch rejects credentials, local IPs and non-HTTPS endpoints before requesting', async () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com:8443', 'https://127.0.0.1', 'https://[::1]', 'https://169.254.169.254/latest/meta-data/']) await assert.rejects(fetchPublic(url), /public HTTPS|Private, loopback/);
});
