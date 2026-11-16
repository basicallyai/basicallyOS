import { preserveLineEndings, toggleTaskText } from './editor-text.js';
import { markdown, codePreview } from '/markdown.js';
import { wikiLinks } from '/wiki.js';
import { divider, panelSize, savePanelSize } from '/split-layout.js';
import { notePath, noteTitle, isNotePath } from '/note-names.js';
import { createRichEditor } from '/vendor/editor.js';
const key = ref => ref.workspaceId + '::' + ref.path;
const filename = path => path.split('/').pop();
/** .md is an implementation detail; ordinary non-note files keep their real names. */
const displayPath = path => isNotePath(path) ? path.replace(/\.(md|markdown)$/i, '') : path;
const displayName = path => filename(displayPath(path));
export function createKnowledge(helpers) { return new Knowledge(helpers); }
class Knowledge {
  constructor(h) { Object.assign(this, h); this.docs = new Map(); this.workspaces = []; this.expanded = new Set(['']); this.trees = new Map(); this.activePane = 'primary'; this.visible = false; this.searchSequence = 0; this.selection = ''; this.layout = { orientation: 'horizontal', panes: [{ id: 'primary', tabs: [], active: null }], context: 'links' }; }
  async initialize() {
    const [folders, layout] = await Promise.all([this.api('/workspaces'), this.api('/knowledge/layout')]); this.workspaces = folders.workspaces; this.layout = layout; this.notesAi = normalizePlacement(layout.notesAi); this.layout.notesAi = this.notesAi;
    // Upgrade only the old presentation default; no document content is migrated.
    for (const pane of this.layout.panes) for (const tab of pane.tabs) if (isNotePath(tab.path) && ['split', 'rendered'].includes(tab.mode)) tab.mode = 'rich';
    this.layout.panes = this.layout.panes.map(pane => { const tabs = pane.tabs.filter(tab => this.workspaces.some(row => row.id === tab.workspaceId)); return { ...pane, tabs, active: tabs.some(tab => tab.id === pane.active) ? pane.active : tabs[0]?.id || null }; });
    this.layout.activeWorkspace = this.workspaces.find(row => row.id === layout.activeWorkspace)?.id || this.workspaces[0]?.id || null;
    this.activePane = this.layout.panes.some(pane => pane.id === this.layout.activePane) ? this.layout.activePane : this.layout.panes[0].id; this.expanded = new Set(this.layout.expandedFolders?.[this.layout.activeWorkspace] || ['']);
    this.build(); this.renderFolders();
    for (const pane of this.layout.panes) for (const tab of pane.tabs) await this.load(tab).catch(error => this.toast(error.message));
    this.renderPanes(); this.refreshTree();
  }
  build() {
    const { el, iconButton, button, guard } = this;
    this.root = document.querySelector('#knowledge-main'); this.sidebar = document.querySelector('#knowledge-sidebar');
    this.workspaceSelect = el('select', { 'aria-label': 'Active workspace', onChange: guard(async event => { this.rememberFolders(); this.layout.activeWorkspace = event.target.value; this.expanded = new Set(this.layout.expandedFolders?.[event.target.value] || ['']); this.activeFolder = ''; await this.refreshTree(); this.persist(); this.onScopeChanged(this.layout.activeWorkspace); }) });
    this.search = el('input', { type: 'search', placeholder: 'Search files, notes, tags…', 'aria-label': 'Search workspace', onInput: () => { clearTimeout(this.searchTimer); this.searchTimer = setTimeout(guard(() => this.runSearch()), 180); } });
    this.sidebar.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
    this.sidebar.addEventListener('drop', guard(async event => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopImmediatePropagation(); await this.importDropped(event.dataTransfer); } }), true);
    this.tree = el('div', { class: 'knowledge-tree', role: 'tree', 'aria-label': 'Workspace files' });
    this.tree.addEventListener('dragover', event => event.preventDefault()); this.tree.addEventListener('drop', guard(event => { if (event.target === this.tree) return this.dropFile(event, ''); }));
    this.sidebar.replaceChildren(el('div', { class: 'vault-switcher' }, this.workspaceSelect, iconButton('plus', 'Attach local folder', () => this.attachDialog())),
      el('div', { class: 'knowledge-search' }, this.icon('search'), this.search), el('p', { class: 'search-syntax' }, 'Filters: path:folder type:md tag:project'),
      el('div', { class: 'explorer-actions' }, button('New note', guard(() => this.newFile())), button('Import Notes', () => this.importDialog(), 'text-button'), iconButton('folder', 'New folder', guard(() => this.newFolder())), iconButton('sliders', 'Workspace settings', guard(() => this.workspaceSettings())), iconButton('refresh', 'Refresh files', guard(() => this.refreshTree()))), this.tree);
    this.title = el('span', { class: 'knowledge-title' }, 'Your knowledge, connected.');
    this.panes = el('div', { class: 'editor-panes' }); this.context = el('aside', { class: 'knowledge-context', 'aria-label': 'Document connections and Notes AI' });
    this.linksPanel = el('div', { class: 'links-panel' }); this.aiHost = el('div', { id: 'notes-ai-host', class: 'notes-ai-host' });
    this.placementSelect = el('select', { class: 'ai-placement-select', 'aria-label': 'Notes AI placement', onChange: guard(event => this.setPlacement(event.target.value)) },
      ...[['right', 'Right sidebar'], ['left', 'Left sidebar'], ['bottom', 'Bottom panel'], ['floating', 'Floating panel'], ['split', 'Split with editor']].map(([value, label]) => el('option', { value }, label)));
    this.context.append(el('div', { class: 'context-tabs' }, button('Connections', () => this.setContext('links')), button('Notes AI', () => this.setContext('ai')),
      el('span', { class: 'context-spacer' }), iconButton('chat', 'Notes AI conversations', this.guard(() => this.onConversations())), iconButton('plus', 'New Notes AI conversation', () => { this.newConversation(); this.setContext('ai'); }),
      iconButton('move', 'Move Notes AI panel', () => this.placementDialog()), iconButton('close', 'Hide side panel', () => this.setContext('none'))), this.linksPanel, this.aiHost);
    this.side = el('div', { class: 'notes-side' }, this.contextDivider = null, this.context);
    this.contextDivider = divider({ axis: () => this.notesAi.placement === 'bottom' ? 'y' : 'x', label: 'Resize Notes AI panel', min: () => this.notesAi.placement === 'bottom' ? 160 : 240,
      max: () => this.notesAi.placement === 'bottom' ? Math.max(160, this.root.clientHeight * .7) : Math.max(240, this.root.clientWidth * .55), reset: 360, scale: () => -1,
      read: () => this.panelSize(), apply: value => this.applyPanelSize(value), commit: () => this.persist(), className: 'context-divider' });
    this.side.replaceChildren(this.contextDivider, this.context);
    this.body = el('div', { class: 'knowledge-body' }, this.panes, this.side);
    this.root.replaceChildren(el('header', { class: 'knowledge-topbar' }, el('div', { class: 'knowledge-topbar-title' }, iconButton('sidebar', 'Toggle file explorer', this.toggleSidebar), this.title),
      el('div', { class: 'knowledge-tools' }, iconButton('search', 'Command palette · Ctrl Shift P', () => this.palette()), iconButton('copy', 'Split right', () => this.split('horizontal')), iconButton('sliders', 'Split below', () => this.split('vertical')), iconButton('refresh', 'File history and undo', guard(() => this.showHistory())), button('Notes AI', () => this.setContext('ai')))), this.body);
    this.applyPlacement(); this.contextTabs = this.context.querySelector('.context-tabs');
    this.renderContext();
    document.addEventListener('selectionchange', () => { const selected = window.getSelection(); if (!selected || selected.isCollapsed) return; for (const doc of this.docs.values()) for (const view of doc.views) if (view.preview.contains(selected.anchorNode) && view.preview.contains(selected.focusNode)) { this.selection = selected.toString().slice(0, 6000); this.selectionResource = key(doc); this.activePane = this.layout.panes.find(pane => pane.tabs.some(tab => tab.id === view.tab.id))?.id || this.activePane; } });
  }
  panelSize() { const axis = this.notesAi.placement === 'bottom' ? 'height' : 'width'; return Math.round(this.context.getBoundingClientRect()[axis]) || this.aiSize || 360; }
  applyPanelSize(value) {
    this.aiSize = Math.round(value); this.notesAi.size = this.aiSize;
    const floating = this.notesAi.placement === 'floating', bottom = this.notesAi.placement === 'bottom';
    this.context.style.width = bottom ? '100%' : this.aiSize + 'px';
    this.context.style.height = bottom ? this.aiSize + 'px' : '';
    this.side.style.width = floating ? this.aiSize + 'px' : '';
    if (floating) this.side.style.height = Math.max(220, this.aiSize) + 'px';
    this.contextDivider.setAttribute('aria-valuenow', String(this.aiSize));
  }
  setPlacement(placement) {
    const next = normalizePlacement({ ...this.notesAi, placement });
    if (next.placement === this.notesAi.placement) return;
    this.notesAi = next; this.applyPlacement(); this.renderContext(); this.persist();
    if (this.placementSelect) this.placementSelect.value = placement;
  }
  applyPlacement() {
    const { el } = this, placement = this.notesAi.placement, floating = placement === 'floating';
    this.aiSize = this.notesAi.size || this.aiSize || panelSize('context');
    this.side.className = 'notes-side is-' + placement;
    this.body.classList.toggle('ai-bottom', placement === 'bottom');
    this.body.classList.toggle('ai-split', placement === 'split');
    this.contextDivider.hidden = placement === 'none' || floating;
    this.contextDivider.classList.toggle('floating-hidden', floating);
    if (floating) {
      if (this.side.parentElement !== document.body) document.body.append(this.side);
      this.side.style.position = 'fixed';
      this.side.style.left = clampNumber(this.notesAi.x ?? Math.max(16, innerWidth - (this.aiSize || 380) - 28), 8, Math.max(8, innerWidth - 260)) + 'px';
      this.side.style.top = clampNumber(this.notesAi.y ?? 88, 8, Math.max(8, innerHeight - 160)) + 'px';
      this.side.style.zIndex = '40'; this.side.style.width = (this.aiSize || 380) + 'px';
      this.context.style.width = (this.aiSize || 380) + 'px';
      this.context.style.height = Math.max(260, Math.min(680, innerHeight * .62)) + 'px';
      this.enableFloatingDrag();
    } else {
      this.side.style.position = ''; this.side.style.left = ''; this.side.style.top = ''; this.side.style.zIndex = ''; this.side.style.height = '';
      const target = this.body;
      if (placement === 'left') target.prepend(this.side);
      else target.append(this.side);
      this.applyPanelSize(this.aiSize);
    }
    if (this.applyPlacementDone) this.applyPlacementDone();
  }
  enableFloatingDrag() {
    if (!this.contextTabs || this.side.dataset.dragReady) return; this.side.dataset.dragReady = 'true';
    const start = event => {
      if (event.button !== 0 || this.notesAi.placement !== 'floating' || event.target.closest('button,select,input,a,textarea')) return;
      const rect = this.side.getBoundingClientRect(), offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top;
      const move = moveEvent => {
        const x = clampNumber(moveEvent.clientX - offsetX, 8, Math.max(8, innerWidth - 240)), y = clampNumber(moveEvent.clientY - offsetY, 8, Math.max(8, innerHeight - 80));
        this.side.style.left = x + 'px'; this.side.style.top = y + 'px'; this.notesAi.x = x; this.notesAi.y = y;
      };
      const done = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', done); removeEventListener('pointercancel', done); this.persist(); };
      addEventListener('pointermove', move); addEventListener('pointerup', done, { once: true }); addEventListener('pointercancel', done, { once: true });
    };
    this.contextTabs.addEventListener('pointerdown', start);
  }
  placementDialog() {
    const { el, button, guard } = this, options = [['right', 'Right sidebar', 'Beside your note, at the window edge.'], ['left', 'Left sidebar', 'Between the file explorer and your note.'], ['bottom', 'Bottom panel', 'Full-width panel below the editor.'], ['floating', 'Floating panel', 'Drag it anywhere; it stays above the editor.'], ['split', 'Split with editor', 'Shares the editor row equally with your note.']];
    const choices = options.map(([value, label, help]) => el('label', { class: 'placement-choice' }, el('input', { type: 'radio', name: 'ai-placement', value, checked: value === this.notesAi.placement }), el('span', {}, el('strong', {}, label), el('small', {}, help))));
    this.info('Notes AI placement', el('p', { class: 'help' }, 'Move the Notes AI panel without changing the active note, conversation or unsaved edits. Sizes and position are remembered. Narrow windows keep the panel usable.'),
      el('div', { class: 'placement-options' }, choices),
      el('div', { class: 'editor-actions' }, button('Apply placement', guard(() => { const value = choices.map(node => node.querySelector('input')).find(input => input.checked)?.value; this.closeInfo(); this.setPlacement(value); this.setContext('ai'); }), 'primary-button')));
  }
  renderFolders() {
    const { el } = this; this.workspaceSelect.replaceChildren(...this.workspaces.map(row => el('option', { value: row.id }, row.name)));
    if (!this.workspaces.length) this.workspaceSelect.append(el('option', { value: '' }, 'Attach a folder to begin'));
    this.workspaceSelect.value = this.layout.activeWorkspace || '';
  }
  async refreshWorkspaces() { this.workspaces = (await this.api('/workspaces')).workspaces; if (!this.workspaces.some(row => row.id === this.layout.activeWorkspace)) { this.layout.activeWorkspace = this.workspaces[0]?.id || null; this.expanded = new Set(this.layout.expandedFolders?.[this.layout.activeWorkspace] || ['']); this.activeFolder = ''; } this.renderFolders(); }
  async attachDialog(afterAttach) {
    const { el, button } = this;
    const status = el('p', { class: 'help attach-status', role: 'status' }, 'Choose a folder to authorize. Files stay in their original location.');
    const finish = async row => {
      this.closeInfo(); await this.refreshWorkspaces(); this.rememberFolders(); this.layout.activeWorkspace = row.id; this.expanded = new Set(['']); this.activeFolder = '';
      this.renderFolders(); await this.refreshTree(); this.persist(); this.onScopeChanged(row.id); if (typeof afterAttach === 'function') await afterAttach(row);
    };
    const attachPath = async path => {
      if (!path) return;
      status.classList.remove('message-error'); status.textContent = 'Authorizing folder…';
      try { const row = await this.api('/workspaces', { path, confirm: true, vault: true }); await finish(row); }
      catch (error) { status.textContent = error.message; status.classList.add('message-error'); }
    };
    const browse = button('Choose folder…', async () => {
      status.classList.remove('message-error'); status.textContent = 'Waiting for the folder picker…'; browse.disabled = true;
      try {
        const result = await this.api('/workspaces/browse', {}, 'POST');
        if (result.cancelled) { status.textContent = 'Folder selection cancelled. Nothing was attached.'; return; }
        status.textContent = 'Attaching ' + result.path; await attachPath(result.path);
      } catch (error) { status.textContent = error.message; status.classList.add('message-error'); }
      finally { browse.disabled = false; }
    }, 'primary-button');
    const manual = el('input', { placeholder: 'C:\\path\\to\\folder', 'aria-label': 'Local folder path' });
    this.info('Attach a local folder',
      el('p', { class: 'help' }, 'Grant this app access to an existing project or notes folder. Files stay in their original location. Only the chosen directory is authorized; symlinks and junctions are not followed. AI changes require review by default. Relevant excerpts may be sent to your selected model provider; avoid folders with secrets.'),
      status, browse,
      el('p', { class: 'help' }, 'The folder picker is your system’s file picker. Navigate into the folder you want and choose Open. You can also paste a deep path into its address bar.'),
      el('details', { class: 'attach-manual' }, el('summary', {}, 'Enter a path manually'), el('form', { onSubmit: event => { event.preventDefault(); attachPath(manual.value.trim()); } }, el('label', { class: 'field' }, 'Full local folder path', manual), el('button', { type: 'submit', class: 'secondary-button' }, 'Attach this path'))));
  }
  async workspaceSettings() {
    const row = this.workspaces.find(row => row.id === this.layout.activeWorkspace); if (!row) return this.attachDialog();
    const { el, button, guard } = this, name = el('input', { value: row.name, maxlength: 80 }), context = el('textarea', { maxlength: 10000, 'aria-label': 'Project context' }, row.context || ''), policy = el('select', { 'aria-label': 'AI change approvals' }, el('option', { value: 'always' }, 'Review every AI file change'), el('option', { value: 'automatic' }, 'Allow automatic AI changes (undoable)')); policy.value = row.approval;
    this.info('Workspace settings', el('p', { class: 'local-path' }, row.root), el('label', { class: 'field' }, 'Display name', name), el('label', { class: 'field' }, 'Persistent project context', context), el('label', { class: 'field' }, 'AI file-change policy', policy), el('p', { class: 'help' }, 'Automatic changes apply to this folder only. They remain version-checked, visible in tool activity and reversible from file history. Shell execution is unavailable in project-scoped chats.'),
      button('Save workspace settings', guard(async () => { if (policy.value === 'automatic' && row.approval !== 'automatic' && !confirm('Allow the AI to change and delete files in this folder without asking each time?')) return; await this.api('/workspaces/' + row.id, { name: name.value, context: context.value, approval: policy.value, confirm: true }, 'PATCH'); await this.refreshWorkspaces(); this.closeInfo(); }), 'primary-button'),
      !row.managed ? button('Detach folder', guard(async () => { if (!confirm('Detach this folder? Its files will not be deleted.')) return; await this.flushAll(); await this.api('/workspaces/' + row.id, undefined, 'DELETE'); await this.refreshWorkspaces(); this.closeInfo(); await this.refreshTree(); this.persist(); }), 'danger-button') : el('p', { class: 'help' }, 'This is your persistent app-managed notes library. Additional project folders remain optional.'));
  }
  async refreshTree() {
    if (!this.tree) return; const sequence = ++this.searchSequence, id = this.layout.activeWorkspace;
    if (!id) { this.tree.replaceChildren(this.el('div', { class: 'knowledge-empty' }, this.icon('folder'), this.el('h3', {}, 'Bring your own space.'), this.el('p', {}, 'Attach a notes folder or project. Ordinary files, fully local.'), this.button('Attach folder', () => this.attachDialog(), 'primary-button'))); return; }
    if (this.search.value.trim()) return this.runSearch();
    const folders = [...this.expanded].sort((a, b) => a.length - b.length), trees = new Map();
    for (const path of folders) try { trees.set(path, (await this.api('/resources/tree?' + new URLSearchParams({ workspaceId: id, path }))).files); } catch (error) { if (!path) { this.tree.replaceChildren(this.el('p', { class: 'message-error' }, error.message)); return; } this.expanded.delete(path); }
    if (sequence !== this.searchSequence) return; this.trees = trees; this.tree.replaceChildren();
    const render = (path, level) => { for (const row of trees.get(path) || []) { const item = this.treeItem(row, level); this.tree.append(item); if (row.directory && this.expanded.has(row.path)) render(row.path, level + 1); } };
    render('', 0); if (!this.tree.childElementCount) this.tree.append(this.el('p', { class: 'empty-history' }, 'Empty folder. Create your first note.'));
  }
  treeItem(row, level) {
    const { el, iconButton, guard } = this, folder = row.directory;
    const open = el('button', { class: 'tree-open', title: displayPath(row.path), onClick: guard(async () => { if (folder) { this.activeFolder = row.path; this.expanded.has(row.path) ? this.expanded.delete(row.path) : this.expanded.add(row.path); await this.refreshTree(); this.persist(); } else await this.open(row); }) }, folder ? this.icon(this.expanded.has(row.path) ? 'chevron' : 'folder') : this.icon('markdown'), el('span', {}, displayName(row.path)));
    const item = el('div', { class: 'tree-row depth-' + Math.min(12, level), role: 'treeitem', draggable: 'true', 'aria-expanded': folder ? String(this.expanded.has(row.path)) : null }, open, iconButton('more', 'File options: ' + displayName(row.path), () => this.fileMenu(row)));
    item.addEventListener('contextmenu', event => { event.preventDefault(); this.fileMenu(row); });
    item.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-basically-resource', JSON.stringify({ workspaceId: row.workspaceId, path: row.path })); event.dataTransfer.effectAllowed = 'move'; });
    if (folder) { item.addEventListener('dragover', event => { event.preventDefault(); item.classList.add('drop-target'); }); item.addEventListener('dragleave', () => item.classList.remove('drop-target')); item.addEventListener('drop', guard(async event => { item.classList.remove('drop-target'); await this.dropFile(event, row.path); })); }
    return item;
  }
  async dropFile(event, folder) { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer.files.length) return this.importDropped(event.dataTransfer); const data = event.dataTransfer.getData('application/x-basically-resource'); if (!data) return; const ref = JSON.parse(data), file = await this.snapshotInfo(ref); await this.review({ ...ref, action: 'move', revision: file.revision, destinationWorkspaceId: this.layout.activeWorkspace, destination: (folder ? folder + '/' : '') + filename(ref.path) }); }
  async snapshotInfo(ref) { try { return await this.api('/resources/file?' + new URLSearchParams(ref)); } catch (error) { if (error.message.includes('Text file not found')) return { revision: 'directory' }; throw error; } }
  async runSearch() {
    const sequence = ++this.searchSequence, query = this.search.value.trim(); if (!query) return this.refreshTree();
    const result = await this.api('/resources/search', { query, workspaceIds: this.workspaces.map(row => row.id), limit: 100 }); if (sequence !== this.searchSequence) return;
    this.tree.replaceChildren(this.el('p', { class: 'search-count', role: 'status' }, result.total + ' results' + (result.limited ? ' · bounded index; some contents omitted' : '')),
      ...result.results.map(row => this.el('button', { class: 'knowledge-result', onClick: this.guard(() => this.open(row)) }, this.el('strong', {}, this.highlight(displayPath(row.path), query)), this.el('small', {}, this.workspaces.find(workspace => workspace.id === row.workspaceId)?.name), this.el('span', {}, this.highlight(row.snippet, query)))));
    if (result.errors.length) this.tree.append(this.el('p', { class: 'message-error' }, result.errors.map(row => row.error).join('\n')));
  }
  async promptPath(title, initial, action) {
    const input = this.el('input', { value: initial || '', required: '', 'aria-label': title });
    this.info(title, this.el('form', { onSubmit: this.guard(async event => { event.preventDefault(); await action(input.value.trim()); }) }, this.el('label', { class: 'field' }, 'Relative path in the active folder', input), this.el('button', { type: 'submit', class: 'primary-button' }, 'Continue'))); input.focus(); input.select();
  }
  async newFile(initialContent) {
    if (!this.layout.activeWorkspace) return this.attachDialog(() => this.newFile(initialContent));
    return this.promptNoteTitle('New note', '', async path => {
      const ref = { workspaceId: this.layout.activeWorkspace, path }, view = path.slice(0, -3).split('/').pop();
      const existing = await this.api('/resources/file?' + new URLSearchParams(ref)).catch(() => null);
      if (existing) { this.closeInfo(); await this.open(ref); this.toast('That note already exists; opened it instead.'); return; }
      await this.api('/resources/save', { ...ref, revision: null, content: typeof initialContent === 'string' ? initialContent : '# ' + view + '\n\n' });
      this.closeInfo(); await this.open(ref); await this.refreshTree();
    });
  }
  promptNoteTitle(title, initial, action) {
    const input = this.el('input', { value: initial || '', required: '', maxlength: 200, placeholder: 'Note title', 'aria-label': 'Note title' }), preview = this.el('p', { class: 'help note-path-preview' }, '');
    const update = () => { const value = input.value.trim(); preview.textContent = value ? 'Saved as ' + (value.replace(/\.(md|markdown)$/i, '').replace(/[\/:*?"<>|]/g, '') || 'note') + '.md in ' + (this.workspaces.find(row => row.id === this.layout.activeWorkspace)?.name || 'this library') : 'Files are stored as Markdown; you never need to type the extension.'; };
    input.addEventListener('input', update); update();
    this.info(title, this.el('form', { onSubmit: this.guard(async event => { event.preventDefault(); if (!input.value.trim()) return; await action(this.resolveNotePath(input.value)); }) }, this.el('label', { class: 'field' }, 'Title', input), preview, this.el('button', { type: 'submit', class: 'primary-button' }, 'Continue')), this.el('p', { class: 'help' }, 'Nested folders use / between names. Entering .md is accepted but unnecessary. Ambiguous duplicate titles are opened, never silently overwritten.'));
    input.focus(); input.select();
  }
  resolveNotePath(value) {
    const folder = this.activeFolder ? this.activeFolder + '/' : '', clean = String(value || '').trim().replace(/\.(md|markdown)$/i, '');
    const joined = clean.includes('/') ? clean : folder + clean;
    return notePath(joined.replace(/\/{2,}/g, '/').replace(/^\/+/, ''));
  }
  importDialog() {
    const files = this.el('input', { type: 'file', accept: '.md,.markdown', multiple: '', hidden: true }), folder = this.el('input', { type: 'file', webkitdirectory: '', multiple: '', hidden: true });
    const status = this.el('p', { class: 'help', role: 'status' }, 'Import Markdown into My Notes. Folder structure and original UTF-8 content are preserved. Duplicate names get a numeric suffix; nothing is overwritten. Up to 200 files / 12 MB per batch.');
    for (const input of [files, folder]) input.addEventListener('change', this.guard(async () => { status.textContent = 'Importing…'; await this.importNotes([...input.files].filter(file => isNotePath(file.name)).map(file => ({ file, path: file.webkitRelativePath || file.name }))); }));
    this.info('Import Notes', status, this.button('Choose Markdown files', () => files.click()), this.button('Choose folder', () => folder.click()), files, folder);
  }
  async importNotes(rows) {
    if (!rows.length || rows.length > 200 || rows.reduce((sum, row) => sum + row.file.size, 0) > 12 * 1024 ** 2) throw new Error('Choose 1–200 Markdown files, up to 12 MB total.');
    if (rows.some(row => row.file.size > 2 * 1024 ** 2)) throw new Error('Each Markdown file must be 2 MB or smaller.');
    const files = await Promise.all(rows.map(async ({ file, path }) => { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return { path, data: btoa(binary) }; }));
    const result = await this.api('/notes/import', { files }); this.closeInfo(); await this.resourceEvent({ action: 'import', refs: result.imported }); if (result.imported[0]) await this.open(result.imported[0]);
    if (result.errors.length) this.info('Some notes could not be imported', ...result.errors.map(row => this.el('p', { class: 'help' }, row.path + ': ' + row.error)));
  }
  async importDropped(transfer) {
    let visited = 0; const rows = [], walk = async (entry, parent = '') => {
      if (++visited > 10000 || parent.split('/').length > 32) throw new Error('The dropped folder exceeds 10,000 entries or 32 levels. Choose a smaller subfolder.');
      if (rows.length > 200) throw new Error('Import at most 200 Markdown files.');
      if (entry.isFile) { const file = await new Promise((resolve, reject) => entry.file(resolve, reject)); if (isNotePath(file.name)) rows.push({ file, path: parent + file.name }); }
      else if (entry.isDirectory) { const reader = entry.createReader(); let batch; do { batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); for (const child of batch) await walk(child, parent + entry.name + '/'); } while (batch.length); }
    };
    const entries = [...transfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean); if (entries.length) for (const entry of entries) await walk(entry); else for (const file of transfer.files) if (isNotePath(file.name)) rows.push({ file, path: file.webkitRelativePath || file.name });
    await this.importNotes(rows);
  }
  async newFolder() { if (!this.layout.activeWorkspace) return this.attachDialog(); return this.promptPath('Create folder', (this.activeFolder ? this.activeFolder + '/' : '') + 'New folder', path => this.review({ workspaceId: this.layout.activeWorkspace, path, action: 'mkdir' })); }
  async fileMenu(ref) {
    const { button, guard, el } = this;
    this.info(displayName(ref.path), el('p', { class: 'local-path' }, displayPath(ref.path)), el('div', { class: 'menu-actions' },
      !ref.directory ? button('Open in editor', guard(async () => { this.closeInfo(); await this.open(ref); })) : null,
      button('Copy wiki reference', guard(async () => { await navigator.clipboard.writeText('[[' + key(ref) + ']]'); this.toast('Wiki reference copied.'); })),
      !ref.directory ? button('Send reference to main chat', () => { this.closeInfo(); this.sendToChat('Tell me about [[' + key(ref) + ']].'); }) : null,
      ...['move', 'duplicate'].map(action => button(action === 'move' ? 'Rename / move' : 'Duplicate', guard(async () => { await this.flushAll(); const file = await this.snapshotInfo(ref); const target = path => this.review({ ...ref, action, revision: file.revision, destination: path, destinationWorkspaceId: ref.workspaceId });
          if (action === 'move' && isNotePath(ref.path)) this.promptNoteTitle('Rename note', noteTitle(ref.path), path => target(path));
          else this.promptPath(action === 'move' ? 'Rename / move' : 'Duplicate file or folder', action === 'move' ? displayPath(ref.path) : ref.path.replace(/(\.[^/.]+)?$/, ' copy$1'), path => target(isNotePath(path) && !isNotePath(ref.path) ? path : isNotePath(ref.path) ? notePath(path) : path)); }))),
      button('Delete', guard(async () => { await this.flushAll(); const file = await this.snapshotInfo(ref); await this.review({ ...ref, action: 'delete', revision: file.revision }); }), 'danger-button')));
  }
  diffView(preview) { return this.el('div', { class: 'diff-review' }, (preview.warnings || []).map(text => this.el('p', { class: 'help' }, text)), preview.changes.map(change => this.el('section', {}, this.el('h4', {}, (change.workspaceName ? change.workspaceName + ' / ' : '') + change.path), this.el('pre', { class: 'file-diff' }, change.diff.split('\n').map(line => this.el('span', { class: line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : '' }, line + '\n')))))); }
  async review(body) {
    const preview = await this.api('/resources/plan', body);
    this.info('Review ' + body.action, this.el('p', { class: 'help' }, 'All changes below are revision-checked and reversible from file history. Renames update uniquely resolved wiki links in the bounded text index. Missing/ambiguous links, non-wiki Markdown links and unindexed contents are not rewritten.'), this.diffView(preview),
      this.button('Apply changes', this.guard(async event => { const applyButton = event.currentTarget; applyButton.disabled = true; try { const result = await this.api('/resources/apply', { id: preview.id }); await this.resourceEvent({ action: 'mutation', moves: body.action === 'move' ? [{ before: { workspaceId: body.workspaceId, path: body.path }, after: { workspaceId: body.destinationWorkspaceId || body.workspaceId, path: body.destination } }] : [], refs: result.changes }); this.closeInfo(); this.toast('Changes applied. Undo is available in file history.'); } finally { applyButton.disabled = false; } }), 'primary-button'));
  }
  async showHistory() {
    const result = await this.api('/resources/history'); this.info('File history & undo', this.el('p', { class: 'help' }, 'Undo checks current file versions and refuses intervening external edits. Editor autosaves and AI changes share the most recent 100 operations, within 64 MB. Multi-file operations use recovery journals, not a single filesystem transaction.'),
      ...result.history.map(row => this.el('div', { class: 'history-operation' }, this.el('div', {}, this.el('strong', {}, row.action + ' · ' + row.refs[0]?.path), this.el('small', {}, new Date(row.createdAt).toLocaleString() + ' · ' + row.source + ' · ' + row.status)), this.button('Undo', this.guard(async () => { if (!confirm('Undo this file operation?')) return; await this.api('/resources/undo', { id: row.id }); await this.resourceEvent({ action: 'undo' }); this.closeInfo(); this.toast('Operation undone.'); })))), !result.history.length ? this.el('p', { class: 'help' }, 'No file changes yet.') : null);
  }
  async load(ref) {
    const id = key(ref); if (this.docs.has(id)) { const doc = this.docs.get(id); if (doc.stale && !doc.dirty && !doc.saving) { try { const file = await this.api('/resources/file?' + new URLSearchParams({ workspaceId: ref.workspaceId, path: ref.path })); if (file.revision !== doc.revision) { doc.content = doc.saved = file.content; doc.revision = file.revision; doc.generatedMath = file.generatedMath || []; doc.undo = []; doc.redo = []; } doc.conflict = null; doc.status = 'Saved'; doc.stale = false; } catch (error) { doc.conflict = { missing: true }; doc.status = error.message; } } return doc; }
    const file = await this.api('/resources/file?' + new URLSearchParams({ workspaceId: ref.workspaceId, path: ref.path }));
    const doc = { ...file, saved: file.content, dirty: false, undo: [], redo: [], status: 'Saved', views: new Set() };
    try { const draft = JSON.parse(localStorage.getItem('basically:file-draft:' + id) || 'null'); if (draft && draft.content !== file.content) { doc.content = draft.content; doc.dirty = true; if (draft.revision !== file.revision) { doc.conflict = file; doc.status = 'Conflict · draft kept'; } else doc.status = 'Recovered draft'; } } catch {}
    this.docs.set(id, doc); return doc;
  }
  async open(ref, paneId = this.activePane, { forceNew = false, heading = '' } = {}) {
    let doc; try { doc = await this.load(ref); } catch (error) { this.info('Unable to edit this file', this.el('p', { class: 'help' }, error.message), this.el('a', { class: 'secondary-button', href: '/api/resources/asset?' + new URLSearchParams({ workspaceId: ref.workspaceId, path: ref.path }), download: filename(ref.path) }, 'Download original file')); return; }
    const pane = this.layout.panes.find(pane => pane.id === paneId) || this.layout.panes[0]; let tab = !forceNew && pane.tabs.find(tab => key(tab) === key(ref));
    if (!tab) { tab = { id: crypto.randomUUID(), workspaceId: ref.workspaceId, path: ref.path, mode: isNotePath(ref.path) ? 'rich' : 'source' }; pane.tabs.push(tab); }
    pane.active = tab.id; this.activePane = pane.id; const workspaceChanged = this.layout.activeWorkspace !== ref.workspaceId; if (workspaceChanged) { this.rememberFolders(); this.layout.activeWorkspace = ref.workspaceId; this.expanded = new Set(this.layout.expandedFolders?.[ref.workspaceId] || ['']); this.activeFolder = ''; } this.renderFolders(); if (workspaceChanged) await this.refreshTree(); this.renderPanes(); this.persist(); this.refreshConnections(); this.onScopeChanged(ref.workspaceId);
    if (doc.dirty && !doc.conflict) this.scheduleSave(doc);
    if (heading) requestAnimationFrame(() => { const view = this.panes.querySelector('[data-tab-id="' + tab.id + '"]'); const target = [...(view?.querySelectorAll(heading.startsWith('^') ? 'p,li,blockquote' : 'h1,h2,h3,h4,h5,h6') || [])].find(node => heading.startsWith('^') ? node.textContent.trim().endsWith(heading) : node.textContent.toLowerCase() === heading.toLowerCase()); target?.scrollIntoView({ block: 'center' }); });
  }
  current() { const pane = this.layout.panes.find(pane => pane.id === this.activePane) || this.layout.panes[0]; const tab = pane?.tabs.find(tab => tab.id === pane.active); return tab ? this.docs.get(key(tab)) : null; }
  activeContext() { const doc = this.current(); return doc ? { activeResource: { workspaceId: doc.workspaceId, path: doc.path }, selectedText: this.selectionResource === key(doc) ? this.selection.slice(0, 6000) : '' } : {}; }
  edit(doc, content, origin, history = true) {
    if (origin) content = preserveLineEndings(doc.content, content);
    if (content === doc.content) return;
    if (history) { if (Date.now() - (doc.lastUndo || 0) > 400 || !doc.undo.length) { doc.undo.push(doc.content); if (doc.undo.length > 100) doc.undo.shift(); } doc.lastUndo = Date.now(); doc.redo = []; } doc.content = content; doc.dirty = content !== doc.saved; doc.status = doc.conflict ? 'Conflict · draft kept' : 'Unsaved'; this.selection = '';
    try { localStorage.setItem('basically:file-draft:' + key(doc), JSON.stringify({ revision: doc.revision, content })); } catch { this.toast('Browser draft storage is full. Save before closing.'); }
    for (const view of doc.views) { if (view.rich && origin !== view.rich) view.rich.setContent(content); if (view.textarea !== origin) { const start = view.textarea.selectionStart, end = view.textarea.selectionEnd; view.textarea.value = content; view.textarea.setSelectionRange(start, end); } clearTimeout(view.previewTimer); view.previewTimer = setTimeout(() => this.previewView(view, doc), 100); view.status.textContent = doc.status; view.count.textContent = doc.content.length.toLocaleString() + ' characters'; }
    this.scheduleSave(doc);
  }
  scheduleSave(doc) { clearTimeout(doc.timer); if (doc.conflict) return; doc.timer = setTimeout(this.guard(() => this.save(doc)), 700); }
  captureEditor(doc) { for (const view of doc.views) if (view.rich) { const content = view.rich.getMarkdown(); if (content !== doc.content) this.edit(doc, content, view.rich); } }
  async save(doc) {
    this.captureEditor(doc);
    if (doc.saving) { await doc.saving; if (doc.dirty && !doc.conflict) return this.save(doc); return; }
    if (!doc.dirty || doc.conflict) return;
    const content = doc.content, revision = doc.revision; doc.status = 'Saving…'; this.updateStatus(doc);
    doc.saving = (async () => {
      try { const result = await this.api('/resources/save', { workspaceId: doc.workspaceId, path: doc.path, content, revision }); doc.revision = result.file.revision; doc.saved = content; doc.dirty = doc.content !== content; doc.status = doc.dirty ? 'Unsaved' : 'Saved'; if (!doc.dirty) localStorage.removeItem('basically:file-draft:' + key(doc)); }
      catch (error) { doc.status = error.message; doc.conflict = await this.api('/resources/file?' + new URLSearchParams({ workspaceId: doc.workspaceId, path: doc.path })).catch(() => ({ missing: true, content: '', revision: null })); this.toast('Save stopped: the file changed or is unavailable. Your draft is kept.'); }
      finally { this.updateStatus(doc); }
    })();
    try { await doc.saving; } finally { doc.saving = null; this.pruneDocuments(); }
    if (doc.dirty && !doc.conflict) this.scheduleSave(doc);
  }
  updateStatus(doc) { for (const view of doc.views) { view.status.textContent = doc.status; view.count.textContent = doc.content.length.toLocaleString() + ' characters'; view.conflict.hidden = !doc.conflict; } }
  async flushAll() { await Promise.all([...this.docs.values()].map(doc => this.save(doc))); }
  undo(doc, redo = false) { const from = redo ? doc.redo : doc.undo, to = redo ? doc.undo : doc.redo; if (!from.length) return; const content = from.pop(); to.push(doc.content); this.edit(doc, content, null, false); }
  pruneDocuments() { const referenced = new Set(this.layout.panes.flatMap(pane => pane.tabs.map(key))); for (const [id, doc] of this.docs) if (!referenced.has(id) && !doc.dirty && !doc.saving) { clearTimeout(doc.timer); this.docs.delete(id); } }
  renderPanes() {
    this.pruneDocuments(); if (!this.panes) return; for (const doc of this.docs.values()) { for (const view of doc.views) { clearTimeout(view.previewTimer); view.rich?.destroy(); } doc.views.clear(); }
    this.panes.className = 'editor-panes ' + this.layout.orientation; this.panes.replaceChildren();
    for (const [paneIndex, pane] of this.layout.panes.entries()) {
      const tabs = this.el('div', { class: 'document-tabs', role: 'tablist' });
      for (const tab of pane.tabs) {
        const tabNode = this.el('div', { class: 'document-tab' + (tab.id === pane.active ? ' active' : ''), draggable: 'true' }, this.el('button', { role: 'tab', 'aria-selected': String(tab.id === pane.active), title: displayPath(tab.path), onClick: this.guard(async () => { await this.load(tab); pane.active = tab.id; this.activePane = pane.id; this.renderPanes(); this.persist(); this.refreshConnections(); }) }, displayName(tab.path)), this.iconButton('close', 'Close ' + displayName(tab.path), this.guard(async () => { const doc = this.docs.get(key(tab)); if (doc) await this.save(doc); if (doc?.dirty && !confirm('Keep this unsaved draft locally and close the tab?')) return; pane.tabs = pane.tabs.filter(row => row.id !== tab.id); if (pane.active === tab.id) pane.active = pane.tabs.at(-1)?.id || null; this.renderPanes(); this.persist(); })));
        tabNode.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-basically-tab', JSON.stringify({ pane: pane.id, tab: tab.id })); });
        tabNode.addEventListener('dragover', event => event.preventDefault()); tabNode.addEventListener('drop', event => this.dropTab(event, pane, tab.id)); tabs.append(tabNode);
      }
      const group = this.el('section', { class: 'editor-group', 'aria-label': 'Editor pane', onFocusin: () => { if (this.activePane !== pane.id) { this.activePane = pane.id; this.title.textContent = this.current() ? displayPath(this.current().path) : 'Your knowledge, connected.'; this.refreshConnections(); this.persist(); } } }, tabs);
      tabs.addEventListener('dragover', event => event.preventDefault()); tabs.addEventListener('drop', event => { if (event.target === tabs) this.dropTab(event, pane); });
      const active = pane.tabs.find(tab => tab.id === pane.active), doc = active && this.docs.get(key(active));
      if (doc) group.append(this.editorView(doc, active, pane));
      else group.append(this.el('div', { class: 'editor-empty' }, this.icon('markdown'), this.el('h2', {}, 'Make room for what you know.'), this.el('p', {}, 'Open a file, follow a connection, or create a note.'), this.button(this.workspaces.length ? 'New note' : 'Attach a folder', this.guard(() => this.workspaces.length ? this.newFile() : this.attachDialog()), 'primary-button')));
      if (this.layout.panes.length > 1) group.append(this.el('button', { class: 'close-pane text-button', onClick: () => { if (pane.tabs.length && !confirm('Close this pane? Saved files remain on disk.')) return; this.layout.panes = this.layout.panes.filter(row => row.id !== pane.id); this.activePane = this.layout.panes[0].id; this.renderPanes(); this.persist(); } }, 'Close pane'));
      group.style.flex = (pane.weight || 1) + ' 1 0%'; this.panes.append(group);
      if (paneIndex < this.layout.panes.length - 1) this.panes.append(this.paneResizer(pane, this.layout.panes[paneIndex + 1], group));
    }
    this.title.textContent = this.current() ? displayPath(this.current().path) : 'Your knowledge, connected.';
  }
  paneResizer(left, right, group) {
    const vertical = this.layout.orientation === 'vertical'; let handle;
    const size = () => Math.max(1, vertical ? group.offsetHeight + (handle.nextElementSibling?.offsetHeight || 0) : group.offsetWidth + (handle.nextElementSibling?.offsetWidth || 0));
    handle = divider({ axis: vertical ? 'y' : 'x', label: 'Resize editor panes', min: 15, max: 85, step: 5, reset: 50,
      read: () => 100 * (left.weight || 1) / ((left.weight || 1) + (right.weight || 1)), scale: () => 100 / size(),
      apply: fraction => { const total = (left.weight || 1) + (right.weight || 1); left.weight = total * fraction / 100; right.weight = total - left.weight; group.style.flexGrow = String(left.weight); if (handle.nextElementSibling) handle.nextElementSibling.style.flexGrow = String(right.weight); }, commit: () => this.persist(), className: 'pane-resizer' }); return handle;
  }
  editorView(doc, tab, pane) {
    const { el, button, iconButton, guard } = this;
    const textarea = el('textarea', { class: 'file-source' + (/\.(md|markdown|txt)$/i.test(doc.path) ? ' markdown-source' : ''), spellcheck: /\.(md|txt|markdown)$/i.test(doc.path) ? 'true' : 'false', 'aria-label': (tab.mode === 'rich' ? 'Markdown source for ' : 'Edit ') + displayName(doc.path) }); textarea.value = doc.content;
    const preview = el('div', { class: 'file-preview' }), status = el('span', { class: 'file-save-status', role: 'status' }, doc.status), count = el('span', {}, doc.content.length.toLocaleString() + ' characters'), mode = el('select', { 'aria-label': 'Document view', onChange: event => { tab.mode = event.target.value; this.renderPanes(); this.persist(); } }, ...(isNotePath(doc.path) ? [['rich', 'Document'], ['source', 'Markdown source'], ['code', 'Read-only code']] : [['source', 'Source'], ['code', 'Read-only code']]).map(([id, text]) => el('option', { value: id }, text))); mode.value = tab.mode;
    const conflict = el('div', { class: 'file-conflict', hidden: !doc.conflict }, el('span', {}, 'External changes detected. Your draft is safe.'), button('Review conflict', () => this.resolveConflict(doc)));
    const view = { textarea, preview, status, count, conflict, tab }; doc.views.add(view);
    textarea.addEventListener('input', () => this.edit(doc, textarea.value, textarea));
    textarea.addEventListener('select', () => { this.activePane = pane.id; this.selection = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd); this.selectionResource = key(doc); });
    textarea.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && /\.(md|markdown|txt)$/i.test(doc.path) && ['b', 'i', 'k'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); const marker = event.key.toLowerCase() === 'b' ? '**' : event.key.toLowerCase() === 'i' ? '*' : '[[', endMarker = marker === '[[' ? ']]' : marker, start = textarea.selectionStart, end = textarea.selectionEnd; textarea.setRangeText(marker + textarea.value.slice(start, end) + endMarker, start, end, 'select'); textarea.setSelectionRange(start + marker.length, end + marker.length); this.edit(doc, textarea.value, textarea); return; }
      if ((event.ctrlKey || event.metaKey) && ['z', 'y', 's'].includes(event.key.toLowerCase())) { event.preventDefault(); if (event.key.toLowerCase() === 's') this.guard(() => this.save(doc))(); else this.undo(doc, event.key.toLowerCase() === 'y' || event.shiftKey); }
      if (event.key === 'Tab') { event.preventDefault(); textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end'); this.edit(doc, textarea.value, textarea); }
    });
    this.previewView(view, doc);
    const richHost = el('div', { class: 'file-rich-editor', hidden: tab.mode !== 'rich' });
    if (tab.mode === 'rich') view.rich = createRichEditor({ element: richHost, content: doc.content, label: 'Edit ' + displayName(doc.path), context: { workspaceId: doc.workspaceId, path: doc.path }, onWikiNavigate: target => this.guard(() => this.navigate(target, doc))(), math: doc.generatedMath || [], onChange: content => this.edit(doc, content, view.rich), onSave: () => this.guard(() => this.save(doc))(), onSelection: text => { this.selection = text; this.selectionResource = key(doc); this.activePane = pane.id; } });
    const body = el('div', { class: 'file-editor-body mode-' + tab.mode }, richHost, textarea, preview);
    if (tab.mode === 'split') {
      let ratio = panelSize('source'); const axis = () => getComputedStyle(body).flexDirection === 'column' ? 'y' : 'x';
      const apply = value => { ratio = value; textarea.style.flex = value + ' 1 0%'; preview.style.flex = (100 - value) + ' 1 0%'; }; apply(ratio);
      textarea.after(divider({ axis, label: 'Resize source and preview', min: 20, max: 80, step: 5, reset: 50, read: () => ratio, scale: () => 100 / Math.max(1, axis() === 'x' ? body.clientWidth : body.clientHeight), apply, commit: () => savePanelSize('source', ratio), className: 'source-divider' }));
    }
    textarea.hidden = ['rich', 'rendered', 'code'].includes(tab.mode); preview.hidden = ['source', 'rich'].includes(tab.mode);
    return el('div', { class: 'file-editor', 'data-tab-id': tab.id }, el('div', { class: 'file-toolbar' }, el('span', { class: 'file-breadcrumb', title: displayPath(doc.path) }, displayPath(doc.path)), mode, iconButton('refresh', 'Undo edit', () => view.rich ? view.rich.undo() : this.undo(doc)), iconButton('arrow', 'Redo edit', () => view.rich ? view.rich.redo() : this.undo(doc, true)), iconButton('more', 'Document options', () => this.fileMenu(doc))), conflict, body,
      el('footer', { class: 'file-statusbar' }, status, count, button('Ask AI about this file', () => { this.activePane = pane.id; this.setContext('ai'); this.askAboutCurrent('[[' + key(doc) + ']]'); }, 'text-button')));
  }
  previewView(view, doc) {
    if (view.rich) { view.rich.setMath(doc.generatedMath); view.rich.setContent(doc.content); return; }
    if (!view.preview.isConnected && !doc.views.has(view)) return;
    if (view.tab.mode === 'code') view.preview.replaceChildren(codePreview(doc.content, doc.path));
    else view.preview.replaceChildren(markdown(doc.content, { workspaceId: doc.workspaceId, path: doc.path, onTaskToggle: (index, checked, count) => { const content = toggleTaskText(doc.content, index, checked, count); if (content === null) { this.toast('Use source mode to edit tasks with complex list indentation.'); this.previewView(view, doc); return; } this.edit(doc, content); } }, { math: new Set(doc.generatedMath || []) }));
  }
  async resolveConflict(doc) {
    const disk = await this.api('/resources/file?' + new URLSearchParams({ workspaceId: doc.workspaceId, path: doc.path })).catch(() => ({ missing: true, content: '', revision: null }));
    this.info('Resolve file conflict', this.el('p', { class: 'help' }, 'The file on disk changed. Your draft was not written over it. Compare both versions, then choose explicitly.'), this.el('h4', {}, 'Current disk version'), codePreview(disk.content, doc.path), this.el('h4', {}, 'Your unsaved draft'), codePreview(doc.content, doc.path),
      this.button('Reload disk version', () => { if (!confirm('Discard this draft and load the disk version?')) return; doc.content = disk.content; doc.saved = disk.content; doc.revision = disk.revision; doc.conflict = null; doc.dirty = false; doc.status = disk.missing ? 'File removed' : 'Saved'; localStorage.removeItem('basically:file-draft:' + key(doc)); this.closeInfo(); this.renderPanes(); }),
      this.button(disk.missing ? 'Recreate from draft' : 'Save my draft over this version', this.guard(async () => { doc.revision = disk.revision; doc.saved = disk.content; doc.conflict = null; doc.dirty = true; await this.save(doc); this.closeInfo(); this.renderPanes(); }), 'danger-button'));
  }
  split(orientation) { if (this.layout.panes.length >= 4) return this.toast('Up to four editor panes are supported.'); this.layout.orientation = orientation; const doc = this.current(), pane = { id: crypto.randomUUID(), tabs: [], active: null }; this.layout.panes.push(pane); this.activePane = pane.id; if (doc) this.open(doc, pane.id, { forceNew: true }); else { this.renderPanes(); this.persist(); } }
  dropTab(event, destination, before) { event.preventDefault(); event.stopPropagation(); const value = event.dataTransfer.getData('application/x-basically-tab'); if (!value) return; const data = JSON.parse(value), source = this.layout.panes.find(pane => pane.id === data.pane), tab = source?.tabs.find(tab => tab.id === data.tab); if (!tab) return; source.tabs = source.tabs.filter(item => item.id !== tab.id); const index = destination.tabs.findIndex(item => item.id === before); destination.tabs.splice(index < 0 ? destination.tabs.length : index, 0, tab); destination.active = tab.id; if (source.active === tab.id && source !== destination) source.active = source.tabs[0]?.id || null; this.activePane = destination.id; this.renderPanes(); this.persist(); }
  setContext(context) { this.layout.context = context; this.renderContext(); this.persist(); if (context === 'links') this.refreshConnections(); }
  renderContext() { if (!this.context) return; const hidden = this.layout.context === 'none' || !this.visible;
    this.side.hidden = hidden; this.context.hidden = hidden;
    this.contextDivider.hidden = hidden || this.notesAi.placement === 'floating';
    this.linksPanel.hidden = this.layout.context !== 'links' || hidden; this.aiHost.hidden = this.layout.context !== 'ai' || hidden;
    this.context.classList.toggle('is-ai', this.layout.context === 'ai');
    if (this.placementSelect) this.placementSelect.value = this.notesAi.placement; this.context.querySelector('.context-tabs').children[0].classList.toggle('active', this.layout.context === 'links'); this.context.querySelector('.context-tabs').children[1].classList.toggle('active', this.layout.context === 'ai'); }
  async refreshConnections() {
    const sequence = this.connectionSequence = (this.connectionSequence || 0) + 1, doc = this.current();
    if (!this.linksPanel || this.layout.context !== 'links') return;
    if (!doc) { this.linksPanel.replaceChildren(this.el('div', { class: 'connections-empty' }, this.icon('markdown'), this.el('h3', {}, 'Connected knowledge'), this.el('p', { class: 'help' }, 'Open a note to see its headings, outgoing links and backlinks. Use [[wiki links]] to connect ideas across your notes and projects.'))); return; }
    const id = key(doc);
    const result = await this.api('/resources/links', { ref: { workspaceId: doc.workspaceId, path: doc.path } }).catch(error => ({ error: error.message })); if (key(this.current() || {}) !== id || sequence !== this.connectionSequence) return;
    const { el, button, guard } = this;
    if (result.error) { this.linksPanel.replaceChildren(el('p', { class: 'message-error' }, result.error)); return; }
    this.linksPanel.replaceChildren(...[el('h3', {}, 'On this page'), ...result.headings.map(heading => button(heading, () => this.open(doc, this.activePane, { heading }), 'connection-heading')), el('h3', {}, 'Outgoing links'),
      ...result.outgoing.map(row => el('button', { class: 'connection-card ' + row.status, onClick: guard(() => this.navigate(row.target, doc)) }, el('strong', {}, displayPath(row.target)), el('small', {}, row.status))), !result.outgoing.length ? el('p', { class: 'help' }, 'No outgoing wiki links.') : null,
      el('h3', {}, 'Backlinks · ' + result.incoming.length), ...result.incoming.map(row => el('button', { class: 'connection-card', onClick: guard(() => this.open(row)) }, el('strong', {}, displayPath(row.path)), el('span', {}, row.context))), !result.incoming.length ? el('p', { class: 'help' }, 'No linked mentions yet.') : null].filter(Boolean));
  }
  async navigate(target, base = this.current(), options = {}) {
    const scope = this.workspaces.map(row => row.id), result = (await this.api('/resources/resolve', { targets: [target], base: base && { workspaceId: base.workspaceId, path: base.path }, workspaceIds: scope })).links[0];
    const open = async ref => { this.closeInfo(); await this.activateNotes(); await this.open(ref, this.activePane, { forceNew: options.newTab, heading: ref.heading }); };
    if (result.status === 'resolved') return open(result.matches[0]);
    if (result.status === 'ambiguous') { this.info('Choose the referenced file', this.el('p', { class: 'help' }, '[[' + target + ']] matches more than one authorized resource.'), ...result.matches.map(ref => this.button(ref.name, this.guard(() => open(ref))))); return; }
    const path = target.split('#')[0].split('|')[0], qualified = path.includes('::') ? path.split('::') : null;
    const workspaceId = qualified ? this.workspaces.find(row => row.id === qualified[0] || row.name === qualified[0])?.id : base?.workspaceId || this.layout.activeWorkspace;
    this.info('Broken link', this.el('p', { class: 'help' }, 'No authorized file resolves [[' + target + ']]. Attach the correct folder, or create a note. No filesystem path is inferred from an absolute path.'), this.button('Create linked note', this.guard(async () => { if (!workspaceId) return this.attachDialog(); let notePath = qualified ? qualified[1] : path; if (!/\.[^/]+$/.test(notePath)) notePath += '.md'; const ref = { workspaceId, path: notePath }; await this.api('/resources/save', { ...ref, content: '# ' + filename(notePath).replace(/\.md$/i, '') + '\n\n', revision: null }); await open(ref); await this.refreshTree(); }), 'primary-button'));
  }
  async resolveForMessage(text, scope, base) {
    const targets = [...new Set(wikiLinks(text).map(link => link.target))]; if (!targets.length || !scope.length) return {};
    const result = await this.api('/resources/resolve', { targets, workspaceIds: scope, base }), ambiguous = result.links.filter(link => link.status === 'ambiguous'); if (!ambiguous.length) return {};
    return new Promise(resolve => {
      const choices = {}, rows = ambiguous.map(link => { const select = this.el('select', { required: '', 'aria-label': link.target }, this.el('option', { value: '' }, 'Choose a file…'), ...link.matches.map((ref, index) => this.el('option', { value: String(index) }, (this.workspaces.find(workspace => workspace.id === ref.workspaceId)?.name || 'Library') + ' / ' + displayPath(ref.path)))); select.addEventListener('change', () => { choices[link.target] = link.matches[Number(select.value)]; }); return this.el('label', { class: 'field' }, '[[' + link.target + ']]', select); });
      const dialog = document.querySelector('#info-dialog'), cancel = () => { dialog.removeEventListener('close', cancel); resolve(null); };
      this.info('Resolve ambiguous references', this.el('form', { onSubmit: event => { event.preventDefault(); dialog.removeEventListener('close', cancel); this.closeInfo(); resolve(choices); } }, rows, this.el('button', { type: 'submit', class: 'primary-button' }, 'Use these files'))); dialog.addEventListener('close', cancel);
    });
  }
  resourceEvent(data = {}) { const task = (this.eventQueue || Promise.resolve()).then(() => this.handleResourceEvent(data)); this.eventQueue = task.catch(() => {}); return task; }
  async handleResourceEvent(data) {
    await this.refreshWorkspaces();
    let detachedTabs = false;
    for (const pane of this.layout.panes) { const kept = pane.tabs.filter(tab => this.workspaces.some(row => row.id === tab.workspaceId)); detachedTabs ||= kept.length !== pane.tabs.length; pane.tabs = kept; if (!kept.some(tab => tab.id === pane.active)) pane.active = kept[0]?.id || null; }
    const moved = (data.moves || []).filter((move, index, all) => !all.some((parent, i) => i !== index && parent.before.workspaceId === move.before.workspaceId && move.before.path.startsWith(parent.before.path + '/')));
    for (const move of moved) {
      for (const doc of [...this.docs.values()]) if (doc.workspaceId === move.before.workspaceId && (doc.path === move.before.path || doc.path.startsWith(move.before.path + '/'))) { const oldKey = key(doc), newPath = move.after.path + doc.path.slice(move.before.path.length); this.docs.delete(oldKey); doc.path = newPath; doc.workspaceId = move.after.workspaceId; this.docs.set(key(doc), doc); try { if (doc.dirty) localStorage.setItem('basically:file-draft:' + key(doc), JSON.stringify({ revision: doc.revision, content: doc.content })); localStorage.removeItem('basically:file-draft:' + oldKey); } catch { this.toast('Unable to migrate the browser draft after a move. Save or copy your draft before closing.'); } }
      for (const pane of this.layout.panes) for (const tab of pane.tabs) if (tab.workspaceId === move.before.workspaceId && (tab.path === move.before.path || tab.path.startsWith(move.before.path + '/'))) { tab.path = move.after.path + tab.path.slice(move.before.path.length); tab.workspaceId = move.after.workspaceId; }
    }
    let rerender = !!data.moves?.length || detachedTabs;
    for (const doc of this.docs.values()) {
      this.captureEditor(doc);
      if (doc.saving) continue;
      if (!doc.views.size && !doc.dirty) { doc.stale = true; continue; }
      if (!this.workspaces.some(row => row.id === doc.workspaceId)) { doc.status = 'Folder detached · draft kept'; doc.conflict = { missing: true }; this.updateStatus(doc); continue; }
      try { const disk = await this.api('/resources/file?' + new URLSearchParams({ workspaceId: doc.workspaceId, path: doc.path })); if (disk.revision === doc.revision) { doc.generatedMath = disk.generatedMath || []; if (!doc.dirty && doc.conflict?.missing) { doc.conflict = null; doc.status = 'Saved'; this.updateStatus(doc); } continue; } if (doc.dirty) { doc.conflict = disk; doc.status = 'Conflict · draft kept'; this.updateStatus(doc); } else { doc.content = disk.content; doc.saved = disk.content; doc.revision = disk.revision; doc.generatedMath = disk.generatedMath || []; doc.conflict = null; doc.undo = []; doc.redo = []; doc.status = 'Updated from disk'; for (const view of doc.views) { const start = view.textarea.selectionStart; view.textarea.value = doc.content; view.textarea.setSelectionRange(start, start); this.previewView(view, doc); } this.updateStatus(doc); } }
      catch (error) { doc.status = error.message; doc.conflict = { missing: true }; this.updateStatus(doc); }
    }
    if (rerender) { this.renderPanes(); this.persist(); } if (this.visible) { await this.refreshTree(); await this.refreshConnections(); }
  }
  rememberFolders() { this.layout.expandedFolders ||= {}; if (this.layout.activeWorkspace) this.layout.expandedFolders[this.layout.activeWorkspace] = [...this.expanded]; }
  persist() { this.layout.notesAi = this.notesAi; this.layout.activePane = this.activePane; this.rememberFolders(); clearTimeout(this.layoutTimer); this.layoutTimer = setTimeout(this.guard(() => this.api('/knowledge/layout', this.layout, 'PUT')), 300); }
  palette() {
    const commands = [['New note', () => this.newFile()], ['Attach folder / vault', () => this.attachDialog()], ['Save all files', () => this.flushAll()], ['Split right', () => this.split('horizontal')], ['Split below', () => this.split('vertical')], ['Show backlinks', () => this.setContext('links')], ['Show Notes AI', () => this.setContext('ai')], ['File history / undo', () => this.showHistory()], ['Workspace settings', () => this.workspaceSettings()], ['Search workspace', () => this.search.focus()], ['Toggle explorer', () => this.toggleSidebar()]];
    const query = this.el('input', { type: 'search', placeholder: 'Search commands or files…', 'aria-label': 'Command palette search' }), list = this.el('div', { class: 'command-results' }); let sequence = 0;
    const render = this.guard(async () => { const request = ++sequence, q = query.value.toLowerCase(), rows = commands.filter(([label]) => [...q].reduce((at, char) => at < 0 ? -1 : label.toLowerCase().indexOf(char, at) + 1 || -1, 0) >= 0).map(([label, action]) => this.button(label, this.guard(async () => { this.closeInfo(); await action(); }), 'command-item'));
      if (q && this.workspaces.length) { const files = await this.api('/resources/search', { query: q, limit: 12 }); if (request !== sequence) return; rows.push(...files.results.map(ref => this.button(displayPath(ref.path), this.guard(async () => { this.closeInfo(); await this.open(ref); }), 'command-item'))); }
      list.replaceChildren(...rows); });
    query.addEventListener('input', render); query.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('button')?.focus(); } if (event.key === 'Enter') { event.preventDefault(); list.querySelector('button')?.click(); } });
    list.addEventListener('keydown', event => { const buttons = [...list.querySelectorAll('button')], index = buttons.indexOf(document.activeElement); if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus(); } if (event.key === 'ArrowUp') { event.preventDefault(); if (!index) query.focus(); else buttons[index - 1]?.focus(); } }); render(); this.info('Command palette', query, list); query.focus();
  }
}

function clampNumber(value, low, high) { return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low)); }
function normalizePlacement(value) {
  const placements = ['right', 'left', 'bottom', 'floating', 'split'], placement = placements.includes(value?.placement) ? value.placement : 'right';
  return { placement, size: Number.isFinite(value?.size) && value.size >= 160 && value.size <= 2400 ? Math.round(value.size) : undefined, x: Number.isFinite(value?.x) ? Math.round(value.x) : undefined, y: Number.isFinite(value?.y) ? Math.round(value.y) : undefined };
}
