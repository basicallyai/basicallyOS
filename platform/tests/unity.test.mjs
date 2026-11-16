import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { notePath, noteTitle } from '../web/note-names.js';

const notesRow = fix => fix.request('/api/workspaces').then(result => result.workspaces.find(row => row.managed === 'notes'));
const create = (fix, row, path, content = '') => fix.request('/api/resources/save', { workspaceId: row.id, path, content, revision: null });
const readNote = (fix, row, path) => fix.request('/api/resources/file?' + new URLSearchParams({ workspaceId: row.id, path }));
const find = (fix, row, query) => fix.request('/api/notes/search', { query, workspaceIds: [row.id] });
const move = async (fix, row, path, destination) => { const file = await readNote(fix, row, path).catch(() => ({ revision: 'directory' })); const preview = await fix.request('/api/resources/plan', { action: 'move', workspaceId: row.id, path, revision: file.revision, destination, destinationWorkspaceId: row.id }); return fix.request('/api/resources/apply', { id: preview.id }); };
const idle = (fix, id) => waitFor(async () => { const chat = await fix.request('/api/chats/' + id); return !chat.running && chat.cost.calls ? chat : false; });

test('notes keep one stable identity while titles stay extension-free and duplicates stay explicit', async t => {
  const fix = await fixture(); t.after(() => fix.close()); const notes = await notesRow(fix);
  assert.equal(notePath('Architecture'), 'Architecture.md');
  assert.equal(notePath('research/Architecture.md'), 'research/Architecture.md');
  assert.equal(noteTitle('research/Architecture.md'), 'research/Architecture');
  await create(fix, notes, 'Architecture.md', '# Attention\n\nTokenization decisions for the vocabulary.\n');
  const first = await find(fix, notes, 'attention'); assert.equal(first.matches.length, 1);
  const id = first.matches[0].noteId; assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(first.matches[0].title, 'Architecture'); assert.partialDeepStrictEqual({ path: first.matches[0].path }, { path: 'Architecture.md' });
  for (const query of ['Architecture', 'architecture.md', 'ARCHITECTURE']) assert.equal((await find(fix, notes, query)).matches[0].noteId, id, query);
  assert.equal((await find(fix, notes, 'tokenizer vocabulary')).matches[0].noteId, id, 'related concepts retrieve the note');
  const note = await fix.request('/api/notes/' + id); assert.equal(note.title, 'Architecture'); assert.equal(note.revision, (await readNote(fix, notes, 'Architecture.md')).revision);

  // Rename keeps the identity and the .md implementation detail, never the user-facing title.
  await move(fix, notes, 'Architecture.md', 'research/Model architecture.md');
  assert.equal((await fix.request('/api/notes/' + id)).path, 'research/Model architecture.md');
  assert.equal((await find(fix, notes, 'Model architecture')).matches[0].noteId, id);

  // Duplicate exact titles are reported as ambiguous instead of silently picked.
  await create(fix, notes, 'Duplicate.md', '# Duplicate\n\nOne copy');
  await create(fix, notes, 'archive/Duplicate.md', '# Duplicate\n\nAnother copy');
  const duplicates = await find(fix, notes, 'Duplicate');
  assert.equal(duplicates.matches.filter(row => row.title === 'Duplicate').length, 2);
  assert.equal(new Set(duplicates.matches.filter(row => row.title === 'Duplicate').map(row => row.noteId)).size, 2, 'separate files never share an identity');

  await assert.rejects(fix.request('/api/notes/00000000-0000-4000-8000-000000000000'), /deleted|unavailable/i);
});

test('ordinary chat finds, opens in Canvas and edits the real note through tools', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const notes = await notesRow(fix); await create(fix, notes, 'Architecture.md', '# Attention\n\nTokenization decisions\n\nThe encoder is unchanged.\n');
  await fix.request('/api/providers', { id: 'notes-ai', name: 'Notes AI', api: 'openai-completions', baseUrl: mock.baseUrl, apiKey: 'k', models: [{ id: 'note-canvas', name: 'Canvas model', contextWindow: 128000, maxTokens: 2048, tools: true }] });
  const chat = await fix.request('/api/chats', { selection: { provider: 'notes-ai', model: 'note-canvas' }, workspaceIds: [notes.id] });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Update my Architecture note about attention.' });
  const approvals = [];
  const settled = await waitFor(async () => {
    const view = await fix.request('/api/chats/' + chat.id);
    for (const approval of view.approvals) { approvals.push(approval.tool); await fix.request('/api/chats/' + chat.id + '/approve', { id: approval.id, allow: true }); }
    return view.canvas && !view.running && view.cost.calls ? view : false;
  }, 15000);
  assert.deepEqual(approvals, ['edit_resource'], 'note edits still require the folder review policy');
  assert.ok(settled.canvas.canvasId);
  const document = await fix.request('/api/chats/' + chat.id + '/canvases/' + settled.canvas.canvasId);
  assert.ok(document.noteId); assert.equal(document.path, 'Architecture.md');
  const file = await readFile(join(notes.root, 'Architecture.md'), 'utf8');
  assert.match(file, /Tokenization decisions \(updated by AI\)/);
  assert.match(file, /The encoder is unchanged\./, 'targeted AI edit preserves unrelated sections');
  assert.ok(settled.messages.some(message => message.role === 'tool' && message.name === 'open_note' && message.status === 'done'));
  assert.ok(settled.messages.some(message => message.role === 'tool' && message.name === 'find_notes'));
  assert.ok(settled.messages.some(message => message.name === 'edit_resource' && message.status === 'done'));
  assert.equal((await fix.request('/api/notes/' + document.noteId)).content.includes('updated by AI'), true, 'Canvas reads the same file');
  const tools = mock.requests.at(-1).body.tools.map(tool => tool.function.name);
  assert.ok(tools.includes('find_notes') && tools.includes('open_note'));
});

