import { markdown, codePreview } from '/markdown.js';
export function toolOutput(message, el) {
  const result = el('div', { class: 'tool-output-body' });
  result.append(el('details', { class: 'tool-arguments' }, el('summary', {}, 'Tool arguments'), el('pre', {}, JSON.stringify(message.args, null, 2))));
  if (!message.text) return result;
  let parsed; try { parsed = JSON.parse(message.text); } catch {}
  if (['web_search', 'open_webpage'].includes(message.name) && parsed) {
    for (const source of parsed.sources || (parsed.url ? [{ title: parsed.title || parsed.url, url: parsed.url }] : [])) if (/^https:\/\//.test(source.url)) { result.append(el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', class: 'web-source' }, source.title || source.url)); if (source.excerpt) result.append(el('p', { class: 'help' }, source.excerpt)); }
    if (typeof parsed.content === 'string') result.append(el('pre', { class: 'web-page-text' }, parsed.content));
    return result;
  }
  const content = typeof parsed?.content === 'string' ? parsed.content : message.text, path = message.args?.path || '', context = message.args?.workspaceId ? { workspaceId: message.args.workspaceId, path } : null;
  const formatted = /\.(md|markdown)$/i.test(path) || /memory/.test(message.name) || !parsed && /^(?:#{1,6} |\|.+\||```|\$\$|\\\[)/m.test(content);
  result.append(formatted ? markdown(content, context, { math: new Set(parsed?.generatedMath || []) }) : codePreview(content, path));
  if (parsed && typeof parsed.content === 'string') { const { content: ignored, ...metadata } = parsed; result.append(el('details', { class: 'tool-metadata' }, el('summary', {}, 'Result metadata'), el('pre', {}, JSON.stringify(metadata, null, 2)))); }
  return result;
}
