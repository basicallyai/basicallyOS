/** Ordered provider deltas and HTTP snapshots may arrive over different connections. */
export function applyStreamDelta(chat, type, data) {
  if (typeof data === 'string') { const field = type === 'thinking' ? 'partialThinking' : 'partial'; chat[field] = (chat[field] || '') + data; return true; }
  if (!data || typeof data.text !== 'string') return false;
  if (data.runId === chat.runId && data.revision <= (chat.streamRevision || 0)) return false;
  if (chat.runId !== data.runId || chat.streamId !== data.streamId) { chat.partial = ''; chat.partialThinking = ''; }
  const field = type === 'thinking' ? 'partialThinking' : 'partial', current = chat[field] || '';
  if (current.length !== data.offset) return 'resync';
  chat[field] = current + data.text; chat.runId = data.runId; chat.streamId = data.streamId; chat.streamRevision = data.revision; return true;
}
export function mergeStreamSnapshot(previous, snapshot) {
  if (previous?.id === snapshot.id && previous.running && snapshot.running && previous.runId === snapshot.runId && previous.streamRevision > snapshot.streamRevision) for (const key of ['partial', 'partialThinking', 'streamId', 'streamRevision', 'phase', 'activeTool']) snapshot[key] = previous[key];
  return snapshot;
}
