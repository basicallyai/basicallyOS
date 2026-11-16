import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { Resources } from '../resources.mjs';
import { atomicJson } from '../store.mjs';
import { resourceTools } from '../resource-tools.mjs';
import { preserveLineEndings, toggleTaskText } from '../web/editor-text.js';
import { wikiLinks, sectionExcerpt } from '../web/wiki.js';
async function folder(fix) { const root = join(fix.directory, 'vault'); await mkdir(root); return { ...(await fix.request('/api/workspaces', { path: root, confirm: true })), root }; }
const save = (fix, row, path, content, revision = null) => fix.request('/api/resources/save', { workspaceId: row.id, path, content, revision });

test('source edits preserve mixed line endings, BOMs and untouched bytes; task editing excludes code', () => {
  const original = '\uFEFFA\r\nB\nC\rD'; assert.equal(preserveLineEndings(original, '\uFEFFA\nB changed\nC\nD'), '\uFEFFA\r\nB changed\nC\rD');
  assert.equal(preserveLineEndings('a\r\nb\r\n', 'a\nb\nc\n'), 'a\r\nb\r\nc\r\n'); assert.equal(preserveLineEndings(original, original), original);
  const content = '```md\n- [ ] Code task\n```\n- [ ] Real task\n'; assert.equal(toggleTaskText(content, 0, true, 1), content.replace('- [ ] Real', '- [x] Real')); assert.equal(toggleTaskText(content, 1, true, 1), null);
  assert.deepEqual(wikiLinks('[[Real]]\n```md\n[[Unclosed code fence]]').map(row => row.target), ['Real']); assert.equal(wikiLinks(String.raw`\[[Escaped]]`).length, 0); assert.equal(wikiLinks('    [[Indented code]]').length, 0);
  assert.equal(sectionExcerpt('```md\n# Target\nNot a heading\n```\n# Target\nReal section', 'Target').text, '# Target\nReal section');
  assert.deepEqual(wikiLinks('[[app/[id].tsx]] [[Note [Draft]]]').map(row => row.target), ['app/[id].tsx', 'Note [Draft]']);
  assert.equal(wikiLinks('> ```md\n> [[Quoted code]]').length, 0);
});

test('filesystem identities follow ordinary external renames and reject replacement of an authorized root', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix); await save(fix, row, 'Before.md', '# Before'); const events = [], publish = fix.app.resources.publish;
  fix.app.resources.publish = (...args) => { events.push(args[2]); publish(...args); };
  await rename(join(row.root, 'Before.md'), join(row.root, 'After.md')); await fix.app.resources.sync(true);
  assert.ok(events.some(event => event.moves?.some(move => move.before.path === 'Before.md' && move.after.path === 'After.md')));
  await rename(row.root, row.root + '-original'); await mkdir(row.root);
  await assert.rejects(fix.request('/api/resources/file?' + new URLSearchParams({ workspaceId: row.id, path: 'After.md' })), /changed identity/);
  assert.equal(await readFile(join(row.root + '-original', 'After.md'), 'utf8'), '# Before');
});

test('interrupted operation journals roll back only matching versions and retain unexpected external edits for manual recovery', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix);
  const created = await save(fix, row, 'new/folder/Created.md', '# New file'); await fix.request('/api/resources/undo', { id: created.operationId }); await assert.rejects(readFile(join(row.root, 'new/folder/Created.md')));
  const one = await save(fix, row, 'Recover.md', '# Original'), two = await save(fix, row, 'Keep.md', '# Original two'), service = fix.app.resources;
  for (const [path, revision] of [['Recover.md', one.file.revision], ['Keep.md', two.file.revision]]) {
    const plan = await service.plan({ action: 'write', workspaceId: row.id, path, revision, content: '# Partially applied' }); await atomicJson(join(service.historyDirectory, plan.id + '.json'), { ...plan, source: 'simulated interruption', status: 'preparing' }); await service.applyRows(plan.changes, 'after');
  }
  await writeFile(join(row.root, 'Keep.md'), '# External edit after interruption'); await service.close();
  const restored = new Resources(fix.app.store); await restored.initialize(); t.after(() => restored.close());
  assert.equal(await readFile(join(row.root, 'Recover.md'), 'utf8'), '# Original'); assert.equal(await readFile(join(row.root, 'Keep.md'), 'utf8'), '# External edit after interruption');
  const history = await restored.history(); assert.ok(history.some(row => row.status === 'rolled-back')); assert.ok(history.some(row => row.status === 'recovery-required'));
});

