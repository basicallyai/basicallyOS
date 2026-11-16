/** Versioned, lossless conversation backups, including workspaces. Never imports credentials or executes tools. */
import { readdir, readFile, mkdir, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 40 * 1024 * 1024, MAX_FILES = 4000, MAX_CHATS = 500;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => Number.isFinite(value) && value >= 0;
export function portablePath(value) {
  if (typeof value !== 'string' || value.length > 1000 || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..' || /^ |[. ]$|[<>:"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('Use safe relative file paths, without links or traversal.');
  return value;
}
function validateMessage(message) {
  if (!object(message) || !['system', 'user', 'assistant', 'toolResult'].includes(message.role) || !number(message.timestamp)) throw new Error('Invalid transcript message.');
  if (typeof message.content === 'string' && ['user', 'system'].includes(message.role)) return;
  if (!Array.isArray(message.content)) throw new Error('Invalid message content.');
  for (const block of message.content) {
    if (!object(block)) throw new Error('Invalid message block.');
    if (block.type === 'text' && typeof block.text === 'string') continue;
    if (block.type === 'thinking' && message.role === 'assistant' && typeof block.thinking === 'string') continue;
    if (block.type === 'image' && typeof block.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data) && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType)) continue;
    if (block.type === 'toolCall' && message.role === 'assistant' && typeof block.id === 'string' && typeof block.name === 'string' && object(block.arguments)) continue;
    throw new Error('Unsupported or malformed message block.');
  }
  if (message.role === 'toolResult' && (typeof message.toolCallId !== 'string' || typeof message.toolName !== 'string')) throw new Error('Invalid tool result.');
  if (message.role === 'assistant') {
    if (message.displayName !== undefined && (typeof message.displayName !== 'string' || message.displayName.length > 256)) throw new Error('Invalid model display name.');
    const localContext = message.localContext;
    if (localContext != null && (!object(localContext) || !Number.isSafeInteger(localContext.omittedPromptTokens) || localContext.omittedPromptTokens < 0 || localContext.omittedPromptTokens > 1e9 || !Number.isSafeInteger(localContext.contextWindow) || localContext.contextWindow < 2 || localContext.contextWindow > 10000000 || !['model-template', 'plain-text'].includes(localContext.promptFormat))) throw new Error('Invalid local context diagnostic.');
    const speed = message.performance;
    if (speed != null && (!object(speed) || speed.basis !== 'request-to-completion' || !Number.isSafeInteger(speed.outputTokens) || speed.outputTokens < 1 || speed.outputTokens > 1e9 || !number(speed.elapsedMs) || speed.elapsedMs <= 0 || speed.elapsedMs > 86400000 || !number(speed.tokensPerSecond) || speed.tokensPerSecond <= 0 || speed.tokensPerSecond > 1e12)) throw new Error('Invalid response speed measurement.');
    if (typeof message.model !== 'string' || typeof message.provider !== 'string' || typeof message.api !== 'string' || !['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason)) throw new Error('Invalid assistant metadata.');
  }
}
function validateChat(chat) {
  if (!object(chat) || typeof chat.title !== 'string' || !chat.title.trim() || chat.title.length > 160 || !number(chat.createdAt) || !number(chat.updatedAt)) throw new Error('Invalid conversation metadata.');
  if (!Array.isArray(chat.messages) || !Array.isArray(chat.inputs) || !Array.isArray(chat.ledger) || [chat.messages, chat.inputs, chat.ledger].some(rows => rows.length > 100000)) throw new Error('Invalid conversation transcript.');
  chat.messages.forEach(validateMessage);
  if (chat.instructions !== undefined && (typeof chat.instructions !== 'string' || chat.instructions.length > 10000)) throw new Error('Invalid conversation instructions.');
  if (chat.selection != null && (!object(chat.selection) || typeof chat.selection.provider !== 'string' || typeof chat.selection.model !== 'string')) throw new Error('Invalid model selection.');
  if (chat.memoryDisabled !== undefined && typeof chat.memoryDisabled !== 'boolean') throw new Error('Invalid memory preference.');
  if (chat.surface !== undefined && !['chat', 'notes'].includes(chat.surface)) throw new Error('Invalid conversation surface.');
  for (const ids of [chat.workspaceIds, chat.historicalWorkspaceIds]) if (ids !== undefined && (!Array.isArray(ids) || ids.length > 33 || ids.some(id => typeof id !== 'string' || id.length > 100))) throw new Error('Invalid historical workspace bindings.');
  for (const ref of [chat.activeResource, chat.historicalActiveResource]) if (ref != null && (!object(ref) || typeof ref.workspaceId !== 'string' || ref.workspaceId.length > 100 || !portablePath(ref.path))) throw new Error('Invalid historical resource.');
  if (chat.canvases !== undefined) {
    if (!Array.isArray(chat.canvases) || chat.canvases.length > 10000) throw new Error('Invalid Canvas collection.');
    const ids = new Set();
    for (const row of chat.canvases) { if (!object(row) || typeof row.canvasId !== 'string' || ids.has(row.canvasId) || typeof row.title !== 'string' || row.title.length > 160 || row.content !== undefined && (typeof row.content !== 'string' || Buffer.byteLength(row.content) > 2 * 1024 ** 2) || row.noteId !== undefined && typeof row.noteId !== 'string') throw new Error('Invalid Canvas document.'); ids.add(row.canvasId); }
  }
  for (const row of chat.inputs) {
    if (!object(row) || !number(row.timestamp) || typeof row.text !== 'string' || !Array.isArray(row.files)) throw new Error('Invalid attachment metadata.');
    if (row.workspaceIds !== undefined && (!Array.isArray(row.workspaceIds) || row.workspaceIds.length > 33 || row.workspaceIds.some(id => typeof id !== 'string' || id.length > 100))) throw new Error('Invalid input workspace scope.');
    for (const file of row.files) if (!object(file) || typeof file.name !== 'string' || !number(file.bytes) || !portablePath(file.path)) throw new Error('Invalid attachment path.');
  }
  for (const row of chat.ledger) {
    if (!object(row) || !['reported', 'estimated', 'unpriced', 'local'].includes(row.kind)
      || (['reported', 'estimated'].includes(row.kind) ? !number(row.usd) || row.usd > 1e9 : row.usd !== null)
      || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > 1e9)) throw new Error('Invalid usage ledger.');
  }
  if (chat.revisions !== undefined) {
    if (!Array.isArray(chat.revisions)) throw new Error('Invalid revisions.');
    for (const revision of chat.revisions) {
      if (!object(revision) || !number(revision.time) || !Array.isArray(revision.messages)) throw new Error('Invalid revision.');
      revision.messages.forEach(validateMessage);
    }
  }
  if (chat.inFlight && (!object(chat.inFlight) || !number(chat.inFlight.time) || typeof chat.inFlight.provider !== 'string' || typeof chat.inFlight.model !== 'string')) throw new Error('Invalid interrupted usage.');
}
export async function exportChats(runtime, id) {
  const chats = id ? [await runtime.get(id)] : await runtime.store.list(true);
  if (chats.some(chat => runtime.active.has(chat.id) || runtime.reserved.has(chat.id))) throw new Error('Stop running responses before exporting a complete backup.');
  for (const chat of chats) runtime.reserved.add(chat.id);
  try { return await buildBackup(runtime, chats); }
  finally { for (const chat of chats) runtime.reserved.delete(chat.id); }
}
async function buildBackup(runtime, chats) {
  if (chats.length > MAX_CHATS) throw new Error('Export at most 500 conversations at a time. Export individual conversations instead.');
  let bytes = 0, count = 0;
  const entries = [];
  for (const chat of chats) {
    const files = [], directories = [], paths = new Set(), root = resolve(runtime.workspaceRoot, chat.id);
    async function walk(directory, prefix = '') {
      let rows;
      try { rows = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT' && !prefix) return; throw error; }
      for (const row of rows) {
        const path = portablePath(prefix + row.name), target = join(directory, row.name), info = await lstat(target);
        if (paths.has(path.toLowerCase())) throw new Error('Workspace paths differ only by case and cannot be portably restored. Rename one before exporting.');
        paths.add(path.toLowerCase());
        if (info.isSymbolicLink()) throw new Error('Backup contains a link. Remove workspace links before exporting.');
        if (++count > MAX_FILES) throw new Error('Backup is limited to 4,000 workspace entries.');
        if (info.isDirectory()) { directories.push(path); await walk(target, path + '/'); }
        else if (info.isFile()) {
          bytes += info.size; if (bytes > MAX_BYTES) throw new Error('Backup exceeds 40 MB. Move large workspace files out before exporting. No files were omitted.');
          files.push({ path, data: (await readFile(target)).toString('base64') });
        } else throw new Error('Only regular files and directories can be backed up.');
      }
    }
    try { if ((await lstat(root)).isSymbolicLink()) throw new Error('Workspace links cannot be exported.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await walk(root); entries.push({ chat: structuredClone(chat), files, directories });
  }
  const backup = { format: 'basically-os/conversations', version: 1, exportedAt: Date.now(), entries };
  if (Buffer.byteLength(JSON.stringify(backup)) > 90 * 1024 * 1024) throw new Error('Backup exceeds 90 MB. Export conversations individually.');
  return backup;
}
export async function importChats(runtime, backup) {
  if (runtime.exchangeBusy) throw new Error('Another import is in progress.');
  runtime.exchangeBusy = true;
  const created = [];
  try {
    if (!object(backup) || backup.format !== 'basically-os/conversations' || backup.version !== 1 || !Array.isArray(backup.entries) || !backup.entries.length || backup.entries.length > MAX_CHATS) throw new Error('Choose a basically OS version-1 conversation backup (.json).');
    let bytes = 0, count = 0;
    const entries = backup.entries.map(entry => {
      if (!object(entry) || !Array.isArray(entry.files) || !Array.isArray(entry.directories)) throw new Error('Invalid workspace backup.');
      validateChat(entry.chat);
      const paths = new Set();
      for (const path of [...entry.directories, ...entry.files.map(file => file?.path)]) {
        portablePath(path); const key = path.toLowerCase();
        if (paths.has(key) || ++count > MAX_FILES) throw new Error('Duplicate workspace paths or too many files.'); paths.add(key);
      }
      const filePaths = new Set(entry.files.map(file => file.path.toLowerCase()));
      for (const path of paths) {
        const parts = path.split('/'); parts.pop();
        while (parts.length) { if (filePaths.has(parts.join('/'))) throw new Error('A workspace file conflicts with a directory.'); parts.pop(); }
      }
      const files = entry.files.map(file => {
        if (typeof file.data !== 'string' || file.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('Invalid base64 file contents.');
        if (bytes + Math.floor(file.data.length * 3 / 4) - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0) > MAX_BYTES) throw new Error('Workspace files exceed the 40 MB import limit.');
        const data = Buffer.from(file.data, 'base64');
        if (data.toString('base64') !== file.data) throw new Error('Invalid base64 file contents.');
        bytes += data.length;
        return { path: file.path, data };
      });
      // Copy only conversation fields. IDs are always new; no settings/credentials are accepted.
      const source = entry.chat;
      const chat = { id: randomUUID(), title: source.title, createdAt: source.createdAt, updatedAt: source.updatedAt, selection: source.selection ?? null,
        messages: source.messages, inputs: source.inputs, ledger: source.ledger, revisions: source.revisions ?? [], pinned: !!source.pinned,
        canvases: (source.canvases || []).map(row => ({ canvasId: randomUUID(), conversationId: null, title: row.title, ...(row.noteId ? { historicalNoteId: row.noteId } : { content: row.content || '' }), createdAt: row.createdAt || source.createdAt, updatedAt: row.updatedAt || source.updatedAt, messageId: row.messageId || null, uiState: {}, generatedMath: Array.isArray(row.generatedMath) ? row.generatedMath.filter(value => typeof value === 'string').slice(0, 500) : [] })), canvas: null,
        instructions: source.instructions || '', archived: !!source.archived, memoryDisabled: !!source.memoryDisabled, surface: source.surface || 'chat', workspaceIds: [], historicalWorkspaceIds: source.workspaceIds?.length ? source.workspaceIds : source.historicalWorkspaceIds || [], historicalActiveResource: source.activeResource || source.historicalActiveResource || null, error: typeof source.error === 'string' ? source.error : null,
        ...(source.inFlight ? { inFlight: source.inFlight } : {}) };
      for (const row of chat.canvases) row.conversationId = chat.id;
      return { chat, files, directories: entry.directories };
    });
    await mkdir(runtime.workspaceRoot, { recursive: true });
    for (const entry of entries) {
      const id = entry.chat.id, stage = resolve(runtime.workspaceRoot, '.import-' + id), target = resolve(runtime.workspaceRoot, id);
      created.push({ id, stage, target }); await mkdir(stage, { mode: 0o700 });
      for (const path of entry.directories) await mkdir(join(stage, path), { recursive: true, mode: 0o700 });
      for (const file of entry.files) { const path = join(stage, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, file.data, { mode: 0o600, flag: 'wx' }); }
      await rename(stage, target); await runtime.store.saveChat(entry.chat);
    }
    runtime.publish(null, 'changed'); return { imported: entries.map(entry => ({ id: entry.chat.id, title: entry.chat.title, archived: entry.chat.archived })) };
  } catch (error) {
    for (const row of created) { await rm(row.stage, { recursive: true, force: true }); await rm(row.target, { recursive: true, force: true }); await runtime.store.deleteChat(row.id); }
    throw error;
  } finally { runtime.exchangeBusy = false; }
}
