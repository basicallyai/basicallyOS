import { createRichEditor } from '/vendor/editor.js';
import { copyButton } from '/copy-button.js';
export function createCanvas(options) { return new Canvas(options); }
class Canvas {
  constructor(options) { Object.assign(this, options); this.sequence = 0; this.state = null; this.build(); }
  build() {
    const { el, iconButton, button, guard } = this;
    this.switcher = el('select', { 'aria-label': 'Conversation Canvases', onChange: guard(() => this.choose(this.switcher.value)) });
    this.navigation = el('div', { class: 'canvas-navigation', hidden: true }, el('span', {}, 'Documents'), this.switcher, button('New Canvas', guard(() => this.create()), 'text-button'));
    this.titleNode = el('button', { class: 'canvas-title-text text-button', title: 'Rename Canvas', 'aria-label': 'Rename Canvas', onClick: guard(() => this.rename()) });
    this.statusNode = el('span', { class: 'canvas-status', role: 'status' });
    this.copyButton = copyButton(() => this.state?.content || '', 'Copy Markdown'); this.copyButton.classList.add('canvas-copy');
    this.saveNoteButton = button('Save to Notes', guard(() => this.saveToNotes()), 'text-button');
    this.openButton = iconButton('panel', 'Open in Notes', guard(() => this.state?.noteId && this.onOpenNotes(this.state)));
    this.historyButton = iconButton('refresh', 'Canvas history', guard(() => this.history()));
    this.closeButton = iconButton('close', 'Close Canvas', guard(() => this.close()));
    this.sourceMode = button('Source', () => this.toggleSource(), 'text-button');
    this.editorHost = el('div', { class: 'canvas-rich-editor' });
    this.source = el('textarea', { class: 'canvas-source', 'aria-label': 'Canvas Markdown source', hidden: true });
    this.source.addEventListener('input', () => this.edit(this.source.value));
    for (const target of [this.source, this.editorHost]) target.addEventListener('scroll', () => { clearTimeout(this.presentationTimer); this.presentationTimer = setTimeout(() => this.savePresentation(), 400); }, { passive: true });
    this.notice = el('div', { class: 'canvas-notice', role: 'status', hidden: true });
    this.conflictBar = el('div', { class: 'canvas-conflict', role: 'alert', hidden: true });
    this.document = el('section', { class: 'chat-canvas', 'aria-label': 'Canvas document', hidden: true }, el('header', { class: 'canvas-head' }, el('div', { class: 'canvas-heading' }, el('span', { class: 'canvas-eyebrow' }, 'Canvas'), this.titleNode, this.statusNode), el('div', { class: 'canvas-actions' }, this.sourceMode, this.saveNoteButton, this.openButton, this.historyButton, this.copyButton, this.closeButton)), this.notice, this.conflictBar, this.editorHost, this.source);
    this.root = el('div', { class: 'canvas-workspace' }, this.navigation, this.document);
  }
  mount(parent) { parent.append(this.root); }
  endpoint(id = this.state?.canvasId) { return '/chats/' + this.chatId + '/canvases' + (id ? '/' + id : ''); }
  sync(chat, options = {}) { const task = (this.syncQueue || Promise.resolve()).then(() => this.syncNow(chat, options)); this.syncQueue = task.catch(() => {}); return task; }
  async syncNow(chat, { running = false } = {}) {
    const changedChat = this.chatId !== chat?.id;
    if (changedChat) { await this.flush(); this.reset(); this.chatId = chat?.id; }
    this.running = running;
    const rows = chat?.canvases || [], ref = chat?.canvas;
    this.navigation.hidden = !rows.length;
    this.switcher.replaceChildren(this.el('option', { value: '' }, 'Open a document…'), ...rows.map(row => this.el('option', { value: row.canvasId }, row.title + (row.noteId ? ' · Note' : ''))));
    this.switcher.value = ref?.canvasId || '';
    if (!ref?.canvasId) { if (this.state) { await this.flush(); this.reset(); } return; }
    if (this.state?.canvasId !== ref.canvasId) { await this.flush(); this.reset(); await this.load(ref.canvasId); }
    if (this.rich) this.rich.setEditable(!running && !this.state?.conflict && !this.state?.unavailable);
    this.source.readOnly = running; this.saveNoteButton.disabled = running; this.sourceMode.disabled = running;
    if (!this.state?.unavailable) { this.notice.hidden = !running; this.notice.textContent = running ? 'AI is working. Editing will resume when the response finishes.' : ''; }
    if (this.wasRunning && !running && this.state && !this.state.dirty) await this.load(ref.canvasId);
    this.wasRunning = running;
  }
  savePresentation() { clearTimeout(this.presentationTimer); if (!this.state || !this.chatId) return; const ref = { chatId: this.chatId, canvasId: this.state.canvasId }, uiState = { sourceMode: !this.source.hidden, scrollTop: this.source.hidden ? this.editorHost.scrollTop : this.source.scrollTop, updatedAt: Date.now() }; try { localStorage.setItem('basically:canvas-ui:' + ref.canvasId, JSON.stringify(uiState)); } catch {} this.api('/chats/' + ref.chatId + '/canvases/' + ref.canvasId + '/state', uiState, 'PUT').catch(() => {}); }
  reset() { this.savePresentation(); ++this.sequence; clearTimeout(this.saveTimer); if (this.rich) { this.rich.destroy(); this.rich = null; } this.state = null; this.editorHost.replaceChildren(); this.document.hidden = true; this.conflictBar.hidden = true; this.source.hidden = true; this.editorHost.hidden = false; this.sourceMode.textContent = 'Source'; }
  captureEdits() { if (this.rich && this.state && this.source.hidden) { const text = this.rich.getMarkdown(); if (text !== this.state.content) this.edit(text); } }
  async load(id) {
    this.captureEdits();
    const sequence = ++this.sequence;
    try {
      const file = await this.api(this.endpoint(id)); if (sequence !== this.sequence) return; this.captureEdits();
      if (this.state?.canvasId === id && this.state.dirty && file.content !== this.state.saved) { this.state.disk = file; this.state.conflict = true; this.conflict(); return; }
      let draft; try { draft = JSON.parse(localStorage.getItem('basically:canvas:' + id)); } catch {}
      const content = draft?.content ?? file.content;
      let recoveredUI; try { recoveredUI = JSON.parse(localStorage.getItem('basically:canvas-ui:' + id)); } catch {}
      const savedUI = (recoveredUI?.updatedAt || 0) > (file.uiState?.updatedAt || 0) ? recoveredUI : file.uiState || {};
      const presentation = this.state?.canvasId === file.canvasId ? { sourceMode: !this.source.hidden, scrollTop: this.source.hidden ? this.editorHost.scrollTop : this.source.scrollTop } : savedUI;
      this.state = { ...file, content, saved: file.content, dirty: content !== file.content, conflict: !!draft && draft.revision !== file.revision && content !== file.content, disk: file };
      this.document.hidden = false; this.titleNode.textContent = file.title; this.openButton.hidden = !file.noteId; this.saveNoteButton.hidden = !!file.noteId;
      if (!this.rich) this.rich = createRichEditor({ element: this.editorHost, content, label: 'Edit Canvas document', context: { workspaceId: file.workspaceId, path: file.path }, math: file.generatedMath, onChange: text => this.edit(text), onSave: () => this.save() });
      else { this.rich.setContext({ workspaceId: file.workspaceId, path: file.path }); this.rich.setMath(file.generatedMath); this.rich.setContent(content); }
      this.source.hidden = !presentation.sourceMode; this.editorHost.hidden = !!presentation.sourceMode; this.sourceMode.textContent = presentation.sourceMode ? 'Formatted' : 'Source'; requestAnimationFrame(() => { if (this.state?.canvasId === id) (this.source.hidden ? this.editorHost : this.source).scrollTop = presentation.scrollTop || 0; });
      this.source.value = content; this.statusNode.textContent = this.state.dirty ? 'Recovered draft' : 'Saved';
      if (this.state.conflict) this.conflict(); else if (this.state.dirty) this.schedule();
      this.rich.setEditable(!this.running && !this.state.conflict);
    } catch (error) { if (sequence !== this.sequence) return; this.document.hidden = false; this.statusNode.textContent = 'Unavailable'; this.notice.hidden = false; this.notice.textContent = error.message; if (this.state) this.state.unavailable = true; this.rich?.setEditable(false); }
  }
  edit(content) { const state = this.state; if (!state) return; state.content = content; state.dirty = content !== state.saved; this.statusNode.textContent = state.dirty ? 'Unsaved' : 'Saved'; try { localStorage.setItem('basically:canvas:' + state.canvasId, JSON.stringify({ revision: state.revision, content })); } catch { this.statusNode.textContent = 'Draft storage full — save before closing'; } this.schedule(); }
  schedule() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(this.guard(() => this.save()), 650); }
  async save() {
    const state = this.state; if (!state || !state.dirty || state.conflict || state.unavailable || this.running) return;
    if (state.saving) { await state.saving; if (state.dirty && !state.conflict) return this.save(); return; }
    const content = state.content, endpoint = this.endpoint(state.canvasId); this.statusNode.textContent = 'Saving…';
    state.saving = (async () => { try {
      const file = await this.api(endpoint, { revision: state.revision, content }, 'PATCH'); state.revision = file.revision; state.saved = content; state.dirty = state.content !== content;
      if (!state.dirty) localStorage.removeItem('basically:canvas:' + state.canvasId);
      else localStorage.setItem('basically:canvas:' + state.canvasId, JSON.stringify({ revision: state.revision, content: state.content }));
      this.statusNode.textContent = state.dirty ? 'Unsaved' : 'Saved'; this.onSaved?.();
    } catch (error) { const file = await this.api(endpoint).catch(() => null); if (file && file.revision !== state.revision) { state.disk = file; state.conflict = true; this.conflict(); } else this.statusNode.textContent = 'Not saved: ' + error.message; } finally { state.saving = null; } })();
    await state.saving;
  }
  async flush() { this.captureEdits(); await this.save(); }
  adoptDiskMetadata(state) { const disk = state.disk; Object.assign(state, { workspaceId: disk.workspaceId, path: disk.path, title: disk.title, noteId: disk.noteId, generatedMath: disk.generatedMath }); this.titleNode.textContent = disk.title; this.rich.setContext(disk); this.rich.setMath(disk.generatedMath); }
  conflict() {
    const state = this.state; this.rich?.setEditable(false); this.conflictBar.hidden = false; this.statusNode.textContent = 'Conflict · draft kept';
    this.conflictBar.replaceChildren(this.el('span', {}, 'This document changed elsewhere. Your draft is preserved.'), this.button('Load disk version', () => { this.adoptDiskMetadata(state); state.content = state.saved = state.disk.content; state.revision = state.disk.revision; state.dirty = state.conflict = false; localStorage.removeItem('basically:canvas:' + state.canvasId); this.conflictBar.hidden = true; this.rich.setContent(state.content); this.rich.setEditable(!this.running); this.source.value = state.content; this.statusNode.textContent = 'Saved'; }), this.button('Save my version', this.guard(async () => { this.adoptDiskMetadata(state); state.revision = state.disk.revision; state.conflict = false; this.conflictBar.hidden = true; this.rich.setEditable(!this.running); await this.save(); }), 'danger-button'));
  }
  async refresh() { if (this.state && !this.state.saving) await this.load(this.state.canvasId); }
  async choose(id) { if (!id) return; await this.flush(); await this.onChoose?.(id); }
  async close() { await this.flush(); this.reset(); await this.onClose?.(); }
  toggleSource() { if (this.source.hidden) { const text = this.rich.getMarkdown(); if (text !== this.state.content) this.edit(text); this.source.value = this.state.content; this.source.hidden = false; this.editorHost.hidden = true; this.sourceMode.textContent = 'Formatted'; } else { this.rich.setContent(this.source.value); this.source.hidden = true; this.editorHost.hidden = false; this.sourceMode.textContent = 'Source'; } this.savePresentation(); }
  async saveToNotes() { await this.flush(); if (this.state?.dirty) throw new Error('Resolve unsaved changes before saving to Notes.'); const file = await this.api(this.endpoint() + '/notes', {}); await this.load(file.canvasId); }
  async rename() { if (this.running || !this.state) return; const title = prompt('Canvas title', this.state.title); if (!title?.trim()) return; await this.flush(); const file = await this.api(this.endpoint(), { title, revision: this.state.revision }, 'PATCH'); await this.load(file.canvasId); }
  async create() { if (!this.chatId || this.running) return; const title = prompt('Canvas title', 'Untitled document'); if (!title) return; const file = await this.api('/chats/' + this.chatId + '/canvases', { title, content: '' }); await this.onChoose(file.canvasId); }
  async history() {
    const result = await this.api(this.endpoint() + '/history'); this.notice.hidden = false;
    this.notice.replaceChildren(this.el('strong', {}, 'Document history'), ...result.history.slice().reverse().map(row => this.el('div', { class: 'canvas-history-row' }, this.el('span', {}, new Date(row.time || row.createdAt).toLocaleString() + ' · ' + (row.title || row.action || 'Revision')), this.state.noteId ? this.button('Open Notes history', this.guard(async () => { await this.onOpenNotes(this.state); })) : this.button('Restore', this.guard(async () => { await this.flush(); const file = await this.api(this.endpoint() + '/restore', { historyRevision: row.revision, revision: this.state.revision }); await this.load(file.canvasId); })))));
    if (!result.history.length) this.notice.append(this.el('p', {}, 'No previous revisions yet.'));
  }
  settle() { this.rich?.setEditable(!this.running && !this.state?.conflict && !this.state?.unavailable); }
}
