/** Persistent note identities plus the AI-only math origin marker. Content stays in the resource service. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Marked } from 'marked';
import { atomicJson, readJson } from './store.mjs';
import { mathToken } from './web/math.js';
import { notePath, noteTitle, isNotePath } from './web/note-names.js';
import { relevance } from './semantic.mjs';
const parser = new Marked({ extensions: [{ name: 'mathBlock', level: 'block', tokenizer: source => mathToken(source, true) }, { name: 'mathInline', level: 'inline', tokenizer: source => mathToken(source) }] });
function equations(text) { const result = new Set(); parser.walkTokens(parser.lexer(text || ''), token => { if (typeof token.tex === 'string' && !token.pending && token.tex.length <= 20000) result.add(token.tex); }); return result; }
export class Notes {
  constructor(resources) { this.resources = resources; this.queue = Promise.resolve(); }
  async initialize() { this.file = join(this.resources.store.directory, 'note-catalog.json'); this.data = await readJson(this.file, { version: 1, entries: [] }); this.resources.notes = this; await this.reconcile(); }
  row(ref) { return this.data.entries.find(row => !row.deletedAt && row.workspaceId === ref.workspaceId && row.path === ref.path); }
  /** Math created by a model is tracked separately so user-authored dollar signs stay literal. */
  metadata(ref) { const row = this.row(ref); return row ? { noteId: row.id, generatedMath: row.generatedMath || [] } : {}; }
  save() { return atomicJson(this.file, this.data); }
  equations(text) { return [...equations(text)].slice(0, 500); }
  async reconcile(moves = []) { const task = this.queue.then(async () => {
    for (const move of moves) for (const row of this.data.entries) if (!row.deletedAt && row.workspaceId === move.before.workspaceId && (row.path === move.before.path || row.path.startsWith(move.before.path + '/'))) { row.path = move.after.path + row.path.slice(move.before.path.length); row.workspaceId = move.after.workspaceId; }
    const entries = this.resources.entries().filter(row => !row.directory && isNotePath(row.path)), seen = new Set();
    for (const entry of entries) { let row = this.row(entry) || this.data.entries.find(row => !seen.has(row.id) && !row.deletedAt && row.identity === entry.identity && row.workspaceId === entry.workspaceId); if (!row) { row = { id: randomUUID(), createdAt: Date.now(), generatedMath: [] }; this.data.entries.push(row); } Object.assign(row, { workspaceId: entry.workspaceId, path: entry.path, identity: entry.identity, deletedAt: null }); seen.add(row.id); }
    for (const row of this.data.entries) if (seen.has(row.id)) row.deletedAt = null; else if (!row.deletedAt && this.resources.index.has(row.workspaceId) && !this.resources.index.get(row.workspaceId).limited) row.deletedAt = Date.now();
    this.data.entries = this.data.entries.filter(row => !row.deletedAt || keepDeleted(row)).slice(-40000);
    await this.save();
  }); this.queue = task.catch(() => {}); return task; }
  async track(plan, source) { await this.reconcile(plan.moves || []); const rows = []; for (const change of plan.changes) { const row = this.row(change.ref); if (!row || !change.after?.data) continue; const prior = equations(change.before?.data ? Buffer.from(change.before.data, 'base64').toString('utf8') : ''), current = equations(Buffer.from(change.after.data, 'base64').toString('utf8')), generated = new Set(row.generatedMath || []); row.generatedMath = [...current].filter(tex => generated.has(tex) || /^AI/.test(source) && !prior.has(tex)).slice(0, 500); rows.push({ workspaceId: row.workspaceId, path: row.path, noteId: row.id }); }
    if (rows.length) await this.save(); return rows;
  }
  async byId(id, scope) { await this.resources.sync(); const row = this.data.entries.find(row => row.id === id && !row.deletedAt); if (!row) throw new Error('This note was deleted or is unavailable.'); this.resources.get(row.workspaceId, scope); this.resources.get(row.workspaceId); return this.resources.read({ workspaceId: row.workspaceId, path: row.path }, scope); }
  async find(query, scope) { await this.resources.sync(); scope.forEach(id => this.resources.get(id)); const normalized = noteTitle(query).toLocaleLowerCase().trim(), rows = this.resources.entries(scope).filter(row => !row.directory && isNotePath(row.path)); const matches = rows.map(row => { const title = noteTitle(row.name), headings = row.headings || [], exact = [title, noteTitle(row.path), headings[0] || ''].some(value => value.toLocaleLowerCase() === normalized); return { ...this.metadata(row), workspaceId: row.workspaceId, path: row.path, title, location: noteTitle(row.path), heading: headings[0] || '', score: exact ? 2 : relevance(query, title + ' ' + headings.join(' ')) * .65 + relevance(query, row.content || '') * .35, snippet: (row.content || '').slice(0, 400) }; }).filter(row => !query || row.score > .04).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)); return { matches: matches.slice(0, 20), ambiguous: matches.length > 1 && matches[0].score === matches[1].score, limited: scope.some(id => this.resources.index.get(id)?.limited) }; }
  async importFiles(files) {
    if (!Array.isArray(files) || !files.length || files.length > 200) throw new Error('Import 1–200 Markdown files at a time.');
    let bytes = 0;
    const prepared = files.map(file => {
      if (typeof file.path !== 'string' || !isNotePath(file.path) || file.path.length > 500 || file.path.split(/[\\/]/).some(part => !part || part === '..' || part === '.') || /^[\\/]|^[A-Za-z]:/.test(file.path) || typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('Import valid relative Markdown paths only.');
      const data = Buffer.from(file.data, 'base64'); bytes += data.length;
      if (data.length > 2 * 1024 ** 2 || bytes > 12 * 1024 ** 2 || data.includes(0)) throw new Error('Import UTF-8 Markdown up to 2 MB per file and 12 MB per batch.');
      new TextDecoder('utf-8', { fatal: true }).decode(data);
      return { path: file.path.replace(/\\/g, '/'), content: data.toString('utf8') };
    });
    const workspaceId = this.resources.list().find(row => row.managed === 'notes').id, imported = [], errors = [];
    for (const file of prepared) { try {
      let path = file.path, index = 1;
      while (await this.resources.snapshot({ workspaceId, path })) { path = noteTitle(file.path) + ' (' + (++index) + ').md'; if (index > 1000) throw new Error('Too many duplicates.'); }
      await this.resources.commit(await this.resources.plan({ action: 'write', workspaceId, path, content: file.content, revision: null }), 'user import');
      imported.push({ workspaceId, path });
    } catch (error) { errors.push({ path: file.path, error: error.message }); } }
    await this.resources.sync(true); await this.reconcile(); return { imported: imported.map(ref => ({ ...ref, ...this.metadata(ref) })), errors };
  }
  async open(run, ref) {
    const file = ref?.noteId ? await this.byId(ref.noteId, run.scope) : await this.resources.read(ref, run.scope);
    if (!isNotePath(file.path)) throw new Error('Canvas opens Markdown notes, not arbitrary workspace files.');
    await this.reconcile(); const noteId = this.row(file)?.id;
    if (!noteId) throw new Error('This note is outside the bounded note index; open it from the file explorer instead.');
    if (this.canvases) return this.canvases.linkNote(run.chat, { noteId }, run.scope);
    run.chat.canvas = { noteId, workspaceId: file.workspaceId, path: file.path }; run.chat.activeResource = { workspaceId: file.workspaceId, path: file.path };
    await this.resources.store.saveChat(run.chat); this.resources.publish?.(run.chat.id, 'canvas');
    return { ...run.chat.canvas, title: noteTitle(file.path), revision: file.revision };
  }
}
function keepDeleted(row) { return Date.now() - (row.deletedAt || 0) < 7 * 86400000; }
export function noteTools(notes, run) { const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: {} }); return [
  { name: 'find_notes', label: 'Find notes', description: 'Search the user’s actual notes by title, filename (with or without .md), heading, content or related concept. Use this whenever the user refers to a note by name or description. If the result is ambiguous or has several plausible matches, ask the user which note they mean instead of guessing.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, async execute(_id, args) { if (!run.scope.length) return result({ scopeRequired: true, message: 'No Notes libraries are authorized for this conversation. Ask the user to enable My Notes with the composer folder control, then retry. Do not invent note contents.' }); await notes.reconcile(); return result(await notes.find(args.query, run.scope)); } },
  { name: 'open_note', label: 'Open note in Canvas', description: 'Open a note in the conversation Canvas using noteId from find_notes. Read its content with read_resource (same workspaceId/path) before editing; edit with edit_resource for targeted changes or write_resource for a complete revision. Never rewrite unrelated sections. The user sees the real note, synchronized with Notes.', parameters: { type: 'object', properties: { noteId: { type: 'string' } }, required: ['noteId'], additionalProperties: false }, async execute(_id, args) { return result(await notes.open(run, args)); } },
]; }
export { notePath };
