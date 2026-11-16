/** Delimiter tokenizer shared by block/inline Markdown extensions. Never examines fenced code. */
export function mathToken(source, block = false) {
  const match = (block ? /^ {0,3}(\$\$|\\\[)/ : /^(\$\$|\\\[|\\\(|\$)/).exec(source); if (!match) return;
  const open = match[1], close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open, start = match[0].length;
  if (open === '$' && (!source[start] || /\s/.test(source[start]))) return;
  let at = start;
  while ((at = source.indexOf(close, at)) >= 0) {
    let slashes = 0; for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
    if (slashes % 2 || open === '$' && (source[at + 1] === '$' || /\d/.test(source[at + 1] || '') || /\s/.test(source[at - 1] || ''))) { at += close.length; continue; }
    const tex = source.slice(start, at); if (open === '$' && tex.includes('\n')) return;
    return { type: block ? 'mathBlock' : 'mathInline', raw: source.slice(0, at + close.length), tex, display: ['$$', '\\['].includes(open), pending: false };
  }
  // Display equations can arrive over multiple stream chunks without exposing raw LaTeX flashes.
  if (['$$', '\\[', '\\('].includes(open) || open === '$' && /^[A-Za-z\\]/.test(source.slice(start))) return { type: block ? 'mathBlock' : 'mathInline', raw: source, tex: source.slice(start), display: ['$$', '\\['].includes(open), pending: true };
}
