import { maskMarkdownCode } from './wiki.js';
export function toggleTaskText(content, index, checked, expectedCount) {
  const matches = [...maskMarkdownCode(content).matchAll(/^(\s*[-*+]\s+\[)([ xX])(\])/gm)];
  if (!matches[index] || (expectedCount !== undefined && expectedCount !== matches.length)) return null;
  const at = matches[index].index + matches[index][1].length;
  return content.slice(0, at) + (checked ? 'x' : ' ') + content.slice(at + 1);
}
/** Apply a textarea edit without normalizing untouched CRLF/CR/LF sequences. */
export function preserveLineEndings(previous, textareaValue) {
  const normalized = previous.replace(/\r\n|\r/g, '\n'), next = textareaValue.replace(/\r\n|\r/g, '\n');
  if (normalized === next) return previous;
  let prefix = 0, suffix = 0;
  while (prefix < normalized.length && prefix < next.length && normalized[prefix] === next[prefix]) prefix++;
  while (suffix < normalized.length - prefix && suffix < next.length - prefix && normalized[normalized.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const boundaries = [prefix, normalized.length - suffix], offsets = [];
  let logical = 0, raw = 0;
  for (const boundary of boundaries) { while (logical < boundary) { raw += previous[raw] === '\r' && previous[raw + 1] === '\n' ? 2 : 1; logical++; } offsets.push(raw); }
  const eol = previous.match(/\r\n|\r|\n/)?.[0] || '\n';
  return previous.slice(0, offsets[0]) + next.slice(prefix, next.length - suffix).replace(/\n/g, eol) + previous.slice(offsets[1]);
}
