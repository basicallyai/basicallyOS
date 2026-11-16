import { markdown, configureMarkdown } from '/markdown.js';
import { createKnowledge } from '/knowledge.js';
import { createCanvas } from '/canvas.js';
import { previewFile } from '/file-preview.js';
import { createRichEditor } from '/vendor/editor.js';
import { copyButton } from '/copy-button.js';
import { noteTitle } from '/note-names.js';
import { managedMemoryUI } from '/memory-ui.js';
import { wireModelMetadata } from '/model-editor.js';
import { wikiLinks } from '/wiki.js';
import { modelMenu, effortFor, levelLabel } from '/model-picker.js';
import { reconcileChildren, updateMarkdown } from '/render-dom.js';
import { initializeShellLayout, detailDivider } from '/split-layout.js';
import { toolOutput } from '/tool-output.js';
import { applyStreamDelta, mergeStreamSnapshot } from '/stream-state.js';

if (new URL(location.href).searchParams.has('token')) history.replaceState(null, '', location.pathname + location.hash);

const $ = selector => document.querySelector(selector);
const state = { providers: [], chats: [], chat: null, selection: null, settings: {}, files: [], sending: false, local: null, tab: 'providers', providerId: null, surface: 'chat', workspaceIds: [], slots: {}, reasoningOpen: new Set() };
let knowledge, canvas;
initializeShellLayout();
$('#stream-thinking').append(detailDivider($('#stream-thinking-content'), 'reasoning'));
const ui = { messages: $('#messages'), scroll: $('#scroll-area'), prompt: $('#prompt') };
let composerEditor, modelPicker;
function initializeComposerEditor() {
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const host = el('div', { class: 'composer-rich' }); ui.prompt.before(host); ui.prompt.hidden = true;
  composerEditor = createRichEditor({ element: host, content: ui.prompt.value, label: 'Message basically OS', toolbar: false, onChange: text => { nativeValue.set.call(ui.prompt, text); saveDraft(); }, onSubmit: () => { if (!state.chat?.running) $('#composer').requestSubmit(); } });
  Object.defineProperty(ui.prompt, 'value', { configurable: true, get: () => composerEditor.getMarkdown(), set: value => { nativeValue.set.call(ui.prompt, String(value || '')); composerEditor.setContent(String(value || '')); } });
  Object.defineProperty(ui.prompt, 'disabled', { configurable: true, get: () => !composerEditor.editor.isEditable, set: value => composerEditor.setEditable(!value) });
  ui.prompt.focus = () => composerEditor.focus();
  host.addEventListener('paste', guard(async event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); event.stopImmediatePropagation(); await addFiles(files); } }), true);
}
let toastTimer, streamFrame, eventSource, viewSequence = 0, listTimer, searchTimer, searchSequence = 0, previewTimer;
document.querySelectorAll('use[href^="#i-"]').forEach(node => node.setAttribute('href', '/icons.svg#' + node.getAttribute('href').slice(3)));
const icon = name => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '/icons.svg#' + name); svg.append(use); return svg; };
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  if (tag === 'button') node.type = 'button';
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (['checked', 'disabled', 'value', 'hidden'].includes(key)) node[key] = value;
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const button = (label, onClick, className = 'secondary-button') => el('button', { class: className, onClick }, label);
const iconButton = (name, label, onClick) => el('button', { class: 'icon-button', title: label, 'aria-label': label, onClick }, icon(name));
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 5000); }
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch('/api' + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let result; try { result = await response.json(); } catch { throw new Error('The app returned an unreadable response.'); }
  if (!response.ok) throw new Error(result.error || 'The request failed.'); return result;
}
function guard(action) { return async (...args) => { try { return await action(...args); } catch (error) { toast(error.message); } }; }
function money(value) { return '$' + value.toFixed(value < .01 ? 5 : value < 1 ? 4 : 2); }
function costLabel(cost = {}) {
  if (!cost.calls) return 'No usage yet';
  if (!cost.reported && !cost.estimated) return cost.unpriced ? 'Price unavailable' : 'Local · no API charge';
  return (cost.unpriced ? 'Partial · ' : cost.estimated ? '~' : '') + money(cost.usd);
}
function currentModel() {
  const provider = state.providers.find(row => row.id === state.selection?.provider);
  return { provider, model: provider?.models.find(row => row.id === state.selection?.model) };
}
function applyTheme(value) {
  const dark = value === 'dark' || value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('basically:theme', value);
}
applyTheme(localStorage.getItem('basically:theme') || 'dark');
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.settings.theme || 'system'));
function draftKey() { return 'basically:draft:' + (state.chat?.id || (state.surface === 'notes' ? 'new-notes' : 'new')); }
function saveDraft() { localStorage.setItem(draftKey(), ui.prompt.value); }
function restoreDraft() { ui.prompt.value = localStorage.getItem(draftKey()) || ''; state.files = []; renderAttachments(); updatePreview(); }
function toggleSidebar(open) {
  if (matchMedia('(max-width: 760px)').matches) { $('#app').classList.toggle('sidebar-open', open ?? !$('#app').classList.contains('sidebar-open')); $('#app').classList.remove('sidebar-closed'); }
  else { $('#app').classList.toggle('sidebar-closed', open === undefined ? !$('#app').classList.contains('sidebar-closed') : !open); localStorage.setItem('basically:sidebar', $('#app').classList.contains('sidebar-closed') ? 'closed' : 'open'); }
}
function closeMobileSidebar() { if (matchMedia('(max-width: 760px)').matches) toggleSidebar(false); }
function isNearBottom() { return ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 180; }
function scrollBottom(force = false) { if (force || isNearBottom()) requestAnimationFrame(() => ui.scroll.scrollTo({ top: ui.scroll.scrollHeight, behavior: 'instant' })); }
function reasoningLabel() {
  const { provider, model } = currentModel(); if (!provider || !model) return '';
  const level = effortFor(model, state.settings, provider); return level ? levelLabel(level) : '';
}
function renderChrome() {
  if ($('#web-button')) { $('#web-button').setAttribute('aria-pressed', String(state.chat ? !!state.chat.webSearch : !!state.webSearch)); $('#web-button').title = (state.chat?.webSearch || (!state.chat && state.webSearch)) ? 'Web access allowed — the model may browse when useful (click to disable)' : 'Allow the model to browse when useful'; $('#web-button').setAttribute('aria-label', (state.chat?.webSearch || (!state.chat && state.webSearch)) ? 'Turn off web access' : 'Allow web access'); }
  const { provider, model } = currentModel(), local = state.selection?.provider === 'local';
  $('#model-label').textContent = local ? state.local?.displayName || state.local?.model || 'Local model' : model?.name || 'Add a model';
  const effort = local ? '' : reasoningLabel();
  $('#model-effort').textContent = effort; $('#model-effort').hidden = !effort;
  $('#model-button').title = local ? 'Local model' : model ? 'Choose model — ' + model.name + (effort ? ', effort ' + effort : '') : 'Choose a model';
  $('#model-button').setAttribute('aria-label', model ? 'Model: ' + model.name + (effort ? ', effort ' + effort : '') : 'Choose model');
  $('#cost-button').textContent = costLabel(state.chat?.cost);
  $('#cost-button').title = 'Completed API requests in this conversation, including tool follow-ups and regenerated responses. In-flight usage is not included yet.';
  const running = !!state.chat?.running;
  $('#send').classList.toggle('is-running', running);
  $('#send').replaceChildren(icon(running ? 'stop' : 'arrow'));
  $('#send').setAttribute('aria-label', running ? 'Stop response' : 'Send message'); $('#send').title = running ? 'Stop response' : 'Send message';
  const busy = !!(state.sending || state.navigating); $('#send').disabled = busy; ui.prompt.disabled = busy; $('#attach-button').disabled = busy; $('#model-button').disabled = busy; $('#scope-button').disabled = busy || running;
  const empty = !state.chat?.messages.length && !state.chat?.canvases?.length && !running;
  $('#app').classList.toggle('empty-chat', empty);
  $('#home-stage').hidden = !empty; $('#scroll-area').hidden = empty;
  const slot = $(empty ? '#home-composer-slot' : '#bottom-composer-slot');
  if ($('#composer-area').parentElement !== slot) slot.append($('#composer-area'));
  const hasModels = state.providers.some(row => row.models.length) || !!state.local?.model;
  $('#welcome-connect').hidden = hasModels; $('#header-add-model').hidden = hasModels;
  $('#cost-button').hidden = !state.chat?.cost?.calls;
  $('#conversation-title').textContent = state.chat?.messages.length ? state.chat.title : 'basically OS';
  $('#workspace-button').hidden = !state.chat;
  $('#conversation-menu').hidden = !state.chat;
  document.title = state.chat ? state.chat.title + ' · basically OS' : 'basically OS';
}
function highlighted(text, query) {
  if (!query) return [text];
  const terms = query.trim().split(/\s+/).slice(0, 20).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.split(new RegExp('(' + terms.join('|') + ')', 'gi')).map((part, index) => index % 2 ? el('mark', {}, part) : part);
}
function renderHistory() {
  const query = $('#chat-search').value.trim(), list = $('#chat-list'); list.replaceChildren();
  const rows = state.chats.filter(chat => (chat.surface || 'chat') === state.surface).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  $('#clear-search').hidden = !query; $('#search-shortcut').hidden = !!query;
  $('#history-label').textContent = query ? 'Search results · ' + rows.length : 'Your conversations';
  $('#search-status').textContent = query ? `${rows.length} conversations found. Search includes message content.` : '';
  if (!rows.length) { list.append(el('div', { class: 'history-empty' }, icon(query ? 'search' : 'chat'), el('p', {}, query ? 'Nothing here yet.' : 'A fresh start.'), el('small', {}, query ? 'Try a different word from a title or message.' : 'Your conversations will appear here.'))); return; }
  let previous = '';
  for (const chat of rows) {
    const days = (Date.now() - chat.updatedAt) / 86400000, group = chat.pinned ? 'Pinned' : days < 1 ? 'Today' : days < 7 ? 'This week' : 'Earlier';
    if (group !== previous) { list.append(el('div', { class: 'history-date' }, group)); previous = group; }
    const open = el('button', { class: 'history-item', title: chat.title, onClick: guard(() => openChat(chat.id)) },
      chat.running ? el('i', { class: 'running-dot', 'aria-label': 'Running' }) : icon(chat.pinned ? 'pin' : 'chat'),
      el('span', { class: 'history-copy' }, el('span', {}, highlighted(chat.title, query)), query && chat.snippet ? el('small', {}, highlighted(chat.snippet, query)) : null));
    const menu = iconButton('more', 'Options for ' + chat.title, guard(() => showConversationMenu(chat.id)));
    menu.classList.add('history-menu');
    list.append(el('div', { class: 'history-row' + (chat.id === state.chat?.id ? ' active' : '') }, open, menu));
  }
}
async function refreshList() { const sequence = ++searchSequence, query = state.surface === 'notes' ? '' : $('#chat-search').value.trim(); const result = await api('/chats?q=' + encodeURIComponent(query)); if (sequence !== searchSequence || query !== (state.surface === 'notes' ? '' : $('#chat-search').value.trim())) return; state.chats = result.chats; renderHistory(); }
function scheduleList() { clearTimeout(listTimer); listTimer = setTimeout(guard(refreshList), 120); }
async function refreshLocalSelection(selection) {
  if (selection?.provider !== 'local') return;
  try { state.local = await api('/local/status'); } catch { /* The library still offers actionable startup errors. */ }
}
async function refreshBootstrap() {
  const data = await api('/bootstrap'); Object.assign(state, { providers: data.providers, defaultModel: data.defaultModel, settings: data.settings, modelDirectory: data.localModelDirectory, localSetup: data.localSetup });
  await refreshLocalSelection(state.selection || state.defaultModel);
  applyTheme(state.settings.theme); renderChrome();
}
function reasoningSummary() { const chevron = icon('chevron'); chevron.classList.add('reasoning-chevron'); return el('summary', {}, el('span', { class: 'reasoning-label' }, 'Thinking'), chevron); }
function reasoningPanel(text, id) {
  const content = el('div', { class: 'reasoning-content' }, markdown(text, null, { math: true })), panel = el('details', { class: 'reasoning-panel' }, reasoningSummary(), el('div', { class: 'reasoning-body' }, content));
  panel.append(detailDivider(content, 'reasoning'));
  panel.open = state.reasoningOpen.has(id); panel.addEventListener('toggle', () => panel.open ? state.reasoningOpen.add(id) : state.reasoningOpen.delete(id)); return panel;
}
function fileHref(path) { return '/api/chats/' + state.chat.id + '/files?path=' + encodeURIComponent(path); }
function fileChip(file) { return button(file.name || file.path, guard(() => previewFile({ api, info, el, href: fileHref(file.path), path: file.path, name: file.name })), 'file-chip'); }
function renderMessages() {
  const near = isNearBottom(), rendered = [], previous = state.messageNodes || new Map(), next = new Map();
  const lastAssistant = [...(state.chat?.messages || [])].reverse().find(message => message.role === 'assistant');
  if (lastAssistant?.thinking && !state.chat.partialThinking && $('#stream-thinking').open) { state.reasoningOpen.add(state.chat.id + ':' + lastAssistant.id); $('#stream-thinking').open = false; }
  for (const message of state.chat?.messages || []) {
    const id = state.chat.id + ':' + (message.id || state.chat.messages.indexOf(message)), signature = JSON.stringify(message) + ':' + (message === lastAssistant && !state.chat.running), cached = previous.get(id);
    if (cached?.signature === signature) { rendered.push(cached.node); next.set(id, cached); continue; }
    const append = node => { if (node.tagName === 'DETAILS' && cached?.node.open) node.open = true; rendered.push(node); next.set(id, { signature, node }); };
    if (message.role === 'user') {
      append(el('article', { class: 'user-message', 'aria-label': 'You' }, message.text ? el('div', { class: 'user-bubble' }, markdown(message.text, undefined, { math: false })) : null,
        message.files?.length ? el('div', { class: 'message-files' }, message.files.map(fileChip)) : null,
        message.references?.length ? el('div', { class: 'message-files reference-files' }, message.references.map(ref => ref.missing || ref.unavailable ? el('span', { class: 'file-chip', title: 'No text excerpt was available for this reference.' }, icon('markdown'), ref.target + ' · unavailable') : button((ref.path ? noteTitle(ref.path) : ref.target) + (ref.line ? ':' + ref.line : '') + (ref.missingSection ? ' · section missing' : ''), guard(() => knowledge.navigate(ref.workspaceId + '::' + ref.path + (ref.heading ? '#' + ref.heading : ''))), 'file-chip'))) : null));
    } else if (message.role === 'assistant') {
      const actions = el('div', { class: 'message-actions' }, copyButton(() => message.text, 'Copy response'));
      actions.append(iconButton('markdown', 'Save response as a note', guard(async () => { await switchSurface('notes'); await knowledge.newFile(message.text); })));
      if (message === lastAssistant && !state.chat.running) actions.append(iconButton('refresh', 'Regenerate response', guard(regenerate)));
      append(el('article', { class: 'assistant-message', 'aria-label': 'basically OS' },
        el('div', { class: 'assistant-heading' }, el('img', { src: '/brand-mark.svg', alt: '' }), el('span', {}, 'basically'), el('small', {}, message.displayName || message.model || '')),
        message.thinking ? reasoningPanel(message.thinking, state.chat.id + ':' + message.id) : null,
        message.text ? markdown(message.text, null, { math: true }) : !message.thinking && !message.error && !message.stopped ? el('p', { class: 'help' }, 'This model returned no readable text.') : null,
        message.stopped ? el('p', { class: 'stopped' }, 'Response stopped.') : message.error ? el('p', { class: 'message-error' }, message.error) : null,
        message.localContext?.omittedPromptTokens ? el('p', { class: 'response-context-note', title: 'The runtime retained the newest prompt tokens. Omitted content can include older messages, instructions, references or memory.' }, message.localContext.omittedPromptTokens.toLocaleString() + ' prompt tokens omitted to fit this model’s ' + message.localContext.contextWindow.toLocaleString() + '-token context.') : null,
        el('div', { class: 'response-footer' }, actions, el('span', { class: 'response-speed', title: message.performance ? 'Actual output tokens (including provider-counted reasoning) divided by request-to-completion time. Includes prefill, network and buffering—not a decode-only benchmark. ' + message.performance.outputTokens + ' tokens in ' + (message.performance.elapsedMs / 1000).toFixed(2) + ' seconds.' : 'Speed unavailable: this response has no complete token usage and timing measurement.' }, message.performance ? message.performance.tokensPerSecond.toFixed(1) + ' tok/s' : '— tok/s'))));
    } else if (message.role === 'tool') {
      const labels = { list_files: 'Listed workspace files', read_file: 'Read a file', write_file: 'Write a file', run_command: 'Run a command', read_memory: 'Read shared memory', write_memory: 'Update shared memory' };
      const output = toolOutput(message, el);
      const card = el('details', { class: 'tool-card' }, el('summary', {}, labels[message.name] || message.name.replaceAll('_', ' '),
        el('span', { class: 'tool-status ' + message.status }, message.status === 'done' ? '✓ Done' : message.status === 'error' ? 'Not completed' : message.status === 'interrupted' ? 'Interrupted' : 'Working…')),
        output, detailDivider(output, 'tools'));
      if (message.name === 'write_file' && message.status === 'done' && typeof message.args?.path === 'string') card.append(fileChip({ path: message.args.path, name: message.args.path.split('/').pop() }));
      append(card);
    }
  }
  reconcileChildren(ui.messages, rendered); state.messageNodes = next;
  renderStreaming(); renderApprovals(); renderChrome(); mountCanvas();
  $('#chat-notice').hidden = !state.chat?.error;
  $('#chat-notice').textContent = state.chat?.error || '';
  if (near) scrollBottom(true);
}
const streamingMarkdown = (value, context) => markdown(value, context, { streaming: true, math: true });
function renderStreaming() {
  const running = !!state.chat?.running;
  $('#streaming').hidden = !running;
  updateMarkdown($('#streaming-content'), state.chat?.partial || '', streamingMarkdown);
  const phase = state.chat?.approvals?.length ? 'approval' : state.chat?.phase || 'working';
  $('#thinking').hidden = !running;
  $('#thinking').lastChild.textContent = ({ connecting: 'Connecting to your model', thinking: 'Thinking', tool: 'Using tools' + (state.chat?.activeTool ? ' · ' + state.chat.activeTool.replaceAll('_', ' ') : ''), responding: 'Writing response', approval: 'Waiting for your approval', working: 'Working · reasoning content may not be exposed' })[phase] || 'Working';
  const thinkingText = running ? state.chat?.partialThinking || '' : '';
  $('#stream-thinking').hidden = !thinkingText;
  updateMarkdown($('#stream-thinking-content'), thinkingText, streamingMarkdown, null);
}
function renderApprovals() {
  $('#approvals').replaceChildren(...(state.chat?.approvals || []).map(approval => {
    const actions = el('div', { class: 'approval-actions' });
    const answer = allow => guard(async () => {
      actions.querySelectorAll('button').forEach(node => node.disabled = true);
      try { await api('/chats/' + state.chat.id + '/approve', { id: approval.id, allow }); await refreshCurrent(); }
      finally { actions.querySelectorAll('button').forEach(node => node.disabled = false); }
    });
    actions.append(button('Deny', answer(false)), button('Allow once', answer(true), 'primary-button'));
    return el('article', { class: 'approval-card' }, el('h3', {}, approval.tool === 'run_command' ? 'Allow this command?' : approval.tool === 'write_memory' ? 'Update shared memory?' : 'Allow this file change?'), el('p', {}, approval.warning), approval.preview ? el('div', {}, knowledge.diffView(approval.preview), approval.preview.changes.some(change => change.truncated) ? el('details', {}, el('summary', {}, 'Full proposed tool arguments · review before approval'), el('pre', { class: 'file-diff' }, JSON.stringify(approval.args, null, 2))) : null) : el('pre', {}, approval.tool === 'run_command' ? approval.args.command : approval.tool === 'write_memory' ? approval.args.content : JSON.stringify(approval.args, null, 2)), actions);
  }));
}
function mountCanvas() {
  const running = !!state.chat?.running;
  canvas.sync(state.chat, { running, activeTool: state.chat?.activeTool || null });
}
async function refreshCurrent() {
  const id = state.chat?.id; if (!id || state.navigating) return;
  const sequence = ++viewSequence, chat = await api('/chats/' + id);
  if (state.chat?.id !== id || sequence !== viewSequence) return;
  state.chat = mergeStreamSnapshot(state.chat, chat); state.selection = chat.selection; renderMessages();
}
async function openChat(id, updateHistory = true, expectedSurface) {
  if (state.sending) return toast('Wait a moment while your message is submitted.');
  if (!expectedSurface) saveDraft(); const sequence = ++viewSequence; state.navigating = true; renderChrome();
  try {
  const chat = await api('/chats/' + id); if (sequence !== viewSequence) return;
  const surface = chat.surface || 'chat', changedSurface = surface !== state.surface; if (expectedSurface && expectedSurface !== surface) throw new Error('This conversation belongs to a different surface.');
  if (changedSurface) { state.slots[state.surface] = state.chat?.id || null; mountSurface(surface); if (surface === 'notes') knowledge.setContext('ai'); }
  state.chat = chat; state.webSearch = false; state.slots[state.surface] = id; localStorage.setItem('basically:chat-slots', JSON.stringify(state.slots)); state.selection = chat.selection || state.defaultModel; state.workspaceIds = chat.workspaceIds || []; restoreDraft();
  await refreshLocalSelection(state.selection);
  if (updateHistory || changedSurface) history[updateHistory ? 'pushState' : 'replaceState'](null, '', '#' + (state.surface === 'notes' ? 'surface=notes&' : '') + 'chat=' + id);
  renderMessages(); renderHistory(); closeMobileSidebar(); scrollBottom(true);
  } finally { if (sequence === viewSequence) { state.navigating = false; renderChrome(); } }
}
function newChat(updateHistory = true, preserveDraft = true) {
  if (state.sending) return toast('Wait a moment while your message is submitted.');
  if (preserveDraft) saveDraft(); viewSequence++; state.navigating = false; state.chat = null; state.webSearch = false; state.slots[state.surface] = null; localStorage.setItem('basically:chat-slots', JSON.stringify(state.slots)); state.selection = state.defaultModel; state.workspaceIds = state.surface === 'notes' ? knowledge.workspaces.map(row => row.id) : []; restoreDraft();
  if (updateHistory) history.pushState(null, '', state.surface === 'notes' ? '#surface=notes' : location.pathname);
  renderMessages(); renderHistory(); closeMobileSidebar(); ui.prompt.focus();
}
function renderAttachments() {
  $('#attachment-list').replaceChildren(...state.files.map((file, index) => el('div', { class: 'file-chip' }, icon('clip'), el('span', {}, file.name),
    el('button', { 'aria-label': 'Remove ' + file.name, onClick: () => { state.files.splice(index, 1); renderAttachments(); } }, icon('close')))));
}
async function addFiles(files) {
  if (state.sending) throw new Error('Wait until your message is submitted before attaching more files.');
  if (state.files.length + files.length > 8) throw new Error('Attach at most 8 files.');
  if ([...state.files, ...files].reduce((sum, file) => sum + file.size, 0) > 6 * 1024 * 1024) throw new Error('Attachments are limited to 6 MB total.');
  state.files.push(...files); renderAttachments();
}
async function encodedFiles() {
  return Promise.all(state.files.map(async file => {
    const data = await new Promise((accept, reject) => { const reader = new FileReader(); reader.onload = () => accept(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Could not read ' + file.name)); reader.readAsDataURL(file); });
    return { name: file.name, type: file.type, data };
  }));
}
async function send(event) {
  event.preventDefault();
  if (state.sending || state.navigating) return;
  if (state.chat?.running) { state.sending = true; renderChrome(); try { state.chat = await api('/chats/' + state.chat.id + '/stop', {}); renderMessages(); } finally { state.sending = false; renderChrome(); } return; }
  if (!ui.prompt.value.trim() && !state.files.length) return;
  if (!state.selection) { openModelPicker(); return; }
  const text = ui.prompt.value, inputDraft = draftKey();
  state.sending = true; renderChrome();
  try {
    await state.reasoningQueue?.catch(() => {});
    let scope = state.chat?.workspaceIds || state.workspaceIds;
    if (!scope.length && (wikiLinks(text).length || /\bnotes?\b|\.md\b/i.test(text))) {
      const notes = knowledge.workspaces.find(row => row.managed === 'notes');
      if (notes) {
        if (!confirm('Allow this conversation to read My Notes and open notes in Canvas? Relevant note text will be sent to your selected provider, and model edits follow review rules. Additional project folders must be chosen explicitly.')) return;
        scope = [notes.id]; if (state.chat) state.chat = await api('/chats/' + state.chat.id, { workspaceIds: scope }, 'PATCH'); state.workspaceIds = scope;
      }
    }
    const context = state.surface === 'notes' ? knowledge.activeContext() : {};
    if (context.activeResource && !scope.includes(context.activeResource.workspaceId)) {
      const folder = knowledge.workspaces.find(row => row.id === context.activeResource.workspaceId);
      if (!confirm('Allow this conversation to access the attached folder “' + folder.name + '” for the active document?')) return;
      scope = [...scope, folder.id]; if (state.chat) state.chat = await api('/chats/' + state.chat.id, { workspaceIds: scope }, 'PATCH'); state.workspaceIds = scope;
    }
    const references = await knowledge.resolveForMessage(text, scope, context.activeResource || state.chat?.activeResource);
    if (references === null) return;
    const files = await encodedFiles();
    if (!state.chat) {
      state.chat = await api('/chats', { selection: state.selection, workspaceIds: state.workspaceIds, surface: state.surface }); history.pushState(null, '', '#' + (state.surface === 'notes' ? 'surface=notes&' : '') + 'chat=' + state.chat.id);
    }
    const chatId = state.chat.id;
    if (state.webSearch && !state.chat.webSearch) state.chat = await api('/chats/' + chatId, { webSearch: true }, 'PATCH');
    await canvas.flush();
    await api('/chats/' + chatId + '/messages', { text, files, selection: state.selection, context, references });
    localStorage.removeItem(inputDraft); localStorage.removeItem(draftKey()); ui.prompt.value = ''; state.files = []; renderAttachments(); updatePreview();
    await refreshCurrent(); await refreshList(); scrollBottom(true); ui.prompt.focus();
  } finally { state.sending = false; renderChrome(); }
}
async function webSearchSettings() {
  const status = await api('/web-search');
  const mode = el('select', { 'aria-label': 'Web search method' }, el('option', { value: 'browser' }, 'Local browser (default)'), el('option', { value: 'api' }, 'Search API (optional)')); mode.value = status.provider === 'browser' ? 'browser' : 'api';
  const browser = el('select', { 'aria-label': 'Installed browser' }, el('option', { value: 'auto' }, 'Automatic — prefer the default supported browser'), ...(status.browsers || []).map(row => el('option', { value: row.id }, row.name))); browser.value = status.browser === 'auto' || status.browsers?.some(row => row.id === status.browser) ? status.browser : 'auto';
  const engine = el('select', { 'aria-label': 'Search engine' }, el('option', { value: 'duckduckgo' }, 'DuckDuckGo'), el('option', { value: 'bing' }, 'Bing')); engine.value = status.engine || 'bing';
  const provider = el('select', { 'aria-label': 'Search API provider' }, el('option', { value: 'brave' }, 'Brave Search'), el('option', { value: 'tavily' }, 'Tavily')); provider.value = status.apiProvider || 'brave';
  const key = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search API key' }), clearKey = el('input', { type: 'checkbox', 'aria-label': 'Remove saved search API key' });
  const keyStatus = el('p', { class: 'help', role: 'status' });
  const localFields = el('div', { class: 'web-research-options' }, el('p', { class: 'help' }, status.browserName ? 'Installed browser: ' + status.browserName + '. No search API key or browser download is needed.' : 'No supported installed browser was found. Install Firefox, Chrome, Edge, Brave or Chromium, or choose the optional API method. Safari is not automated.'), el('label', {}, 'Browser', browser), el('label', {}, 'Search engine', engine), el('p', { class: 'help' }, 'Uses a temporary background profile, not personal tabs, cookies, logins or extensions. Queries go to the selected search engine. Verification challenges are reported, not bypassed.'));
  const apiFields = el('div', { class: 'web-research-options' }, el('label', {}, 'API provider', provider), el('label', {}, 'API key', key), keyStatus, el('label', { class: 'web-research-remove' }, clearKey, 'Remove this provider’s saved key'), el('p', { class: 'help' }, 'Optional: requests go to the selected API provider and may incur provider charges. Keys are kept in private local JSON, not OS-vault encrypted, and are never returned to the browser. Each provider keeps its own key. Opened pages use bounded, script-free HTTPS extraction; no installed browser is required.'));
  const update = () => { localFields.hidden = mode.value !== 'browser'; apiFields.hidden = mode.value !== 'api'; const saved = !!status.apiConfigured?.[provider.value]; key.placeholder = saved ? 'Key saved — leave blank to keep' : 'Enter your search API key'; keyStatus.textContent = saved ? 'A key is saved for this provider. Leave the field blank to keep it.' : 'No key saved for this provider.'; clearKey.disabled = !saved; };
  mode.addEventListener('change', update); provider.addEventListener('change', () => { key.value = ''; clearKey.checked = false; update(); }); update();
  const save = button('Save browsing settings', guard(async () => { const apiMode = mode.value === 'api'; if (apiMode && !key.value.trim() && !status.apiConfigured?.[provider.value] && !clearKey.checked) throw new Error('Enter an API key, or choose Local browser.'); save.disabled = true; try { await api('/web-search', apiMode ? { provider: provider.value, ...(key.value.trim() ? { apiKey: key.value.trim() } : {}), ...(clearKey.checked ? { clearKey: true } : {}) } : { provider: 'browser', browser: browser.value, engine: engine.value }, 'PUT'); $('#info-dialog').close(); } finally { save.disabled = false; } }), 'primary-button');
  info('Web browsing', el('p', { class: 'help' }, 'Choose how web tools work here in Settings. The orange Globe only gives permission to browse; the model can answer without searching. Method changes apply to subsequent tool calls. There is no automatic switch to a paid API if local search fails.'), el('label', { class: 'web-research-method' }, 'Search method', mode), localFields, apiFields, save);
}
$('#web-button').addEventListener('click', guard(async () => {
  const allowed = state.chat ? !!state.chat.webSearch : !!state.webSearch;
  if (!allowed) { const status = await api('/web-search'); if (!status.configured) throw new Error(status.provider === 'browser' ? 'No supported browser was found. Choose a browser or configure the optional API under Settings → Preferences → Web browsing settings.' : 'Add a search API key or choose Local browser under Settings → Preferences → Web browsing settings.'); }
  if (state.chat) { if (state.chat.running) throw new Error('Stop the response before changing web access.'); state.chat = await api('/chats/' + state.chat.id, { webSearch: !state.chat.webSearch }, 'PATCH'); state.webSearch = false; }
  else state.webSearch = !state.webSearch;
  renderChrome();
}));
async function regenerate() {
  if (!state.chat || state.chat.running) return;
  await api('/chats/' + state.chat.id + '/regenerate', { selection: state.selection }); await refreshCurrent(); scrollBottom(true);
}
function pickerProviders() {
  const providers = [...state.providers];
  if (state.local?.model && ['ready', 'generating'].includes(state.local.phase)) providers.push({ id: 'local', name: 'On your device', configured: true, models: [{ id: 'local-model', name: state.local.displayName || state.local.model }] });
  return providers;
}
function openModelPicker() {
  if (!state.providers.some(provider => provider.models.length) && !state.local?.model) { openSetup(); return; }
  modelPicker ||= modelMenu({
    trigger: $('#model-button'), providers: pickerProviders, selection: () => state.selection, settings: () => state.settings, el, icon,
    manage: () => openSettings(),
    setReasoning: (key, level) => {
      state.reasoningQueue = (state.reasoningQueue || Promise.resolve()).catch(() => {}).then(async () => { try { state.settings = await api('/settings', { reasoningOverrides: { [key]: level } }, 'PATCH'); renderChrome(); toast('Reasoning effort saved. The next request uses ' + level + '.'); } catch (error) { toast(error.message); throw error; } });
      return state.reasoningQueue;
    },
    choose: async (provider, model) => {
      try {
        await state.reasoningQueue?.catch(() => {});
        if (!provider.configured) { modelPicker?.close(); openSettings('providers', provider.id); return; }
        if (state.chat?.running) throw new Error('Stop the current response before changing models.');
        if (provider.id !== 'local' && (!model.contextWindow || !model.maxTokens)) { modelPicker?.close(); openSettings('providers', provider.id); toast('Set verified context and output limits for this model.'); return; }
        const selection = { provider: provider.id, model: model.id };
        if (state.chat) { state.chat = await api('/chats/' + state.chat.id, { selection }, 'PATCH'); viewSequence++; }
        const result = await api('/default-model', { selection }); state.defaultModel = result.defaultModel; state.selection = selection;
        renderChrome();
      } catch (error) { toast(error.message); throw error; }
    },
  });
  if (modelPicker.isOpen()) modelPicker.close(); else modelPicker.open();
}
function info(title, ...nodes) { $('#info-title').textContent = title; $('#info-content').replaceChildren(...nodes.filter(node => node !== null && node !== undefined && node !== false)); if (!$('#info-dialog').open) $('#info-dialog').showModal(); }
function showCost() {
  const cost = state.chat?.cost || { calls: 0, usd: 0, tokens: 0, estimated: 0, reported: 0, unpriced: 0, local: 0 };
  info('Conversation usage', el('h3', {}, costLabel(cost)),
    ...[['Completed model requests', cost.calls], ['Tokens (including cache)', cost.tokens?.toLocaleString() || '0'], ['Provider-reported requests', cost.reported], ['Rate-estimated requests', cost.estimated], ['Requests without prices', cost.unpriced], ['Local requests', cost.local]].map(([label, value]) => el('div', { class: 'stat-row' }, el('span', {}, label), el('span', {}, value || 0))),
    el('p', { class: 'help' }, 'Totals include every completed model request in this conversation, including tool follow-ups and regenerated responses. In-flight usage is not included until the response finishes. Estimates use configured USD-per-million-token prices, not your invoice. Unknown pricing is never counted as a free request. Local inference has no API charge; hardware/electricity are not estimated.'));
}
function downloadBlob(value, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = el('a', { href: url, download: name }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadBackup(id) {
  const backup = await api(id ? '/chats/' + id + '/export' : '/chats/export');
  downloadBlob(JSON.stringify(backup), id ? 'basically-os-conversation.json' : 'basically-os-chats.json');
}
async function showConversationMenu(id = state.chat?.id) {
  if (!id) return;
  const chat = await api('/chats/' + id);
  const change = async patch => {
    const result = await api('/chats/' + id, patch, 'PATCH');
    if (state.chat?.id === id) { state.chat = result; renderChrome(); }
    await refreshList(); return result;
  };
  const action = (name, label, run, danger = false) => el('button', { class: 'conversation-action' + (danger ? ' danger' : ''), onClick: guard(run) }, icon(name), el('span', {}, label));
  info('Conversation settings', el('p', { class: 'conversation-meta' }, chat.title), el('div', { class: 'menu-actions' },
    action('edit', 'Rename conversation', () => {
      const input = el('input', { value: chat.title, maxlength: 160, required: '' });
      info('Rename conversation', el('form', { onSubmit: guard(async event => { event.preventDefault(); await change({ title: input.value }); $('#info-dialog').close(); }) },
        el('label', { class: 'field' }, 'Conversation name', input), el('button', { type: 'submit', class: 'primary-button' }, 'Save name'))); input.focus(); input.select();
    }),
    action('memory', chat.memoryDisabled ? 'Enable memory for this conversation' : 'Disable memory for this conversation', guard(async () => {
      await change({ memoryDisabled: !chat.memoryDisabled }); $('#info-dialog').close();
      toast(chat.memoryDisabled ? 'Memory enabled for this conversation.' : 'Memory is off for this conversation. Existing memories are unchanged.');
    })),
    action('memory', 'Memory used for the last response', () => info('Memory used',
      el('p', { class: 'help' }, 'Initial memory retrieval for the last response is listed below; additional memory reads appear in tool activity. Past chat prompts are weighted by relevance and gradual recency, not an age cutoff. Excerpts are bounded, not complete recall. Workspace scope and memory-off choices apply. Attachments and tool output are excluded; secret detection is heuristic.'),
      ...(chat.memorySources?.sources?.length ? chat.memorySources.sources.map(source => el('div', { class: 'memory-source' }, el('strong', {}, source.title), el('p', { class: 'help' }, (source.type === 'conversation' ? 'Past conversation · user prompt' : source.type === 'legacy' ? 'Shared memory file' : 'Saved memory') + (source.timestamp ? ' · ' + new Date(source.timestamp).toLocaleDateString() : '') + (Number.isFinite(source.score) ? ' · weight ' + source.score.toFixed(3) : '') + (source.characters ? ' · ' + source.characters + ' characters' : '')))) : [el('p', { class: 'help' }, 'No memory sources recorded for the last response. Older responses may predate this disclosure.')] ))),
    action('pin', chat.pinned ? 'Unpin conversation' : 'Pin conversation', async () => { await change({ pinned: !chat.pinned }); $('#info-dialog').close(); }),
    action('sliders', 'Conversation instructions', () => {
      const editor = markdownEditor(chat.instructions, 'Instructions just for this conversation', 10000);
      info('Conversation instructions', el('p', { class: 'help' }, 'Applied on the next message. Shared memory and your general preferences still apply.'), editor.element,
        button('Save instructions', guard(async () => { await change({ instructions: editor.input.value }); $('#info-dialog').close(); toast('Conversation instructions saved.'); }), 'primary-button'));
    }),
    action('download', 'Export complete backup (.json)', () => downloadBackup(id)),
    action('markdown', 'Export readable Markdown (.md)', () => {
      const text = '# ' + chat.title + '\n\n' + chat.messages.map(message => `## ${message.role === 'user' ? 'You' : message.role === 'tool' ? 'Tool: ' + message.name : 'basically OS'}\n\n${message.text || ''}${message.files?.length ? '\n\n' + message.files.map(file => `[${file.name}](${file.path})`).join('\n') : ''}`).join('\n\n---\n\n');
      downloadBlob(text, 'conversation.md', 'text/markdown');
    }),
    action('folder', 'Archive conversation', () => info('Archive conversation?', el('p', { class: 'help' }, 'Hide it from the sidebar without erasing its history or files. Archived conversations are included in the full data export.'),
      button('Archive conversation', guard(async () => { await change({ archived: true }); $('#info-dialog').close(); if (state.chat?.id === id) newChat(); await refreshList(); })))),
    action('trash', 'Delete permanently', () => info('Delete this conversation?', el('p', { class: 'help' }, 'This permanently erases “' + chat.title + '”, its revisions, usage records and all workspace files. Shared memory is kept. This cannot be undone. Export a backup first if needed.'),
      button('Delete permanently', guard(async () => { await api('/chats/' + id, undefined, 'DELETE'); localStorage.removeItem('basically:draft:' + id); $('#info-dialog').close(); if (state.chat?.id === id) newChat(); localStorage.removeItem('basically:draft:' + id); await refreshList(); toast('Conversation deleted.'); }), 'danger-button')), true)));
}
function markdownEditor(value = '', label = 'Markdown', maxlength = 30000) {
  const input = el('textarea', { maxlength, hidden: true, 'aria-label': label + ' Markdown source' }, value), host = el('div', { class: 'settings-rich-editor' });
  const rich = createRichEditor({ element: host, content: value, label, onChange: () => input.dispatchEvent(new Event('input')) });
  Object.defineProperty(input, 'value', { get: () => rich.getMarkdown(), set: text => rich.setContent(String(text)) }); input.focus = () => rich.focus();
  return { input, element: el('div', { class: 'markdown-editor' }, el('div', { class: 'editor-heading' }, el('label', {}, label)), host, input) };
}
function updatePreview() {
  const region = $('#compose-preview'); if (!region) return;
  clearTimeout(previewTimer);
  const value = ui.prompt.value;
  region.hidden = true;
  if (region.hidden) { region.replaceChildren(); return; }
  previewTimer = setTimeout(() => {
    if (ui.prompt.value !== value) return;
    region.replaceChildren(markdown(value, null, { math: false }));
    $('#composer').classList.add('has-preview');
  }, 120);
}
async function renderMemory() {
  const section = el('section', { class: 'settings-single' }, el('h3', {}, 'Memory that stays with you.'), el('p', { class: 'help' }, 'Your shared Markdown reference file and an organized, agent-managed memory library. Review, edit, consolidate or remove durable information below. Never store secrets.'));
  $('#settings-content').append(section);
  await managedMemoryUI(section, { api, el, button, guard, toast, info, closeInfo: () => $('#info-dialog').close(), markdownEditor, markdown, state, renderSettings });
  section.append(el('hr'), el('h3', {}, 'Manual reference · MEMORY.md'));
  const data = await api('/memory'); if (!section.isConnected) return;
  const editor = markdownEditor(data.content, 'MEMORY.md', 65536), status = el('p', { class: 'form-message', role: 'status' });
  const save = button('Save memory', guard(async () => {
    save.disabled = true;
    try { const result = await api('/memory', { content: editor.input.value, revision: data.revision }, 'PUT'); data.revision = result.revision; data.content = result.content; status.classList.remove('error'); status.textContent = 'Saved. Used with the next message in any conversation.'; }
    catch (error) { status.textContent = error.message; status.classList.add('error'); }
    finally { save.disabled = false; }
  }), 'primary-button');
  section.append(el('p', { class: 'local-path' }, data.path), editor.element, status, el('div', { class: 'editor-actions' }, button('Reload from disk', () => { if (editor.input.value === data.content || confirm('Discard your unsaved memory edits and reload?')) renderSettings(); }), save),
    el('p', { class: 'help' }, 'Latest file contents are included with every user message, including local models. Tool-capable models can read and propose edits. Concurrent edits are checked before saving.'));
}
async function importBackup(file) {
  if (!file) return;
  if (file.size > 96 * 1024 * 1024) throw new Error('Backup files are limited to 96 MB.');
  let backup; try { backup = JSON.parse(await file.text()); } catch { throw new Error('Choose a valid JSON conversation backup.'); }
  const count = backup.entries?.length;
  if (backup.format !== 'basically-os/conversations' || backup.version !== 1 || !Array.isArray(backup.entries) || !count) throw new Error('Choose a basically OS version-1 conversation backup.');
  info('Import conversations?', el('p', { class: 'help' }, `Add ${count} conversation${count === 1 ? '' : 's'} from “${file.name}”, including files, history and usage records. Existing chats will not be overwritten. Only import backups you trust; their content will be sent to the model if you continue a chat. Connections, API keys and shared memory are not imported.`),
    button('Import conversations', guard(async event => { const target = event.currentTarget; target.disabled = true; try { const result = await api('/chats/import', backup); $('#info-dialog').close(); await refreshList(); const first = result.imported.find(chat => !chat.archived); if (first) await openChat(first.id); toast(`Imported ${result.imported.length} conversation(s).`); } finally { target.disabled = false; } }), 'primary-button'));
}
async function showArchives() {
  const result = await api('/chats?archived=1');
  info('Archived conversations', el('p', { class: 'help' }, 'Restore a conversation to the sidebar. Its messages, files and usage records are kept.'),
    ...result.chats.map(chat => el('div', { class: 'stat-row' }, el('span', {}, chat.title), button('Restore', guard(async () => { await api('/chats/' + chat.id, { archived: false }, 'PATCH'); await refreshList(); await showArchives(); })))),
    !result.chats.length ? el('p', { class: 'help' }, 'No archived conversations.') : null);
}
function renderData() {
  $('#settings-content').append(el('section', { class: 'settings-single' }, el('h3', {}, 'Your conversations belong to you.'), el('p', { class: 'help' }, 'Complete backups include original messages, tool calls and results, regenerated revisions, instructions, usage records, attachments and workspace files. Import gives each conversation a fresh ID; it never overwrites an existing chat or executes an imported tool call.'),
    el('div', { class: 'data-card' }, icon('download'), el('div', {}, el('h4', {}, 'Export everything'), el('p', { class: 'help' }, 'All conversations, including archived history. Stop running responses first.')), button('Export backup', guard(() => downloadBackup()), 'primary-button')),
    el('div', { class: 'data-card' }, icon('upload'), el('div', {}, el('h4', {}, 'Bring your conversations back'), el('p', { class: 'help' }, 'Import a basically OS JSON backup.')), button('Import backup', () => $('#import-input').click())),
    button('Manage archived conversations', guard(showArchives)),
    el('p', { class: 'help' }, 'Backups are not encrypted and may contain private files. Keep them secure. Connections, keys, local model weights and shared MEMORY.md are not part of conversation backups. Limit: 500 chats, 4,000 workspace entries, 40 MB of workspace files and 90 MB total per export. Oversized backups fail explicitly; nothing is silently left out. Markdown exports are readable copies, not restorable backups.')));
}
async function showFiles(path = '.') {
  if (!state.chat) return;
  const result = await api('/chats/' + state.chat.id + '/workspace?path=' + encodeURIComponent(path));
  info('Conversation files', el('p', { class: 'help' }, 'Uploaded and generated files in this conversation’s workspace. Click to preview; download the original from the preview.'),
    path !== '.' ? button('← Workspace root', guard(() => showFiles('.'))) : null,
    ...result.files.map(file => file.directory ? el('button', { class: 'file-row', onClick: guard(() => showFiles(file.path)) }, icon('folder'), file.name)
      : button(file.name, guard(() => previewFile({ api, info, el, href: fileHref(file.path), path: file.path, name: file.name })), 'file-row')),
    !result.files.length ? el('p', { class: 'help' }, 'No files yet. Attach a file or ask the assistant to create one.') : null);
}
function openSetup() {
  closeMobileSidebar();
  $('#setup-content').replaceChildren(providerEditor(null, true));
  $('#setup-dialog').showModal();
  $('#setup-content [name=apiKey]').focus();
}
function openSettings(tab = 'providers', providerId) {
  state.tab = tab; if (providerId !== undefined) state.providerId = providerId;
  renderSettings(); if (!$('#settings-dialog').open) $('#settings-dialog').showModal();
}
let settingsViewKey = '';
function renderSettings() {
  $('#settings-tabs').querySelectorAll('button').forEach(node => node.classList.toggle('active', node.dataset.tab === state.tab));
  $('#settings-content').replaceChildren();
  if (state.tab === 'providers') renderProviders();
  else if (state.tab === 'preferences') renderPreferences();
  else if (state.tab === 'memory') guard(renderMemory)();
  else if (state.tab === 'data') renderData();
  else guard(renderLocal)();
  const key = state.tab + ':' + state.providerId;
  if (key !== settingsViewKey) $('#settings-content').scrollTop = 0;
  settingsViewKey = key;
}
function field(label, name, value, attrs = {}) { return el('label', { class: 'field' + (attrs.wide ? ' wide' : '') }, label, el('input', { name, value: value ?? '', ...Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'wide')) })); }
function selectField(label, name, value, options) {
  const select = el('select', { name }, options.map(([id, text]) => el('option', { value: id }, text))); select.value = value;
  return el('label', { class: 'field' }, label, select);
}
function check(label, name, value) { return el('label', { class: 'check-field' }, el('input', { type: 'checkbox', name, checked: !!value }), label); }
function renderProviders() {
  const layout = el('div', { class: 'provider-layout' + (!state.providers.length ? ' single-provider' : '') }), nav = el('nav', { class: 'provider-nav', 'aria-label': 'API connections' });
  const selected = state.providerId === 'new' ? null : state.providers.find(provider => provider.id === state.providerId) || state.providers[0];
  state.providerId = selected?.id ?? 'new';
  for (const provider of state.providers) nav.append(el('button', { class: provider.id === state.providerId ? 'active' : '', onClick: () => { state.providerId = provider.id; renderSettings(); } }, provider.name, el('small', {}, provider.configured ? provider.requiresKey ? 'Key saved · ' + provider.models.length + ' models' : 'No key · ' + provider.models.length + ' models' : 'Add API key')));
  nav.append(button('Add connection', () => { state.providerId = 'new'; renderSettings(); }, 'add-provider'));
  layout.append(nav, providerEditor(selected)); $('#settings-content').append(layout);
}
function modelRow(model = {}, connection) {
  const row = el('div', { class: 'model-row' }); row.source = model;
  row.append(el('div', { class: 'model-row-main' }, field('Exact model ID', 'modelId', model.id, { placeholder: 'Enter the exact model ID', required: '' }), field('Display name', 'modelName', model.name, { placeholder: 'Optional label' }), iconButton('close', 'Remove model', () => row.remove())));
  const cost = model.cost;
  row.append(el('div', { class: 'model-routing' }, field('Exact upstream provider (optional · OpenRouter)', 'upstreamProvider', model.upstreamProvider, { placeholder: 'Provider name or endpoint tag; blank uses automatic routing', maxlength: 120 }), el('p', { class: 'help' }, 'Pins this model to that provider with no fallback. Changing it retrieves that endpoint’s limits and token prices; unavailable prices stay unknown. Other APIs use their connection endpoint. Past billed usage is never rewritten.')));
  row.append(el('details', { ...(model.id && (!model.contextWindow || !model.maxTokens) ? { open: '' } : {}) }, el('summary', {}, 'Limits, capabilities & pricing'), el('div', { class: 'model-advanced' },
    field('Context window (tokens)', 'contextWindow', model.contextWindow, { type: 'number', min: 256, max: 10000000, placeholder: 'Unavailable — enter verified limit' }),
    field('Output limit per request', 'maxTokens', model.maxTokens, { type: 'number', min: 1, max: 10000000, placeholder: 'Unavailable — enter verified limit' }),
    el('div', { class: 'capabilities' }, check('Enable tool calling', 'tools', model.tools === true), check('Images / vision', 'vision', model.vision), check('Reasoning model', 'reasoning', model.reasoning)),
    selectField('Documented reasoning API', 'reasoningFormat', model.reasoningConfig?.format || 'none', [['none', 'No configurable reasoning advertised'], ['openai', 'OpenAI reasoning effort'], ['openrouter', 'OpenRouter normalized reasoning']]),
    field('Supported reasoning levels (comma-separated)', 'reasoningLevels', model.reasoningConfig?.levels.join(', '), { placeholder: 'Only documented levels: e.g. low, medium, high' }),
    el('p', { class: 'pricing-description' }, 'USD per 1M tokens. Unavailable rates stay blank, including cache prices. Usage without the required rates remains unpriced. Capability toggles are explicit opt-ins; confirm support with your endpoint.'),
    field('Input · $ / 1M', 'inputPrice', cost?.input, { type: 'number', min: 0, step: 'any', placeholder: 'Unknown' }),
    field('Output · $ / 1M', 'outputPrice', cost?.output, { type: 'number', min: 0, step: 'any', placeholder: 'Unknown' }),
    field('Cache read · $ / 1M', 'cacheReadPrice', cost?.cacheRead, { type: 'number', min: 0, step: 'any', placeholder: 'Unknown' }),
    field('Cache write · $ / 1M', 'cacheWritePrice', cost?.cacheWrite, { type: 'number', min: 0, step: 'any', placeholder: 'Unknown' }))));
  if (connection) wireModelMetadata(row, { api, connection, el, button });
  return row;
}
function readModelRow(row) {
  const value = name => row.querySelector(`[name=${name}]`).value;
  const input = value('inputPrice'), output = value('outputPrice'), read = value('cacheReadPrice'), write = value('cacheWritePrice');
  const number = text => text === '' ? null : Number(text), format = value('reasoningFormat'), levels = value('reasoningLevels').split(',').map(level => level.trim()).filter(Boolean);
  return { id: value('modelId'), name: value('modelName'), upstreamProvider: value('upstreamProvider').trim() || null, contextWindow: number(value('contextWindow')), maxTokens: number(value('maxTokens')), metadata: row.source.metadata ? { ...row.source.metadata, manualFields: [...(row.manualFields || [])] } : null, capabilities: row.source.capabilities,
    reasoningConfig: format === 'none' ? null : { format, levels },
    tools: row.querySelector('[name=tools]').checked, vision: row.querySelector('[name=vision]').checked, reasoning: row.querySelector('[name=reasoning]').checked,
    cost: [input, output, read, write].some(text => text !== '') ? { input: number(input), output: number(output), cacheRead: number(read), cacheWrite: number(write) } : null };
}
function providerEditor(provider, onboarding = false) {
  const initial = provider || { name: 'OpenRouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', models: [{}], requiresKey: true, configured: false };
  const form = el('form', { class: 'provider-editor', autocomplete: 'off' }), message = el('p', { class: 'form-message', role: 'status' });
  const makeRow = model => modelRow(model, () => form.metadataConnection());
  const rows = el('div', { class: 'model-rows' }, initial.models.map(makeRow));
  const keyField = field('API key', 'apiKey', '', { type: 'password', autocomplete: 'new-password', placeholder: initial.configured && initial.requiresKey ? 'Saved — leave blank to keep it' : 'Paste your API key', wide: true });
  let clearKey = false;
  form.metadataConnection = () => ({ providerId: clearKey ? undefined : provider?.id, baseUrl: form.querySelector('[name=baseUrl]').value, apiKey: form.querySelector('[name=apiKey]').value, requiresKey: !form.querySelector('[name=keyless]').checked });
  if (!onboarding) form.append(el('div', { class: 'section-heading' }, el('h3', {}, provider?.name || 'Add connection'), provider ? button('Remove', () => info('Remove this API?', el('p', { class: 'help' }, 'The saved key and connection will be removed. Your conversations stay intact. Running requests finish with their original connection.'),
    button('Remove connection', guard(async () => { const result = await api('/providers/' + provider.id, undefined, 'DELETE'); state.providers = result.providers; state.defaultModel = result.defaultModel; state.providerId = null; $('#info-dialog').close(); renderSettings(); renderChrome(); }), 'danger-button')), 'text-button danger') : null));
  const details = el('details', { class: 'connection-details', ...(provider && !provider.baseUrl.includes('openrouter.ai') ? { open: '' } : {}) }, el('summary', {}, 'Connection details'),
    el('div', { class: 'form-grid' }, field('Connection name', 'name', initial.name, { placeholder: 'Give this connection a name', required: '', maxlength: 80 }),
      selectField('API format', 'api', initial.api, [['openai-completions', 'Chat Completions'], ['openai-responses', 'Responses']]),
      field('API base URL', 'baseUrl', initial.baseUrl, { type: 'url', required: '', placeholder: 'https://api.example.com/v1', wide: true })));
  const types = el('div', { class: 'connection-types', role: 'group', 'aria-label': 'Connection type' });
  if (!provider) {
    const router = button('OpenRouter', () => chooseType(true)), custom = button('Custom endpoint', () => chooseType(false));
    function chooseType(isRouter) {
      router.classList.toggle('selected', isRouter); custom.classList.toggle('selected', !isRouter);
      router.setAttribute('aria-pressed', String(isRouter)); custom.setAttribute('aria-pressed', String(!isRouter));
      form.querySelector('[name=name]').value = isRouter ? 'OpenRouter' : '';
      form.querySelector('[name=baseUrl]').value = isRouter ? 'https://openrouter.ai/api/v1' : '';
      form.querySelector('[name=api]').value = 'openai-completions';
      details.open = !isRouter;
      form.querySelector('.key-link').hidden = !isRouter;
      if (!isRouter) form.querySelector('[name=baseUrl]').focus();
    }
    router.classList.add('selected'); router.setAttribute('aria-pressed', 'true'); custom.setAttribute('aria-pressed', 'false'); types.append(router, custom); form.append(types);
  }
  const keyLink = el('a', { class: 'key-link', href: 'https://openrouter.ai/settings/keys', target: '_blank', rel: 'noopener noreferrer' }, 'Get an OpenRouter key', icon('external'));
  const updateKeyLink = () => { try { keyLink.hidden = new URL(form.querySelector('[name=baseUrl]').value).hostname !== 'openrouter.ai'; } catch { keyLink.hidden = true; } };
  form.append(el('div', { class: 'connection-key' }, keyField, keyLink));
  form.append(details); updateKeyLink(); form.querySelector('[name=baseUrl]').addEventListener('input', updateKeyLink);
  form.append(el('div', { class: 'key-controls' }, check('No API key (local / anonymous endpoint)', 'keyless', !initial.requiresKey),
    provider?.configured && provider.requiresKey ? button('Clear saved key', () => { clearKey = true; keyField.querySelector('input').value = ''; keyField.querySelector('input').placeholder = 'Key will be removed when you save'; message.textContent = 'Save to remove this API key.'; }, 'text-button') : null));
  form.append(el('div', { class: 'models-heading' }, el('h4', {}, 'Choose your model'), el('div', {}, button('Browse model IDs', guard(async event => {
    const target = event.currentTarget; target.disabled = true; message.textContent = 'Fetching IDs from your endpoint…';
    try {
      const key = form.querySelector('[name=apiKey]').value, baseUrl = form.querySelector('[name=baseUrl]').value;
      const result = provider && !key && baseUrl === provider.baseUrl ? await api('/providers/' + provider.id + '/discover', {}) : await api('/providers/discover', { baseUrl, apiKey: key });
      message.textContent = '';
      showDiscoveredModels(result.models, model => {
        const empty = [...rows.children].find(row => !row.querySelector('[name=modelId]').value.trim());
        if (empty) empty.replaceWith(makeRow(model)); else rows.append(makeRow(model));
      });
    } catch (error) { message.textContent = error.message; message.classList.add('error'); }
    finally { target.disabled = false; }
  }), 'text-button'), button('+ Add model', () => rows.append(makeRow({})), 'text-button'))), rows);
  for (const name of ['baseUrl', 'apiKey', 'keyless']) form.querySelector('[name=' + name + ']').addEventListener('input', () => { for (const row of rows.children) row.refreshMetadata(); });
  form.append(el('p', { class: 'help' }, 'Paste an exact model ID, or browse IDs from your endpoint. No model is chosen for you. Provider-reported costs are used when available; otherwise unknown prices stay unknown.'));
  const submit = el('button', { class: 'primary-button', type: 'submit' }, onboarding ? 'Add model & continue' : 'Save connection');
  form.append(message, el('div', { class: 'form-actions' }, el('span', { class: 'help' }, 'Keys stay in private local storage.'), submit));
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.textContent = ''; submit.disabled = true;
    try {
      await Promise.all([...rows.children].map(row => row.lookupMetadata()));
      const get = name => form.querySelector(`[name=${name}]`), keyless = get('keyless').checked;
      if (onboarding && !keyless && !get('apiKey').value.trim()) throw new Error('Enter an API key, or select “No API key” for an anonymous endpoint.');
      const result = await api('/providers', { ...(provider ? { id: provider.id } : {}), name: get('name').value, api: get('api').value, baseUrl: get('baseUrl').value,
        apiKey: get('apiKey').value, requiresKey: !keyless, clearKey: clearKey && !get('apiKey').value.trim() || keyless, models: [...rows.children].map(readModelRow) });
      const newProvider = provider ? result.providers.find(row => row.id === provider.id) : result.providers.at(-1);
      state.providers = result.providers; state.defaultModel = result.defaultModel; state.providerId = newProvider.id;
      if (!state.chat && !state.selection) state.selection = state.defaultModel;
      get('apiKey').value = '';
      const missingLimits = newProvider.models.some(model => !model.contextWindow || !model.maxTokens);
      if (onboarding) { $('#setup-dialog').close(); if (missingLimits) openSettings('providers', newProvider.id); else ui.prompt.focus(); } else renderSettings();
      renderChrome(); toast(missingLimits ? 'Connection saved. Enter verified token limits before chatting.' : onboarding ? 'Your model is ready to use.' : 'Connection saved.');
    } catch (error) { message.textContent = error.message; message.classList.add('error'); }
    finally { submit.disabled = false; }
  });
  if (onboarding) form.append(button('Start with Notes — no model required', guard(async () => { $('#setup-dialog').close(); await switchSurface('notes'); }), 'setup-local text-button'), button('Use local model files instead', () => { $('#setup-dialog').close(); openSettings('local'); }, 'setup-local text-button'));
  return form;
}
function showDiscoveredModels(models, add) {
  const query = el('input', { placeholder: 'Filter model IDs…', type: 'search', 'aria-label': 'Filter discovered models' }), list = el('div', { class: 'model-options' });
  const render = () => {
    const matches = models.filter(model => (model.id + ' ' + model.name).toLowerCase().includes(query.value.toLowerCase()));
    list.replaceChildren(...matches.slice(0, 150).map(model => el('button', { class: 'model-option', onClick: () => { add(model); $('#info-dialog').close(); } }, el('span', {}, el('strong', {}, model.name), el('small', {}, model.id)), icon('plus'))));
    if (matches.length > 150) list.append(el('p', { class: 'help' }, 'Showing 150 results. Type to narrow the list.'));
  };
  query.addEventListener('input', render); render(); info('Add a model', el('label', { class: 'field' }, 'Select an ID to add; save your connection afterward.', query), list); query.focus();
}
function renderPreferences() {
  const form = el('form', { class: 'settings-single' });
  const theme = selectField('Appearance', 'theme', state.settings.theme, [['system', 'Match your device'], ['light', 'Light'], ['dark', 'Dark']]);
  theme.querySelector('select').addEventListener('change', event => applyTheme(event.target.value));
  const editor = markdownEditor(state.settings.instructions || '', 'General instructions', 30000);
  editor.input.name = 'instructions'; const instructions = editor.element;
  const limit = field('Maximum model requests per message', 'maxTurns', state.settings.maxTurns || 16, { type: 'number', min: 1, max: 64, required: '' });
  const submit = el('button', { type: 'submit', class: 'primary-button' }, 'Save preferences');
  form.append(button('Web browsing settings', guard(webSearchSettings)), el('h3', {}, 'Preferences'), el('p', { class: 'help' }, 'One assistant, with tools available when useful. Reading workspace files is automatic; file changes and shell commands always ask for approval.'), theme, instructions,
    el('p', { class: 'help' }, 'Used with your next message in any conversation. Per-chat instructions can be set from its options menu. Reasoning controls are available per model in the model picker.'), limit,
    el('p', { class: 'help' }, 'Tool follow-ups make additional API requests. This limit prevents a single message from running indefinitely; all completed requests count toward its conversation cost.'), submit,
    el('hr'), el('p', { class: 'help' }, 'Keys are stored locally, not in an OS credential vault. Requests go to the endpoint you configure. Keep your private data directory secure.'));
  form.addEventListener('submit', guard(async event => { event.preventDefault(); submit.disabled = true; try { state.settings = await api('/settings', { theme: theme.querySelector('select').value, instructions: instructions.querySelector('textarea').value, maxTurns: Number(limit.querySelector('input').value) }, 'PATCH'); applyTheme(state.settings.theme); toast('Preferences saved.'); } finally { submit.disabled = false; } }));
  $('#settings-content').append(form);
}
let localTimer, modelUpload;
function localDropzone() {
  const files = el('input', { type: 'file', multiple: '', accept: '.safetensors,.json,.model,.txt,.tiktoken,.jinja,.jinja2,.md,.yaml,.yml,.py', hidden: true });
  const folder = el('input', { type: 'file', webkitdirectory: '', multiple: '', hidden: true });
  const status = el('p', { id: 'model-upload-status', class: 'help', role: 'status' }, modelUpload ? 'Import in progress. Keep this window open.' : 'A complete Transformers / safetensors model folder. Up to 64 GB. Nothing is downloaded. GGUF and MLX are not supported.');
  const zone = el('div', { class: 'model-dropzone', 'aria-label': 'Drop local model files' }, icon('upload'), el('h4', {}, 'Drop your model. Keep it local.'), status,
    el('div', { class: 'dropzone-actions' }, button('Choose files', () => files.click()), button('Choose folder', () => folder.click()), button('Cancel upload', () => modelUpload?.abort(), 'cancel-upload text-button')), files, folder);
  const selected = guard(async event => { try { await uploadModel([...event.target.files].map(file => ({ file, path: file.webkitRelativePath || file.name }))); } finally { event.target.value = ''; } });
  files.addEventListener('change', selected); folder.addEventListener('change', selected);
  zone.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', guard(async event => {
    event.preventDefault(); event.stopPropagation(); zone.classList.remove('drag-over');
    const items = [...event.dataTransfer.items], entries = items.map(item => item.webkitGetAsEntry?.()), fallback = [...event.dataTransfer.files];
    const incoming = [];
    async function walk(entry, prefix = '') {
      if (incoming.length > 2048) throw new Error('Choose at most 2,048 model files.');
      if (entry.isFile) { const file = await new Promise((accept, reject) => entry.file(accept, reject)); incoming.push({ file, path: prefix + file.name }); }
      else if (entry.isDirectory) {
        const reader = entry.createReader(); let batch;
        do { batch = await new Promise((accept, reject) => reader.readEntries(accept, reject)); for (const child of batch) await walk(child, prefix + entry.name + '/'); } while (batch.length);
      }
    }
    if (entries.some(Boolean)) { for (const entry of entries.filter(Boolean)) await walk(entry); }
    else incoming.push(...fallback.map(file => ({ file, path: file.name })));
    await uploadModel(incoming);
  }));
  zone.classList.toggle('uploading', !!modelUpload); return zone;
}
async function uploadModel(incoming) {
  if (modelUpload) throw new Error('A model import is already in progress.');
  if (!incoming.length) return;
  if (incoming.length > 2048 || incoming.reduce((sum, row) => sum + row.file.size, 0) > 64 * 1024 ** 3) throw new Error('Import at most 2,048 files and 64 GB at a time.');
  if (incoming.some(row => /\.gguf$/i.test(row.path))) throw new Error('GGUF models are no longer supported. Choose a complete Transformers/safetensors model folder.');
  const data = new FormData(); for (const row of incoming) data.append('files', row.file, row.path);
  const xhr = new XMLHttpRequest(); modelUpload = xhr;
  const update = text => { const status = $('#model-upload-status'); if (status) status.textContent = text; document.querySelectorAll('.model-dropzone').forEach(zone => zone.classList.toggle('uploading', !!modelUpload)); };
  update('Starting local file import…');
  xhr.upload.onprogress = event => update(event.lengthComputable ? `Importing · ${Math.min(100, Math.round(event.loaded / event.total * 100))}% · ${(event.loaded / 1024 ** 3).toFixed(2)} GB transferred` : 'Importing files…');
  try {
    const result = await new Promise((accept, reject) => {
      xhr.open('POST', '/api/local/upload');
      xhr.onload = () => { let value; try { value = JSON.parse(xhr.responseText); } catch { reject(new Error('Model import failed. Check the local server.')); return; } if (xhr.status >= 200 && xhr.status < 300) accept(value); else reject(new Error(value.error || 'Model import failed.')); };
      xhr.onerror = () => reject(new Error('Model import connection failed. No partial model was added.'));
      xhr.onabort = () => reject(new Error('Model import cancelled.'));
      xhr.send(data);
    });
    update(`Saved ${result.files} file(s) as ${result.id}.`); toast('Model files imported. Load the model from your library.');
  } finally { modelUpload = null; document.querySelectorAll('.model-dropzone').forEach(zone => zone.classList.remove('uploading')); if (state.tab === 'local' && $('#settings-dialog').open) renderSettings(); }
}
async function renderLocal() {
  clearTimeout(localTimer);
  const section = el('section', { class: 'settings-single' }, el('h3', {}, 'Your models. Your device.'), el('p', { class: 'help' }, 'Local inference is optional. No Python process starts until you open this library. Local models currently respond without workspace tools.'));
  section.append(localDropzone());
  $('#settings-content').append(section); const loading = el('p', { class: 'help' }, 'Checking local library…'); section.append(loading);
  let data;
  try { data = await api('/local/status?refresh=1'); } catch (error) { loading.textContent = error.message; section.append(el('p', { class: 'help' }, 'You can also connect a local inference server using a compatible API endpoint.')); return; }
  if (state.tab !== 'local' || !section.isConnected) return;
  state.local = data; loading.remove(); renderChrome();
  section.append(el('div', { class: 'local-state' }, data.phase === 'ready' || data.phase === 'generating' ? 'Loaded: ' + (data.displayName || data.model) : data.phase === 'loading' ? 'Loading ' + (data.displayName || data.model) + '…' : 'No model loaded.',
    data.error ? el('p', { class: 'message-error' }, data.error) : null), el('p', { class: 'help' }, 'Place complete Transformers/safetensors model folders in:'), el('p', { class: 'local-path' }, data.root || state.modelDirectory),
    button('Refresh library', guard(async () => { await api('/local/status?refresh=1'); renderSettings(); })));
  const device = selectField('Device', 'device', 'auto', [['auto', 'Automatic'], ['cpu', 'CPU'], ['cuda', 'NVIDIA CUDA'], ['mps', 'Apple GPU']]); section.append(device);
  const trust = check('Trust model repository Python code (trust_remote_code=True)', 'trustRemoteCode', data.trustRemoteCode !== false);
  section.append(trust, el('p', { class: 'help' }, 'Enabled for loading custom architectures and tokenizers. Repository Python can run with your account’s permissions; it is not sandboxed. Only load code you trust. Built-in model loading stays offline; missing code or weights are never downloaded automatically. Importing or refreshing the library does not execute model code.'));
  if (data.model && ['ready', 'generating'].includes(data.phase)) section.append(el('p', { class: 'help' }, (data.promptFormat === 'plain-text' ? 'No chat template: using a generic System / User / Assistant text prompt. Base models may continue text rather than follow chat instructions. ' : '') + 'Effective context: ' + (data.contextWindow || 'unknown') + ' tokens; response cap: ' + (data.maxTokens || 'unknown') + '. To fit small contexts, older prompt tokens may be omitted; the newest prompt tail is retained. This can omit instructions or memory.'));
  if (data.lastGeneration?.omittedPromptTokens) section.append(el('p', { class: 'help' }, 'Last local request omitted ' + data.lastGeneration.omittedPromptTokens + ' prompt tokens to fit this model’s context.'));
  for (const model of data.models || []) {
    const rename = button('Rename', () => {
      const input = el('input', { value: model.name, required: '', maxlength: 150, 'aria-label': 'Local model display name' });
      info('Name this local model', el('p', { class: 'help' }, 'Changes its display name only. The model folder, files and internal ID stay unchanged.'), el('form', { onSubmit: guard(async event => { event.preventDefault(); state.local = await api('/local/name', { id: model.id, name: input.value }); $('#info-dialog').close(); renderSettings(); renderChrome(); }) }, el('label', { class: 'field' }, 'Display name', input), el('button', { type: 'submit', class: 'primary-button' }, 'Save name'))); input.focus(); input.select();
    }, 'text-button');
    const action = data.model === model.id && ['ready', 'generating'].includes(data.phase) ? button('Unload', guard(async () => { await api('/local/unload', {}); state.local = null; renderSettings(); renderChrome(); }))
      : button('Load model', guard(async () => { const trusted = trust.querySelector('input').checked; if (trusted && model.customCode && !confirm('This model can execute repository Python code with your account’s full permissions. Load it only if you trust its source. Continue?')) return; await api('/local/load', { id: model.id, device: device.querySelector('select').value, trust: trusted }); renderSettings(); }), 'primary-button');
    action.disabled = !!model.problem || !model.available || ['loading', 'generating'].includes(data.phase);
    section.append(el('div', { class: 'local-model-row' }, el('div', {}, el('strong', {}, model.name), el('small', {}, model.id + ' · ' + model.format?.toUpperCase() + ' · ' + (model.bytes / 1073741824).toFixed(1) + ' GB'),
      model.problem || !model.available ? el('p', { class: 'help' }, model.problem || model.runtimeHint) : null), el('div', { class: 'local-model-actions' }, rename, action)));
  }
  if (!data.models?.length) section.append(el('p', { class: 'help' }, 'No compatible weights found yet. Each complete Transformers/safetensors model belongs in its own folder. GGUF and MLX models are not supported. Model weights are never downloaded automatically.'));
  if (data.model && data.phase === 'ready') section.append(button('Use this model', guard(async () => {
    if (state.chat?.running) throw new Error('Stop your response before switching models.');
    const selection = { provider: 'local', model: 'local-model' };
    if (state.chat) state.chat = await api('/chats/' + state.chat.id, { selection }, 'PATCH');
    await api('/default-model', { selection }); state.defaultModel = selection; state.selection = selection; $('#settings-dialog').close(); renderChrome();
  }), 'primary-button'));
  const setup = state.localSetup;
  const commands = setup ? `python "${setup.script}" --venv "${setup.environment}"` : 'Use a compatible local API endpoint, or install a runtime with Python 3.12.';
  section.append(el('hr'), el('p', { class: 'help' }, 'Missing a runtime? Run the appropriate command with Python 3.12. Packages are installed in your private runtime directory, not the app installation. Setup does not download model weights or model-specific extra Python packages. Restart afterward. Custom-code trust is chosen explicitly when loading.'),
    el('pre', { class: 'local-path' }, commands));
  if (data.phase === 'loading' && $('#settings-dialog').open) localTimer = setTimeout(() => { if (state.tab === 'local' && $('#settings-dialog').open) renderSettings(); }, 1500);
}
function connectEvents() {
  eventSource = new EventSource('/api/events');
  eventSource.onopen = guard(async () => { $('#connection-state').hidden = true; await refreshBootstrap(); await refreshList(); await refreshCurrent(); });
  eventSource.onerror = () => { $('#connection-state').hidden = false; };
  eventSource.onmessage = guard(async event => {
    const message = JSON.parse(event.data);
    if (message.type === 'resources') { guard(() => knowledge.resourceEvent(message.data))(); guard(() => canvas.refresh(message.data))(); return; }
    if (message.type === 'canvas') { await refreshCurrent(); return; }
    if (message.type === 'connections') { await refreshBootstrap(); modelPicker?.refresh(); return; }
    if (message.type === 'memory') { if (state.tab === 'memory' && $('#settings-dialog').open) toast('Shared memory changed. Reload it before editing further.'); return; }
    if (message.type === 'deleted') { if (state.chat?.id === message.chatId) newChat(); localStorage.removeItem('basically:draft:' + message.chatId); scheduleList(); return; }
    if (!['delta', 'thinking'].includes(message.type)) scheduleList();
    if (message.chatId !== state.chat?.id) return;
    if (message.type === 'delta' || message.type === 'thinking') {
      const applied = applyStreamDelta(state.chat, message.type, message.data);
      if (applied === 'resync') { await refreshCurrent(); return; } if (!applied) return;
      state.chat.running = true; state.chat.phase = message.type === 'thinking' ? 'thinking' : 'responding';
      if (!streamFrame) streamFrame = setTimeout(() => { streamFrame = null; const near = isNearBottom(); renderStreaming(); if (near) scrollBottom(true); }, 60);
    } else await refreshCurrent();
  });
}
function mountSurface(surface) {
  state.surface = surface; const notes = surface === 'notes'; knowledge.visible = notes;
  $('#app').classList.toggle('notes-active', notes); $('#knowledge-sidebar').hidden = !notes; $('#knowledge-main').hidden = !notes;
  $('#nav-chat').classList.toggle('active', !notes); $('#nav-notes').classList.toggle('active', notes);
  if (notes) knowledge.aiHost.append($('#main-chat-pane')); else $('#app').append($('#main-chat-pane'));
  knowledge.renderContext();
}
async function switchSurface(surface) {
  if (state.sending) return toast('Wait for your message to be submitted.');
  if (state.surface === surface && knowledge.visible === (surface === 'notes')) return;
  saveDraft(); state.slots[state.surface] = state.chat?.id || null; localStorage.setItem('basically:chat-slots', JSON.stringify(state.slots));
  mountSurface(surface); const notes = surface === 'notes', id = state.slots[surface];
  if (id) { try { await openChat(id, false, surface); } catch { if (state.surface === surface) newChat(false, false); } } else newChat(false, false);
  if (state.surface !== surface) return;
  history.replaceState(null, '', notes ? '#surface=notes' + (state.chat ? '&chat=' + state.chat.id : '') : state.chat ? '#chat=' + state.chat.id : location.pathname);
  if (notes) { await knowledge.refreshTree(); await knowledge.refreshConnections(); }
  renderChrome(); renderHistory(); closeMobileSidebar();
}
async function showNotesConversations() {
  await refreshList();
  info('Notes AI conversations', button('New Notes AI conversation', () => { $('#info-dialog').close(); newChat(); knowledge.setContext('ai'); }),
    ...state.chats.filter(chat => chat.surface === 'notes').map(chat => button(chat.title, guard(async () => { $('#info-dialog').close(); await openChat(chat.id); knowledge.setContext('ai'); }))));
}
async function showScope() {
  const folders = (await api('/workspaces')).workspaces, selected = new Set(state.chat?.workspaceIds || state.workspaceIds);
  const checks = folders.map(row => el('label', { class: 'check-field' }, el('input', { type: 'checkbox', value: row.id, checked: selected.has(row.id) }), row.name));
  info('Conversation workspaces', el('p', { class: 'help' }, 'Choose the attached folders this conversation may read and edit. Notes and main chat use the same grants and file history. No folder selected means only the private conversation upload workspace.'), ...checks,
    button('Attach another folder', () => knowledge.attachDialog(async row => {
      const workspaceIds = [...new Set([...(state.chat?.workspaceIds || state.workspaceIds), row.id])];
      if (state.chat) state.chat = await api('/chats/' + state.chat.id, { workspaceIds }, 'PATCH'); state.workspaceIds = workspaceIds;
      toast('Folder attached and added to this conversation.'); await showScope();
    })), button('Use selected folders', guard(async () => {
      const workspaceIds = checks.filter(node => node.querySelector('input').checked).map(node => node.querySelector('input').value);
      if (state.chat) state.chat = await api('/chats/' + state.chat.id, { workspaceIds }, 'PATCH'); state.workspaceIds = workspaceIds; $('#info-dialog').close(); toast('Conversation access updated.');
    }), 'primary-button'));
}
$('#nav-chat').addEventListener('click', guard(() => switchSurface('chat'))); $('#nav-notes').addEventListener('click', guard(() => switchSurface('notes')));
$('#scope-button').addEventListener('click', guard(showScope));
document.querySelectorAll('[data-close]').forEach(node => node.addEventListener('click', () => node.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } }));
$('#settings-dialog').addEventListener('close', () => { clearTimeout(localTimer); applyTheme(state.settings.theme || 'system'); });
$('#settings-tabs').addEventListener('click', event => { const tab = event.target.closest('[data-tab]'); if (tab) { state.tab = tab.dataset.tab; renderSettings(); } });
$('#model-button').addEventListener('click', openModelPicker);
$('#open-settings').addEventListener('click', () => { closeMobileSidebar(); openSettings(); }); $('#welcome-connect').addEventListener('click', openSetup); $('#header-add-model').addEventListener('click', openSetup);
$('#open-local').addEventListener('click', () => { closeMobileSidebar(); openSettings('local'); });
$('#new-chat').addEventListener('click', () => newChat()); $('#home').addEventListener('click', () => newChat());
$('#toggle-sidebar').addEventListener('click', () => toggleSidebar()); $('#close-sidebar').addEventListener('click', () => toggleSidebar(false)); $('#sidebar-shade').addEventListener('click', () => toggleSidebar(false));
$('#chat-search').addEventListener('input', () => { clearTimeout(searchTimer); searchSequence++; $('#clear-search').hidden = !$('#chat-search').value; $('#search-shortcut').hidden = !!$('#chat-search').value; searchTimer = setTimeout(guard(refreshList), 160); });
$('#chat-search').addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); $('#chat-list .history-item')?.focus(); } if (event.key === 'Enter' && state.chats[0]) { event.preventDefault(); guard(() => openChat(state.chats[0].id))(); } if (event.key === 'Escape') { $('#chat-search').value = ''; guard(refreshList)(); ui.prompt.focus(); } });
$('#clear-search').addEventListener('click', () => { $('#chat-search').value = ''; guard(refreshList)(); $('#chat-search').focus(); });
$('#import-chats').addEventListener('click', () => $('#import-input').click());
$('#import-input').addEventListener('change', guard(async event => { const file = event.target.files[0]; event.target.value = ''; await importBackup(file); }));
$('#cost-button').addEventListener('click', showCost);
$('#conversation-menu').addEventListener('click', guard(() => showConversationMenu())); $('#workspace-button').addEventListener('click', guard(() => showFiles()));
$('#composer').addEventListener('submit', guard(send)); ui.prompt.addEventListener('input', () => { saveDraft(); updatePreview(); });
ui.prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.chat?.running) $('#composer').requestSubmit(); } });
$('#suggestions').addEventListener('click', event => { const node = event.target.closest('[data-prompt]'); if (node) { ui.prompt.value = node.dataset.prompt; saveDraft(); ui.prompt.focus(); } });
$('#attach-button').addEventListener('click', () => $('#file-input').click()); $('#file-input').addEventListener('change', guard(async event => { try { await addFiles([...event.target.files]); } finally { event.target.value = ''; } }));
ui.prompt.addEventListener('paste', guard(async event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); await addFiles(files); } }));
$('#composer').addEventListener('dragover', event => event.preventDefault()); $('#composer').addEventListener('drop', guard(async event => { event.preventDefault(); await addFiles([...event.dataTransfer.files]); }));
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || document.querySelector('dialog[open]') || !knowledge) return;
  if (state.surface === 'notes' && ['p', 'o'].includes(event.key.toLowerCase()) && !event.shiftKey) { event.preventDefault(); knowledge.palette(); return; }
  if (state.surface === 'notes' && event.key.toLowerCase() === 'n') { event.preventDefault(); guard(() => knowledge.newFile())(); return; }
  if (state.surface === 'notes' && event.key.toLowerCase() === 's') { event.preventDefault(); guard(() => knowledge.flushAll())(); return; }
  if (event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); knowledge.palette(); return; }
  if (state.surface === 'notes' && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); toggleSidebar(true); knowledge.search.focus(); return; }
  if (state.surface === 'notes' && event.key.toLowerCase() === 'e') { event.preventDefault(); const pane = knowledge.layout.panes.find(pane => pane.id === knowledge.activePane), tab = pane?.tabs.find(tab => tab.id === pane.active); if (tab) { tab.mode = tab.mode === 'source' ? 'rich' : 'source'; knowledge.renderPanes(); knowledge.persist(); } return; }
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) newChat(); }
  if (event.key === '/' && !document.querySelector('dialog[open]')) { event.preventDefault(); toggleSidebar(true); const search = state.surface === 'notes' ? knowledge.search : $('#chat-search'); search.focus(); search.select(); }
  if (event.target === ui.prompt && ['b', 'i'].includes(event.key.toLowerCase())) {
    event.preventDefault(); const marker = event.key.toLowerCase() === 'b' ? '**' : '*', start = ui.prompt.selectionStart, end = ui.prompt.selectionEnd;
    ui.prompt.setRangeText(marker + ui.prompt.value.slice(start, end) + marker, start, end, 'select'); ui.prompt.setSelectionRange(start + marker.length, end + marker.length); saveDraft();
  }
});
window.addEventListener('popstate', guard(async () => { const params = new URLSearchParams(location.hash.slice(1)), id = params.get('chat'); await switchSurface(params.get('surface') === 'notes' ? 'notes' : 'chat'); if (id) await openChat(id, false); else newChat(false); }));
window.addEventListener('pagehide', () => { try { saveDraft(); } catch {} try { canvas?.captureEdits(); canvas?.savePresentation(); } catch {} if (knowledge) for (const doc of knowledge.docs.values()) { try { knowledge.captureEditor(doc); } catch {} } eventSource?.close(); });
async function boot() {
  if (localStorage.getItem('basically:sidebar') === 'closed' && !matchMedia('(max-width: 760px)').matches) $('#app').classList.add('sidebar-closed');
  await refreshBootstrap(); state.selection = state.defaultModel;
  initializeComposerEditor();
  canvas = createCanvas({ el, icon, iconButton, button, api, guard, toast, markdown, onOpenNotes: guard(async ref => { await switchSurface('notes'); await knowledge.open(ref); }), onClose: guard(async () => { if (state.chat?.canvas) { state.chat = await api('/chats/' + state.chat.id, { canvas: null }, 'PATCH'); } }), onChoose: guard(async canvasId => { state.chat = await api('/chats/' + state.chat.id, { canvas: { canvasId } }, 'PATCH'); await refreshCurrent(); }) });
  canvas.mount($('#canvas-slot'));
  canvas.onSaved = () => guard(() => knowledge.resourceEvent({ action: 'saved' }))();
  knowledge = createKnowledge({ el, button, icon, iconButton, api, guard, toast, info, highlight: highlighted, closeInfo: () => $('#info-dialog').close(), toggleSidebar: () => toggleSidebar(), activateNotes: () => switchSurface('notes'), onScopeChanged: () => { if (state.surface === 'notes' && !state.chat) state.workspaceIds = knowledge.workspaces.map(row => row.id); }, askAboutCurrent: text => { ui.prompt.value = 'Help me with ' + text; saveDraft(); ui.prompt.focus(); }, sendToChat: guard(async text => { await switchSurface('chat'); newChat(); state.workspaceIds = knowledge.workspaces.map(row => row.id); ui.prompt.value = text; saveDraft(); ui.prompt.focus(); }), onDocumentChanged: () => canvas.state && guard(() => canvas.refresh({}))(), onConversations: showNotesConversations, newConversation: () => newChat() });
  await knowledge.initialize();
  configureMarkdown({ onNavigate: guard((target, base, options) => knowledge.navigate(target, base, options)), context: () => state.surface === 'notes' ? knowledge.activeContext().activeResource || state.chat?.activeResource : state.chat?.activeResource });
  await refreshList();
  try { state.slots = JSON.parse(localStorage.getItem('basically:chat-slots') || '{}'); } catch {}
  const params = new URLSearchParams(location.hash.slice(1)), id = params.get('chat');
  if (params.get('surface') === 'notes') await switchSurface('notes');
  if (id) { try { await openChat(id, false); } catch (error) { toast(error.message); newChat(false); } } else { restoreDraft(); renderMessages(); }
  connectEvents();
  if (state.surface === 'chat' && !state.providers.some(provider => provider.models.length) && !state.local?.model) openSetup();
}
boot().catch(error => { $('#chat-notice').textContent = error.message; $('#chat-notice').hidden = false; toast('Could not open the app. Use the authenticated link from npm start.'); }).finally(() => { $('#app').inert = false; $('#app').setAttribute('aria-busy', 'false'); document.documentElement.classList.remove('initializing'); });