test('ambiguous note references are surfaced instead of guessed', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const notes = await notesRow(fix); await create(fix, notes, 'Shared.md', '# Shared\n\nFirst'); await create(fix, notes, 'archive/Shared.md', '# Shared\n\nSecond');
  const result = await find(fix, notes, 'Shared');
  assert.equal(result.ambiguous, true); assert.equal(result.matches.length, 2);
});

test('memory ranks semantic matches, distinguishes certainty, refuses contradictions and honours per-chat opt-out', async t => {
  const fix = await fixture(), mock = await mockProvider(); t.after(async () => { await fix.close(); await mock.close(); });
  const saved = await fix.request('/api/memories', { operation: 'upsert', title: 'Scripting preference', content: 'I prefer JavaScript for small scripts.', category: 'preference', certainty: 'stated', tags: ['code'] });
  assert.equal(saved.entry.certainty, 'stated');
  const concept = await fix.request('/api/memories', { operation: 'upsert', title: 'Lexicon pipeline', content: 'The corpus builder assembles a lexicon from source documents.', category: 'project', certainty: 'inferred' });
  assert.equal(concept.entry.certainty, 'inferred');
  const semantic = await fix.request('/api/memories?q=vocabulary%20tokenizer');
  assert.ok(semantic.entries.some(row => row.id === concept.entry.id), 'related concepts retrieve without a literal word match');
  assert.equal(semantic.entries.find(row => row.id === concept.entry.id).certainty, 'inferred');

  // A second, contradictory memory under the same title must be resolved explicitly.
  await assert.rejects(fix.request('/api/memories', { operation: 'upsert', title: 'Scripting preference', content: 'I prefer Python for small scripts.', category: 'preference' }), /already says something different/);
  const latest = (await fix.request('/api/memories')).entries.find(row => row.id === saved.entry.id);
  const merged = await fix.request('/api/memories', { operation: 'merge', title: 'Scripting preference', content: 'I prefer Python for small scripts.', category: 'preference', id: saved.entry.id, revision: latest.revision, supersedes: [saved.entry.id], supersedesRevisions: { [saved.entry.id]: latest.revision } });
  assert.equal(merged.entry.content, 'I prefer Python for small scripts.');
  assert.equal((await fix.request('/api/memories')).entries.filter(row => row.title === 'Scripting preference').length, 1);

  await connect(fix, mock, { id: 'memory-check', model: 'simple' });
  const chat = await fix.request('/api/chats', { selection: { provider: 'memory-check', model: 'simple' } });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Which scripting language do I prefer?' });
  await idle(fix, chat.id);
  const system = mock.requests[0].body.messages.find(message => message.role === 'system').content;
  assert.match(system, /I prefer Python for small scripts/);
  assert.match(system, /Relevant managed memories/);
  const tools = mock.requests[0].body.tools.map(tool => tool.function.name);
  assert.ok(tools.includes('search_memory'));

  await fix.request('/api/chats/' + chat.id, { memoryDisabled: true }, 'PATCH');
  const before = mock.requests.length;
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'What do I prefer?' });
  await waitFor(async () => mock.requests.length > before && !(await fix.request('/api/chats/' + chat.id)).running);
  const next = mock.requests.at(-1);
  assert.doesNotMatch(next.body.messages.find(message => message.role === 'system').content, /Relevant managed memories|I prefer Python/);
  assert.ok(!next.body.tools.map(tool => tool.function.name).includes('search_memory'), 'memory tools are absent when memory is off for the conversation');
  const view = await fix.request('/api/chats/' + chat.id); assert.equal(view.memoryDisabled, true);

  await fix.request('/api/memories', { operation: 'delete', id: merged.entry.id, revision: merged.entry.revision });
  assert.ok(!(await fix.request('/api/memories')).entries.some(row => row.id === merged.entry.id));
});