test('failed multi-file writes never roll back over a detected external edit', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix), original = await save(fix, row, 'Note.md', '# Before'), service = fix.app.resources;
  const plan = await service.plan({ action: 'write', workspaceId: row.id, path: 'Note.md', revision: original.file.revision, content: '# After' }), apply = service.applyRows.bind(service);
  service.applyRows = async (rows, key) => { await apply(rows, key); if (key === 'after') { await writeFile(join(row.root, 'Note.md'), '# External edit during commit'); throw new Error('Simulated failure'); } };
  await assert.rejects(service.commit(plan), /Simulated failure/); assert.equal(await readFile(join(row.root, 'Note.md'), 'utf8'), '# External edit during commit'); assert.ok((await service.history()).some(row => row.status === 'recovery-required'));
});

test('targeted retrieval caps long lines and chat excerpts, and backups preserve Notes history without importing filesystem grants', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix); await save(fix, row, 'Long.md', 'a'.repeat(12000) + 'Second chunk');
  const tool = resourceTools(fix.app.resources, { scope: [row.id] }).find(tool => tool.name === 'read_resource');
  let result = JSON.parse((await tool.execute('read1', { workspaceId: row.id, path: 'Long.md' })).content[0].text); assert.equal(result.content.length, 12000); assert.equal(result.nextStartCharacter, 12000); assert.equal(result.truncated, true);
  result = JSON.parse((await tool.execute('read2', { workspaceId: row.id, path: 'Long.md', startCharacter: 12000 })).content[0].text); assert.equal(result.content, 'Second chunk');
  const refs = await fix.app.resources.references(Array.from({ length: 8 }, () => '[[Long]]').join(' '), null, [row.id]); assert.equal(refs.refs.length, 4); assert.match(refs.text, /Reference budget reached/);
  const chat = await fix.app.store.createChat(null, { surface: 'notes', workspaceIds: [row.id] }); chat.activeResource = { workspaceId: row.id, path: 'Long.md' }; await fix.app.store.saveChat(chat);
  const backup = await fix.request('/api/chats/' + chat.id + '/export'), imported = await fix.request('/api/chats/import', backup), restored = await fix.app.store.chat(imported.imported[0].id);
  assert.equal(restored.surface, 'notes'); assert.deepEqual(restored.workspaceIds, []); assert.deepEqual(restored.historicalWorkspaceIds, [row.id]); assert.deepEqual(restored.historicalActiveResource, chat.activeResource); assert.equal(restored.activeResource, undefined);
});

test('editor layout persists authorized tabs, active panes and split sizes while rejecting unsafe metadata', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const row = await folder(fix); await save(fix, row, 'Note.md', '# Note');
  const layout = { version: 1, orientation: 'horizontal', context: 'links', activeWorkspace: row.id, activePane: 'primary', panes: [{ id: 'primary', weight: .7, active: 'note-tab', tabs: [{ id: 'note-tab', workspaceId: row.id, path: 'Note.md', mode: 'source' }] }], expandedFolders: { [row.id]: [''] } };
  await fix.request('/api/knowledge/layout', layout, 'PUT'); assert.deepEqual(await fix.request('/api/knowledge/layout'), layout);
  await assert.rejects(fix.request('/api/knowledge/layout', { ...layout, context: 'bad' }, 'PUT'), /layout/); await assert.rejects(fix.request('/api/knowledge/layout', { ...layout, activePane: 'missing' }, 'PUT'), /pane/);
  const bad = structuredClone(layout); bad.panes[0].tabs[0].path = '../private'; await assert.rejects(fix.request('/api/knowledge/layout', bad, 'PUT'), /relative/);
});
