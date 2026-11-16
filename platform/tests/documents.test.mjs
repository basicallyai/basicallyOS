import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { createApp } from '../server.mjs';
import { publicAddress } from '../web-search.mjs';

test('standalone multiple Canvases persist, revision-check, link once, synchronize renames and survive restart', async () => {
  const fix = await fixture(); let restarted;
  try {
    const notes = fix.app.resources.list().find(row => row.managed === 'notes'), chat = await fix.request('/api/chats', {}), base = '/api/chats/' + chat.id + '/canvases';
    const first = await fix.request(base, { title: 'Architecture', content: '# Architecture\n\nStandalone.' });
    const second = await fix.request(base, { title: 'Training', content: '# Training\n\nIndependent.' });
    assert.notEqual(first.canvasId, second.canvasId); assert.equal((await fix.app.notes.find('', [notes.id])).matches.length, 0);
    const edited = await fix.request(base + '/' + first.canvasId, { revision: first.revision, content: '# Architecture\n\nEdited.' }, 'PATCH');
    await assert.rejects(fix.request(base + '/' + first.canvasId, { revision: first.revision, content: 'stale' }, 'PATCH'), /changed/);
    assert.equal((await fix.request(base + '/' + second.canvasId)).content, second.content);
    await fix.request('/api/resources/save', { workspaceId: notes.id, path: 'Architecture.md', revision: null, content: 'Original note must survive' });
    const linked = await fix.request(base + '/' + first.canvasId + '/notes', {}); assert.equal(linked.title, 'Architecture (2)'); assert.ok(linked.noteId);
    const again = await fix.request(base + '/' + first.canvasId + '/notes', {}); assert.equal(again.noteId, linked.noteId);
    assert.equal((await fix.app.resources.read({ workspaceId: notes.id, path: 'Architecture.md' })).content, 'Original note must survive');
    await writeFile(join(notes.root, linked.path), '# External edit\n'); await fix.app.resources.sync(true);
    const external = await fix.request(base + '/' + first.canvasId); assert.equal(external.content, '# External edit\n');
    const renamed = await fix.request(base + '/' + first.canvasId, { title: 'Architecture renamed', revision: external.revision }, 'PATCH'); assert.equal(renamed.noteId, linked.noteId); assert.equal(renamed.path, 'Architecture renamed.md');
    assert.equal((await fix.request(base + '/' + first.canvasId + '/history')).history.length > 0, true);
    const standaloneHistory = await fix.request(base + '/' + second.canvasId + '/history'); assert.deepEqual(standaloneHistory.history, []);
    await fix.request('/api/chats/' + chat.id, { canvas: null }, 'PATCH');
    await fix.app.close();
    restarted = await createApp({ root: fix.directory, home: join(fix.directory, 'home'), port: 0, local: fix.app.local });
    const restored = await restarted.runtime.get(chat.id); assert.equal(restored.canvases.length, 2); assert.equal(restored.canvas, null);
    assert.equal((await restarted.canvases.current(restarted.canvases.row(restored, first.canvasId))).content, '# External edit\n');
    assert.equal((await restarted.canvases.current(restarted.canvases.row(restored, second.canvasId))).content, second.content);
    assert.equal(edited.canvasId, first.canvasId);
  } finally { await restarted?.close(); await fix.close(); }
});

test('Markdown imports preserve bytes, nested paths, indexing, duplicates and reject traversal/encoding before writes', async () => {
  const fix = await fixture(); try {
    const notes = fix.app.resources.list().find(row => row.managed === 'notes');
    const text = '\uFEFF---\r\ntags: [test]\r\n---\r\n\r\n# Imported\r\n[[Link]]\r\n\r\n```js\r\nconsole.log(1)\r\n```\r\n\r\n| A | B |\r\n|---|---|\r\n|1|2|\r\n';
    const files = [{ path: 'Folder/Imported.md', data: Buffer.from(text).toString('base64') }, { path: 'Second.md', data: Buffer.from('# Second\n').toString('base64') }];
    const result = await fix.request('/api/notes/import', { files }); assert.equal(result.errors.length, 0); assert.equal(result.imported.length, 2); assert.ok(result.imported.every(row => row.noteId));
    assert.equal(await readFile(join(notes.root, files[0].path), 'utf8'), text);
    const repeated = await fix.request('/api/notes/import', { files }); assert.equal(repeated.imported[0].path, 'Folder/Imported (2).md');
    const found = await fix.request('/api/notes/search', { query: 'Imported', workspaceIds: [notes.id] }); assert.equal(found.ambiguous, true);
    await assert.rejects(fix.request('/api/notes/import', { files: [{ path: '../escape.md', data: 'YQ==' }] }), /relative/);
    await assert.rejects(fix.request('/api/notes/import', { files: [{ path: 'Invalid.md', data: Buffer.from([255, 254]).toString('base64') }] }), /encoded|encoding/);
  } finally { await fix.close(); }
});

