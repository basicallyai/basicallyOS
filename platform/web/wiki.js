/** Position-preserving Markdown code mask shared by references, headings and task editing. */
export function maskMarkdownCode(text) {
  let fence = null;
  const masked = text.split('\n').map(line => {
    const unquoted = line.replace(/^\uFEFF/, '').replace(/^ {0,3}(?:> ?)+/, ''), block = unquoted.replace(/^ {0,3}(?:[-*+]|\d+[.)])\s+/, '');
    const marker = block.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) { if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null; return line.replace(/[^\r]/g, ' '); }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; return line.replace(/[^\r]/g, ' '); }
    return /^( {4}|\t)/.test(unquoted) ? line.replace(/[^\r]/g, ' ') : line;
  }).join('\n');
  return masked.replace(/(`+)([\s\S]*?)\1(?!`)/g, value => value.replace(/[^\r\n]/g, ' '));
}
export const wikiPattern = /(!?)\[\[((?:[^\]\n]|\](?!\])|\](?=\]\])){1,500})\]\]/g;
/** Wiki-link aliases, note embeds, heading/block fragments; never interpret code as references. */
export function wikiLinks(text) {
  const masked = maskMarkdownCode(text), result = [];
  for (const match of masked.matchAll(wikiPattern)) {
    let slashes = 0; for (let at = match.index - 1; at >= 0 && text[at] === '\\'; at--) slashes++; if (slashes % 2) continue;
    const original = text.slice(match.index, match.index + match[0].length), inner = original.slice(match[1] ? 3 : 2, -2);
    const [destination, ...label] = inner.split('|'), hash = destination.indexOf('#');
    result.push({ start: match.index, end: match.index + original.length, raw: original, embedded: !!match[1], target: destination.trim(), path: (hash < 0 ? destination : destination.slice(0, hash)).trim(), heading: hash < 0 ? '' : destination.slice(hash + 1).trim(), alias: label.join('|').trim() });
  }
  return result;
}
export function sectionExcerpt(content, heading = '', limit = 6000) {
  const lines = content.split('\n'), masked = maskMarkdownCode(content).replace(/^\uFEFF/, '').split('\n'); let start = 0, end = lines.length;
  if (heading) {
    if (heading.startsWith('^')) {
      const index = masked.findIndex(line => line.includes('^' + heading.slice(1))); if (index < 0) return { text: '', line: 1, missingSection: true };
      start = Math.max(0, index - 3); end = Math.min(lines.length, index + 4);
    } else {
      const index = masked.findIndex(line => /^#{1,6}\s/.test(line) && line.replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '').replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, '$2').replace(/`([^`]+)`/g, '$1').toLocaleLowerCase() === heading.toLocaleLowerCase());
      if (index < 0) return { text: '', line: 1, missingSection: true };
      start = index; const level = masked[index].match(/^#+/)[0].length;
      for (let i = index + 1; i < lines.length; i++) if (new RegExp('^#{1,' + level + '}\\s').test(masked[i])) { end = i; break; }
    }
  }
  const text = lines.slice(start, end).join('\n'); return { text: text.slice(0, limit), line: start + 1, truncated: text.length > limit, missingSection: false };
}
