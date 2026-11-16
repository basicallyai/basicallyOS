/** Conversation-owned documents. Linked documents delegate every content read/write to Resources. */
import { randomUUID, createHash } from 'node:crypto';
import { notePath, noteTitle } from './web/note-names.js';
const revision = text => createHash('sha256').update(text).digest('hex');
const output = value => { if (value && typeof value === 'object' && !Array.isArray(value)) { const { history, generatedMath, uiState, pendingNote, ...publicValue } = value; value = publicValue; } if (typeof value?.content === 'string' && value.content.length > 24000) value = { ...value, content: value.content.slice(0, 24000), truncated: true, nextOffset: 24000, totalChars: value.content.length }; return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} }; };
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const str = { type: 'string' };
export class Canvases {
  constructor({ store, resources, notes, runtime, publish }) { Object.assign(this, { store, resources, notes, runtime, publish }); this.queue = Promise.resolve(); }
  exclusive(fn) { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  assertUserIdle(chat, source) { if (source !== 'AI' && (this.runtime.active.has(chat.id) || this.runtime.reserved.has(chat.id))) throw new Error('Wait for the response to finish before editing Canvas.'); }
  async chat(id) { const chat = await this.runtime.get(id); chat.canvases ||= []; return chat; }
  async migrate(chat) { return this.exclusive(async () => { Object.assign(chat, await this.chat(chat.id)); return this.migrateNow(chat); }); }
  async migrateNow(chat) {
    chat.canvases ||= [];
    for (const row of chat.canvases) if (row.pendingNote) {
      try { const file = await this.resources.read(row.pendingNote); if (revision(file.content) === row.pendingNote.contentHash && file.content === row.content) { await this.finishLink(row, file); await this.store.saveChat(chat); } } catch { /* Keep the standalone content and pending association for explicit recovery. */ }
    }
    if (chat.canvas?.noteId && !chat.canvases.some(row => row.noteId === chat.canvas.noteId)) {
      const row = { canvasId: randomUUID(), conversationId: chat.id, title: noteTitle(chat.canvas.path.split('/').pop()), noteId: chat.canvas.noteId, createdAt: chat.createdAt, updatedAt: Date.now(), revision: null, messageId: null, uiState: {} };
      chat.canvases.push(row); chat.canvas = { canvasId: row.canvasId }; await this.store.saveChat(chat);
    }
  }
  row(chat, id) { const rows = chat.canvases || []; let matches = rows.filter(row => row.canvasId === id || row.noteId === id || row.title.toLocaleLowerCase() === String(id).toLocaleLowerCase()); if (!matches.length && /^\d+$/.test(String(id))) matches = [rows[Number(id) - 1]].filter(Boolean); if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous Canvas title; choose a canvasId from list_canvases.' : 'Canvas not found in this conversation.'); return matches[0]; }
  async current(row, scope) { const { history, pendingNote, ...view } = row; if (row.historicalNoteId) throw new Error('This backup kept the historical note association, not access to that library. Open the original note explicitly to reconnect it.'); if (row.noteId) { const note = await this.notes.byId(row.noteId, scope); return { ...view, ...note, canvasId: row.canvasId, title: noteTitle(note.path.split('/').pop()), noteId: row.noteId }; } return { ...view, content: row.content || '', revision: row.revision || revision(row.content || ''), generatedMath: row.generatedMath || [] }; }
  async list(chat, scope) { await this.migrate(chat); return chat.canvases.map(row => {
    const { content, history, generatedMath, ...metadata } = row;
    if (row.noteId) { const note = this.notes.data.entries.find(note => note.id === row.noteId && !note.deletedAt); try { if (!note) throw new Error(); this.resources.get(note.workspaceId, scope); metadata.title = noteTitle(note.path.split('/').pop()); metadata.workspaceId = note.workspaceId; metadata.path = note.path; } catch { metadata.unavailable = true; } }
    return metadata;
  }); }
  async setUI(chat, id, state) { return this.exclusive(async () => { if (this.runtime.reserved.has(chat.id)) throw new Error('Wait for the conversation operation to finish.'); chat = await this.chat(chat.id); const row = this.row(chat, id); if (typeof state.sourceMode !== 'boolean' || !Number.isFinite(state.scrollTop) || state.scrollTop < 0 || state.scrollTop > 10000000) throw new Error('Invalid document presentation state.'); row.uiState = { sourceMode: state.sourceMode, scrollTop: state.scrollTop, updatedAt: Date.now() }; await this.store.saveChat(chat); return row.uiState; }); }
  async persist(chat, row, show = false) { row.updatedAt = Date.now(); if (show && (!this.runtime.active.has(chat.id) || chat.canvasDismissedRun !== this.runtime.active.get(chat.id).id)) chat.canvas = { canvasId: row.canvasId }; await this.store.saveChat(chat); this.publish(chat.id, 'canvas'); }
  async create(chat, args, source = 'user') { return this.exclusive(async () => {
    this.assertUserIdle(chat, source); chat = await this.chat(chat.id);
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 160 || typeof args.content !== 'string' || Buffer.byteLength(args.content) > 2 * 1024 ** 2) throw new Error('Canvas needs a title (1–160 characters) and Markdown content up to 2 MB.');
    const row = { canvasId: randomUUID(), conversationId: chat.id, title: args.title.trim(), content: args.content, revision: revision(args.title.trim() + '\0' + args.content), createdAt: Date.now(), updatedAt: Date.now(), messageId: args.messageId || chat.inputs?.at(-1)?.timestamp || null, history: [], uiState: {}, generatedMath: source === 'AI' ? this.notes.equations(args.content) : [] };
    chat.canvases ||= []; chat.canvases.push(row); await this.persist(chat, row, true); return this.current(row);
  }); }
  async linkNote(chat, note, scope) { return this.exclusive(async () => { chat = await this.chat(chat.id); const file = await this.notes.byId(note.noteId, scope); let row = chat.canvases?.find(row => row.noteId === note.noteId); if (!row) { row = { canvasId: randomUUID(), conversationId: chat.id, title: noteTitle(file.path.split('/').pop()), noteId: note.noteId, createdAt: Date.now(), updatedAt: Date.now(), messageId: chat.inputs?.at(-1)?.timestamp || null, uiState: {} }; (chat.canvases ||= []).push(row); } await this.persist(chat, row, true); return this.current(row, scope); }); }
  async update(chat, id, args, { scope, source = 'user', plan } = {}) { return this.exclusive(async () => {
    this.assertUserIdle(chat, source); chat = await this.chat(chat.id);
    const row = this.row(chat, id), current = await this.current(row, scope);
    if (args.find !== undefined) { if (typeof args.find !== 'string' || !args.find || typeof args.replace !== 'string' || args.content !== undefined || current.content.split(args.find).length !== 2) throw new Error('Targeted edit needs exactly one matching find string and a replacement; do not combine with full content.'); args = { ...args, content: current.content.replace(args.find, () => args.replace) }; }
    if (row.pendingNote) throw new Error('A Save to Notes operation was interrupted. Retry Save to Notes before editing this document.');
    if (args.revision !== current.revision) throw new Error('Canvas changed since it was read. Reload before saving.');
    if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 160)) throw new Error('Use a title between 1 and 160 characters.');
    if (args.content !== undefined && (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 2 * 1024 ** 2)) throw new Error('Canvas content is limited to 2 MB.');
    if (row.noteId) {
      if (args.title !== undefined && args.title !== current.title && args.content !== undefined) throw new Error('Rename and edit a linked note in separate revision-checked operations.');
      // A linked Canvas never stores a second copy. Resource history, policies and revisions remain authoritative.
      if (args.content !== undefined) await this.resources.commit(plan || await this.resources.plan({ action: 'write', workspaceId: current.workspaceId, path: current.path, revision: current.revision, content: args.content }, scope), source);
      if (args.title !== undefined && args.title !== current.title) { const latest = await this.notes.byId(row.noteId, scope); await this.resources.commit(plan || await this.resources.plan({ action: 'move', workspaceId: latest.workspaceId, path: latest.path, revision: latest.revision, destination: latest.path.split('/').slice(0, -1).concat(notePath(args.title)).join('/') }, scope), source); }
    } else {
      row.history ||= []; row.history.push({ title: row.title, content: row.content, revision: row.revision, generatedMath: row.generatedMath || [], time: Date.now() });
      while (row.history.length > 30 || row.history.reduce((sum, item) => sum + Buffer.byteLength(item.content || ''), 0) > 8 * 1024 ** 2) row.history.shift();
      if (args.content !== undefined) { row.content = args.content; row.revision = revision(row.content); if (source === 'AI') row.generatedMath = this.notes.equations(row.content); }
      if (args.title !== undefined) row.title = args.title.trim();
      row.revision = revision(row.title + '\0' + row.content);
    }
    await this.persist(chat, row, source === 'AI'); return this.current(row, scope);
  }); }
  async finishLink(row, ref) {
    await this.resources.sync(true); await this.notes.reconcile(); row.noteId = this.notes.metadata(ref).noteId;
    if (!row.noteId) throw new Error('The saved note could not be indexed. The Canvas content is preserved.');
    const catalog = this.notes.row(ref); catalog.generatedMath = row.generatedMath || []; await this.notes.save();
    row.title = noteTitle(ref.path.split('/').pop()); delete row.content; delete row.history; delete row.generatedMath; delete row.revision; delete row.pendingNote;
  }
  async noteTarget(row, scope) {
    const workspace = this.resources.list().find(row => row.managed === 'notes'); this.resources.get(workspace.id, scope);
    let path = notePath(row.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')); const base = noteTitle(path);
    for (let i = 1; await this.resources.snapshot({ workspaceId: workspace.id, path }, scope); i++) { if (i > 1000) throw new Error('Too many duplicate note titles. Rename the Canvas.'); path = notePath(base + ' (' + (i + 1) + ')'); }
    return { workspaceId: workspace.id, path };
  }
  async saveToNotes(chat, id, { scope, source = 'user', plan } = {}) { return this.exclusive(async () => {
    this.assertUserIdle(chat, source); chat = await this.chat(chat.id);
    const row = this.row(chat, id); if (row.noteId) return this.current(row, scope);
    const workspace = this.resources.list().find(row => row.managed === 'notes'); this.resources.get(workspace.id, scope);
    if (row.pendingNote) {
      const pending = row.pendingNote, file = await this.resources.read(pending, scope).catch(() => null);
      if (file && revision(file.content) === pending.contentHash && file.content === row.content) { await this.finishLink(row, pending); await this.persist(chat, row); return this.current(row, scope); }
      if (file) throw new Error('The interrupted save target changed externally. Your standalone Canvas is safe; resolve the note conflict before retrying.');
      delete row.pendingNote;
    }
    if (plan && plan.canvasRevision !== (await this.current(row, scope)).revision) throw new Error('Canvas changed after its Save to Notes preview. Review it again.');
    const ref = plan?.canvasTarget || await this.noteTarget(row, scope);
    row.pendingNote = { ...ref, contentHash: revision(row.content) }; await this.store.saveChat(chat);
    await this.resources.commit(plan || await this.resources.plan({ ...ref, action: 'write', content: row.content, revision: null }, scope), source);
    await this.finishLink(row, ref);
    await this.persist(chat, row); return this.current(row, scope);
  }); }
  tools(run) {
    const invoke = (fn, mutation = false) => async (id, args, signal) => {
      if (signal?.aborted) throw new Error('Canvas operation cancelled.');
      const plan = run.filePlans?.get(id);
      if (mutation) { const row = this.row(run.chat, args.canvasId); if (mutation === 'save' && row.noteId) return output(await fn(args)); let workspaceId;
        if (row.noteId) workspaceId = (await this.notes.byId(row.noteId, run.scope)).workspaceId;
        else if (mutation === 'save') workspaceId = this.resources.list().find(row => row.managed === 'notes').id;
        if (workspaceId && !plan) throw new Error('This note operation has not been prepared.');
        for (const change of plan?.changes || []) if (this.resources.get(change.ref.workspaceId, run.scope).approval !== 'automatic' && !run.authorized.has(id)) throw new Error('The folder now requires review. Ask again for approval before changing notes.');
      }
      try { return output(await fn(args, plan)); } finally { if (mutation) { run.filePlans?.delete(id); run.authorized.delete(id); } }
    };
    return [
      { name: 'list_canvases', label: 'List Canvases', description: 'List persisted conversation Canvases in creation order. Resolve titles, ordinal references (first/second), and IDs here; standalone Canvas is NOT a note.', parameters: object({ offset: { type: 'integer', minimum: 0 } }), execute: invoke(async args => { const rows = await this.list(run.chat, run.scope), offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0; return { total: rows.length, offset, canvases: rows.slice(offset, offset + 100).map((row, i) => ({ ...row, position: offset + i + 1 })), nextOffset: offset + 100 < rows.length ? offset + 100 : null }; }) },
      { name: 'create_canvas', label: 'Create Canvas', description: 'Create a standalone Markdown document in this conversation, not a Note. Call separately for every requested document. The complete content commits atomically and remains available after restart.', parameters: { ...object({ title: str, content: str }), required: ['title', 'content'] }, execute: invoke(args => this.create(run.chat, args, 'AI')) },
      { name: 'open_canvas', label: 'Open Canvas', description: 'Read and display an existing Canvas by canvasId, unique title, or 1-based ordinal. Never open for unrelated questions.', parameters: { ...object({ canvasId: str, offset: { type: 'integer', minimum: 0 } }), required: ['canvasId'] }, execute: invoke(async args => { const row = this.row(run.chat, args.canvasId); const file = await this.current(row, run.scope); await this.persist(run.chat, row, true); const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0; return { ...file, content: file.content.slice(offset, offset + 24000), offset, totalChars: file.content.length, truncated: offset + 24000 < file.content.length, nextOffset: offset + 24000 < file.content.length ? offset + 24000 : null }; }) },
      { name: 'edit_canvas', label: 'Edit Canvas', description: 'Revision-checked exact find/replace (preferred), full Markdown update, or rename. Read with open_canvas first; page truncated content with offset before full replacement. Use find/replace to preserve unrelated sections. Linked notes follow project approval rules.', parameters: { ...object({ canvasId: str, revision: str, content: str, title: str, find: str, replace: str }), required: ['canvasId', 'revision'] }, execute: invoke((args, plan) => this.update(run.chat, args.canvasId, args, { scope: run.scope, source: 'AI', plan }), true) },
      { name: 'save_canvas_to_notes', label: 'Save Canvas to Notes', description: 'Save a standalone Canvas to My Notes only when the user asks. Call once for each Canvas requested. Safe unique title; preserves original Canvas ID and establishes one authoritative note. Requires My Notes in authorized scope.', parameters: { ...object({ canvasId: str }), required: ['canvasId'] }, execute: invoke((args, plan) => this.saveToNotes(run.chat, args.canvasId, { scope: run.scope, source: 'AI', plan }), 'save') },
    ];
  }
}