test('web research provider requests, extraction, rate limits, credentials and public network boundaries', async () => {
  const fix = await fixture(); try {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '0.0.0.0']) assert.equal(publicAddress(address), false, address);
    assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
    const browsers = fix.app.web.browsers; fix.app.web.browsers = []; await assert.rejects(fix.app.web.search('current news'), /No supported installed browser/); fix.app.web.browsers = browsers;
    const calls = []; fix.app.web.transport = async (url, options) => { calls.push({ url: String(url), options }); if (String(url).includes('search.brave.com')) return { text: JSON.stringify({ web: { results: [{ title: 'Official documentation', url: 'https://example.com/docs', description: 'Verified snippet' }] } }) }; return { url: 'https://example.com/docs', type: 'text/html', text: '<html><head><title>Documentation</title></head><body><article><h1>API reference</h1><p>Use documented parameters and authenticate carefully. This is the relevant source content, not model knowledge.</p><a href="/next">Next</a><script>window.stolen = true</script></article></body></html>' }; };
    await fix.request('/api/web-search', { provider: 'brave', apiKey: 'private-search-key' }, 'PUT');
    const status = await fix.request('/api/web-search'); assert.equal(status.configured, true); assert.equal(status.apiKey, undefined);
    const result = await fix.app.web.search('official library'); assert.equal(result.sources[0].url, 'https://example.com/docs'); assert.equal(calls[0].options.headers['X-Subscription-Token'], 'private-search-key');
    const page = await fix.app.web.open(result.sources[0].url); assert.match(page.content, /documented parameters/); assert.doesNotMatch(page.content, /window.stolen/); assert.ok(page.links.some(row => row.url === 'https://example.com/next'));
    fix.app.web.transport = async () => { throw new Error('Web service rate-limited this request. Retry later.'); }; await assert.rejects(fix.app.web.search('another query'), /rate-limited/);
  } finally { await fix.close(); }
});

test('text file preview matches original bytes; binary/invalid UTF-8 rejected without execution', async () => {
  const fix = await fixture(); try {
    const chat = await fix.request('/api/chats', {}), dir = join(fix.app.runtime.workspaceRoot, chat.id); const { mkdir } = await import('node:fs/promises'); await mkdir(dir, { recursive: true });
    const text = '<script>window.pwned=1</script>\r\nconst answer = 42;\r\n'; await writeFile(join(dir, 'result.html'), text);
    const preview = await fix.request('/api/chats/' + chat.id + '/files?path=result.html&preview=1'); assert.equal(preview.content, text);
    const response = await fetch(fix.app.address + '/api/chats/' + chat.id + '/files?path=result.html', { headers: { Cookie: fix.cookie } }); assert.equal(await response.text(), text); assert.match(response.headers.get('content-disposition'), /result.html/);
    await writeFile(join(dir, 'binary.bin'), Buffer.from([0, 1, 2])); await assert.rejects(fix.request('/api/chats/' + chat.id + '/files?path=binary.bin&preview=1'), /Binary/);
    await writeFile(join(dir, 'invalid.txt'), Buffer.from([255])); await assert.rejects(fix.request('/api/chats/' + chat.id + '/files?path=invalid.txt&preview=1'), /UTF-8/);
  } finally { await fix.close(); }
});

test('real Pi tool calls create/edit/save multiple Canvases with approval; unrelated response does not reopen', async () => {
  const fix = await fixture(), mock = await mockProvider(); try {
    const selection = await connect(fix, mock, { model: 'document-flow' }), notes = fix.app.resources.list().find(row => row.managed === 'notes');
    const chat = await fix.request('/api/chats', { selection, workspaceIds: [notes.id] });
    await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Create two Canvases, update the training plan, and save that one to Notes.' });
    const approval = await waitFor(async () => (await fix.request('/api/chats/' + chat.id)).approvals[0]); assert.equal(approval.tool, 'save_canvas_to_notes');
    await fix.request('/api/chats/' + chat.id + '/approve', { id: approval.id, allow: true });
    const settled = await waitFor(async () => { const row = await fix.request('/api/chats/' + chat.id); return !row.running && row; });
    assert.equal(settled.canvases.length, 2); const stored = await fix.app.runtime.get(chat.id); assert.ok(stored.canvases[0].noteId); assert.equal(stored.canvases[1].noteId, undefined);
    assert.match((await fix.app.canvases.current(stored.canvases[0])).content, /Revised plan/);
    await fix.request('/api/chats/' + chat.id + '/messages', { text: 'What is 2+2? Do not open documents.' });
    const unrelated = await waitFor(async () => { const row = await fix.request('/api/chats/' + chat.id); return !row.running && row; }); assert.equal(unrelated.canvas, null); assert.equal(unrelated.canvases.length, 2);
    assert.ok(mock.requests[0].body.tools.some(tool => tool.function.name === 'create_canvas')); assert.equal(mock.requests[0].body.tools.some(tool => tool.function.name === 'web_search'), false);
  } finally { await fix.close(); await mock.close(); }
});
