import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { Resources } from '../resources.mjs';
import { wikiLinks, sectionExcerpt } from '../web/wiki.js';
const idle = (fix, id) => waitFor(async () => { const chat = await fix.request('/api/chats/' + id); return !chat.running && chat.cost.calls ? chat : false; });
async function folder(fix, name) { const root = join(fix.directory, name); await mkdir(root); const row = await fix.request('/api/workspaces', { path: root, name, confirm: true }); return { ...row, root }; }
async function save(fix, row, path, content, revision = null) { return fix.request('/api/resources/save', { workspaceId: row.id, path, content, revision }); }
async function file(fix, row, path) { return fix.request('/api/resources/file?' + new URLSearchParams({ workspaceId: row.id, path })); }
async function apply(fix, body) { const preview = await fix.request('/api/resources/plan', body); return fix.request('/api/resources/apply', { id: preview.id }); }

test('explicit folder grants, path boundaries, junction rejection and detach revocation', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix, 'project');
  await assert.rejects(fix.request('/api/workspaces', { path: row.root }), /confirm/i);
  await assert.rejects(fix.request('/api/workspaces', { path: join(fix.directory, 'home', 'app'), confirm: true }), /private/);
  for (const path of ['../escape.txt', 'C:/escape.txt', 'sub/../../escape', '.env', '.git/config']) await assert.rejects(save(fix, row, path, 'no'));
  const outside = join(fix.directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'private');
  await symlink(outside, join(row.root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(file(fix, row, 'outside-link/secret.txt'), /links|junctions/i);
  await link(join(outside, 'secret.txt'), join(row.root, 'hard-link.txt')); await assert.rejects(file(fix, row, 'hard-link.txt'), /hard.linked/i);
  await save(fix, row, 'safe.txt', 'Safe'); await fix.request('/api/workspaces/' + row.id, undefined, 'DELETE');
  await assert.rejects(file(fix, row, 'safe.txt'), /not authorized/); assert.equal(await readFile(join(row.root, 'safe.txt'), 'utf8'), 'Safe');
});

test('version-checked source editing, targeted edits, reviewed diffs and persistent undo preserve external edits', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix, 'code');
  const original = 'const number = 1;\r\n// [[Not a real note]]\r\n';
  let result = await save(fix, row, 'src/main.js', original); assert.equal((await file(fix, row, 'src/main.js')).content, original);
  const preview = await fix.request('/api/resources/plan', { action: 'edit', workspaceId: row.id, path: 'src/main.js', revision: result.file.revision, find: 'number = 1', replace: 'number = 2' });
  assert.match(preview.changes[0].diff, /\+const number = 2/); assert.equal(await readFile(join(row.root, 'src/main.js'), 'utf8'), original);
  result = await fix.request('/api/resources/apply', { id: preview.id }); assert.equal(await readFile(join(row.root, 'src/main.js'), 'utf8'), original.replace('= 1', '= 2'));
  await fix.request('/api/resources/undo', { id: result.operationId }); assert.equal(await readFile(join(row.root, 'src/main.js'), 'utf8'), original);
  await writeFile(join(row.root, 'src/main.js'), 'External writer');
  await assert.rejects(fix.request('/api/resources/undo', { id: result.operationId }), /changed/i);
  await assert.rejects(save(fix, row, 'src/main.js', 'Stale overwrite', 'bad-revision'), /changed/);
  assert.equal(await readFile(join(row.root, 'src/main.js'), 'utf8'), 'External writer');
  const persisted = new Resources(fix.app.store); await persisted.initialize(); t.after(() => persisted.close()); assert.ok((await persisted.history()).length >= 3); assert.equal(persisted.list().find(item => !item.managed).id, row.id);
});

