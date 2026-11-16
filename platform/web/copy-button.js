/** One raw-text clipboard interaction for documents, code and previews. No success toast. */
export function lucide(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '/icons.svg#' + name); svg.append(use); svg.setAttribute('aria-hidden', 'true'); return svg; }
export function copyButton(getText, label = 'Copy') {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button raw-copy'; button.setAttribute('aria-label', label); button.title = label; button.append(lucide('copy'));
  const status = document.createElement('span'); status.className = 'sr-only'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); button.append(status); let timer, sequence = 0;
  button.addEventListener('click', async () => { const call = ++sequence; try { await navigator.clipboard.writeText(await getText()); if (call !== sequence) return; clearTimeout(timer); button.replaceChildren(lucide('check'), status); status.textContent = 'Copied.'; button.setAttribute('aria-label', 'Copied'); timer = setTimeout(() => { button.replaceChildren(lucide('copy'), status); button.setAttribute('aria-label', label); status.textContent = ''; }, 1700); }
    catch { if (call !== sequence) return; clearTimeout(timer); button.replaceChildren(lucide('copy'), status); button.setAttribute('aria-label', label + ' failed. Try again or select the text and copy.'); status.textContent = 'Copy failed. Try again or select the text and copy manually.'; } });
  return button;
}