test('wiki links resolve aliases and sections, disambiguate identical names, and maintain backlinks through renames and folder moves', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix, 'notes'), other = await folder(fix, 'other');
  await save(fix, row, 'Architecture.md', '# Architecture\n\n## Decisions\nUse local files.\n\n## Other\nDifferent section.');
  await save(fix, row, 'Project.md', '# Project\nSee [[Architecture#Decisions|Design]] and `[[Code only]]`.');
  await save(fix, other, 'Architecture.md', '# Another Architecture');
  let result = (await fix.request('/api/resources/resolve', { targets: ['Architecture'], workspaceIds: [row.id, other.id] })).links[0]; assert.equal(result.status, 'ambiguous');
  result = (await fix.request('/api/resources/resolve', { targets: ['Architecture#Decisions'], base: { workspaceId: row.id, path: 'Project.md' } })).links[0]; assert.equal(result.status, 'resolved'); assert.equal(result.matches[0].workspaceId, row.id);
  let links = await fix.request('/api/resources/links', { ref: { workspaceId: row.id, path: 'Architecture.md' } }); assert.equal(links.incoming.length, 1); assert.match(links.incoming[0].context, /Design/);
  const source = await file(fix, row, 'Architecture.md');
  const moved = await apply(fix, { action: 'move', workspaceId: row.id, path: 'Architecture.md', destination: 'Design/Architecture.md', destinationWorkspaceId: row.id, revision: source.revision });
  assert.match((await file(fix, row, 'Project.md')).content, new RegExp(row.id + '::Design/Architecture.md#Decisions\\|Design'));
  links = await fix.request('/api/resources/links', { ref: { workspaceId: row.id, path: 'Design/Architecture.md' } }); assert.equal(links.incoming.length, 1);
  await fix.request('/api/resources/undo', { id: moved.operationId }); assert.match((await file(fix, row, 'Project.md')).content, /\[\[Architecture#Decisions\|Design\]\]/); await assert.rejects(access(join(row.root, 'Design')));
  await save(fix, row, 'Group/A.md', '# A\n[[../Architecture]]'); await save(fix, row, 'Group/B.md', '[[A]]');
  const folderMove = await apply(fix, { action: 'move', workspaceId: row.id, path: 'Group', destination: 'Moved', destinationWorkspaceId: row.id, revision: 'directory' });
  assert.match((await file(fix, row, 'Moved/B.md')).content, /::Moved\/A.md/); assert.match((await file(fix, row, 'Moved/A.md')).content, /::Architecture.md/);
  await fix.request('/api/resources/undo', { id: folderMove.operationId }); assert.equal((await file(fix, row, 'Group/A.md')).content, '# A\n[[../Architecture]]');
  const parsed = wikiLinks('[[Page#Heading|Label]] `[[ignored]]`\n```js\n[[ignored too]]\n```'); assert.equal(parsed.length, 1); assert.equal(parsed[0].alias, 'Label');
  assert.equal(sectionExcerpt(source.content, 'Decisions').text, '## Decisions\nUse local files.\n');
});

test('full-text search, filename/type/tag filters and external change synchronization share one index', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix, 'search');
  await save(fix, row, 'Projects/Plan.md', '# Plan\n#project\nA persistent llama workflow.'); await save(fix, row, 'script.js', '// llama implementation');
  let result = await fix.request('/api/resources/search', { query: 'llama tag:project type:md path:Projects' }); assert.equal(result.total, 1); assert.equal(result.results[0].path, 'Projects/Plan.md');
  await writeFile(join(row.root, 'Projects/Plan.md'), '# Plan\n#project\nAn externally revised embedding workflow.');
  await fix.app.resources.sync(true);
  result = await fix.request('/api/resources/search', { query: 'embedding', workspaceIds: [row.id] }); assert.equal(result.total, 1); assert.ok(fix.app.resources.version > 0);
  result = await fix.request('/api/resources/search', { query: 'llama type:js' }); assert.equal(result.total, 1);
});

test('Notes AI reuses real Pi conversations, resolves excerpts, enforces scope and applies approved project edits', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); }); const row = await folder(fix, 'ai-notes'), blocked = await folder(fix, 'unselected');
  await save(fix, row, 'Architecture.md', '# Architecture\n## Decision\nKeep notes as plain files.');
  const selection = await connect(fix, mock); let chat = await fix.request('/api/chats', { selection, surface: 'notes', workspaceIds: [row.id] });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Summarize [[Architecture#Decision]].', context: { activeResource: { workspaceId: row.id, path: 'Architecture.md' }, selectedText: 'plain files' } }); await idle(fix, chat.id);
  assert.match(JSON.stringify(mock.requests.at(-1).body.messages), /Keep notes as plain files/); assert.ok(mock.requests.at(-1).body.tools.some(tool => tool.function.name === 'read_resource')); assert.ok(!mock.requests.at(-1).body.tools.some(tool => tool.function.name === 'run_command'));
  chat = await fix.request('/api/chats/' + chat.id); assert.equal(chat.surface, 'notes'); assert.equal(chat.messages.find(row => row.role === 'user').references.length, 1);
  const toolSelection = await connect(fix, mock, { id: 'project-model', model: 'resource-write' });
  const toolChat = await fix.request('/api/chats', { selection: toolSelection, surface: 'notes', workspaceIds: [row.id] });
  await fix.request('/api/chats/' + toolChat.id + '/messages', { text: JSON.stringify({ workspaceId: row.id, path: 'AI note.md', content: '# Created with approval', revision: null }) });
  const approval = await waitFor(async () => (await fix.request('/api/chats/' + toolChat.id)).approvals[0]); assert.ok(approval.preview.changes.length); await assert.rejects(access(join(row.root, 'AI note.md')));
  await fix.request('/api/chats/' + toolChat.id + '/approve', { id: approval.id, allow: true }); const settled = await idle(fix, toolChat.id); assert.equal(settled.cost.calls, 2); assert.equal(await readFile(join(row.root, 'AI note.md'), 'utf8'), '# Created with approval');
  const unauthorized = await fix.request('/api/chats', { selection: toolSelection, workspaceIds: [row.id] });
  await fix.request('/api/chats/' + unauthorized.id + '/messages', { text: JSON.stringify({ workspaceId: blocked.id, path: 'no.md', content: 'no', revision: null }) }); await idle(fix, unauthorized.id); await assert.rejects(access(join(blocked.root, 'no.md')));
  await fix.request('/api/workspaces/' + row.id, { approval: 'automatic', confirm: true }, 'PATCH');
  const automatic = await fix.request('/api/chats', { selection: toolSelection, workspaceIds: [row.id] });
  await fix.request('/api/chats/' + automatic.id + '/messages', { text: JSON.stringify({ workspaceId: row.id, path: 'Auto.md', content: '# Authorized policy', revision: null }) }); await idle(fix, automatic.id); assert.equal(await readFile(join(row.root, 'Auto.md'), 'utf8'), '# Authorized policy');
});

test('provider-exposed reasoning from compatible field formats and Responses is durable and never fabricated', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  for (const model of ['reasoning', 'reasoning-alt', 'native-reasoning', 'test-model']) {
    const id = 'reason-' + model; await fix.request('/api/providers', { id, name: id, api: model === 'native-reasoning' ? 'openai-responses' : 'openai-completions', baseUrl: mock.baseUrl, apiKey: 'mock-key', requiresKey: true, models: [{ id: model, contextWindow: 128000, maxTokens: 1024, reasoning: true, tools: false }] });
    const chat = await fix.request('/api/chats', { selection: { provider: id, model } }); await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Explain.' });
    if (model !== 'test-model') { const partial = await waitFor(async () => { const current = await fix.request('/api/chats/' + chat.id); return current.partialThinking ? current : false; }); assert.equal(partial.phase, 'thinking'); }
    const view = await idle(fix, chat.id), assistant = view.messages.find(row => row.role === 'assistant');
    if (model === 'test-model') assert.equal(assistant.thinking, ''); else assert.match(assistant.thinking, /Provider/);
    assert.doesNotMatch(JSON.stringify(view), /thinkingSignature|encrypted_content|mock-key/);
  }
});

test('managed memory review/automatic/off controls, scoped retrieval, duplication, consolidation, retention and persistence', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); }); const row = await folder(fix, 'memory-project');
  const body = { operation: 'upsert', title: 'Technical decision', content: 'Use ordinary files for the knowledge base.', category: 'decision', workspaceId: row.id, tags: ['architecture'] };
  const one = (await fix.request('/api/memories', body)).entry;
  assert.equal((await fix.request('/api/memories', body)).duplicate, true);
  assert.equal(fix.app.memories.list({ query: 'knowledge files', workspaceIds: [] }).length, 0); assert.equal(fix.app.memories.list({ query: 'knowledge files', workspaceIds: [row.id] }).length, 1);
  const second = (await fix.request('/api/memories', { ...body, title: 'Related preference', content: 'Prefer portable Markdown notes.' })).entry;
  await assert.rejects(fix.request('/api/memories', { ...body, operation: 'merge', supersedes: [one.id, second.id] }), /changed/);
  const combined = (await fix.request('/api/memories', { ...body, operation: 'merge', content: 'Keep Markdown portable with ordinary local files.', supersedes: [one.id, second.id], supersedesRevisions: { [one.id]: one.revision, [second.id]: second.revision } })).entry;
  assert.equal(fix.app.memories.data.entries.length, 1); await assert.rejects(fix.request('/api/memories', { ...body, id: combined.id, revision: 'stale' }), /changed/);
  const selection = await connect(fix, mock, { id: 'memory-agent', model: 'managed-memory' });
  for (const mode of ['review', 'automatic', 'off']) {
    await fix.request('/api/settings', { memoryMode: mode }, 'PATCH'); const chat = await fix.request('/api/chats', { selection });
    await fix.request('/api/chats/' + chat.id + '/messages', { text: JSON.stringify({ operation: 'upsert', title: 'Preference ' + mode, content: 'Preferred response style ' + mode, category: 'preference' }) });
    if (mode === 'review') { const approval = await waitFor(async () => (await fix.request('/api/chats/' + chat.id)).approvals[0]); assert.equal(approval.tool, 'manage_memory'); await fix.request('/api/chats/' + chat.id + '/approve', { id: approval.id, allow: true }); }
    await idle(fix, chat.id); assert.equal(fix.app.memories.data.entries.some(row => row.title === 'Preference ' + mode), mode !== 'off');
  }
  const saved = JSON.parse(await readFile(join(fix.app.store.directory, 'memories.json'), 'utf8')); assert.ok(saved.entries.length >= 3); assert.ok(saved.audit.every(row => typeof row.after === 'string' || row.after === null)); assert.ok(saved.audit.every(row => !row.title));
  const disabledContext = await fix.app.memories.context('Markdown', [row.id]); assert.doesNotMatch(disabledContext.text, /Keep Markdown portable|Preferred response style/);
  fix.app.memories.data.entries[0].expiresAt = Date.now() - 1; await fix.app.memories.expire(); assert.ok(!fix.app.memories.data.entries.some(row => row.id === combined.id));
});
