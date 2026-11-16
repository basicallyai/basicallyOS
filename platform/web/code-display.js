import { copyButton } from './copy-button.js';
const languages = { py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', html: 'xml', htm: 'xml', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', md: 'markdown', go: 'go', rb: 'ruby', xml: 'xml' };
export const codeLanguage = filename => languages[String(filename).split('.').pop().toLowerCase()] || 'text';
export const lineCount = text => text === '' ? 0 : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
export function codeDisplay(value, { filename = '', language = '', pre = null } = {}) {
  const raw = String(value), lang = language || codeLanguage(filename), root = document.createElement('section'); root.className = 'code-display';
  const header = document.createElement('header'); header.className = 'code-header'; const title = document.createElement('span'); title.textContent = (filename ? filename + ' · ' : '') + (lang === 'xml' ? 'HTML/XML' : lang === 'text' ? 'Plain text' : lang.charAt(0).toUpperCase() + lang.slice(1)) + ' · ' + lineCount(raw).toLocaleString() + ' ' + (lineCount(raw) === 1 ? 'line' : 'lines');
  root.rawCode = raw; root.codeLanguage = lang;
  header.append(title, copyButton(() => root.rawCode, 'Copy code')); root.append(header);
  if (!pre) { pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = raw; if (/^[a-z0-9_+-]+$/i.test(lang)) code.className = 'language-' + lang; pre.append(code); }
  pre.setAttribute('tabindex', '0'); pre.setAttribute('aria-label', 'Read-only source code'); pre.contentEditable = 'false'; root.append(pre);
  const code = pre.querySelector('code');
  try { if (window.hljs && raw.length <= 100000 && !code.dataset.highlighted && window.hljs.getLanguage(lang)) window.hljs.highlightElement(code); } catch {}
  // Large sources remain selectable, exact text. Avoid parsing millions of highlight spans.
  if (raw.length > 100000) root.classList.add('large-code');
  root.updateCode = fresh => {
    const top = pre.scrollTop, left = pre.scrollLeft; root.rawCode = fresh.rawCode; title.textContent = fresh.querySelector('.code-header > span').textContent;
    const next = fresh.querySelector('code'); code.innerHTML = next.innerHTML; code.className = next.className; pre.scrollTop = top; pre.scrollLeft = left;
  };
  return root;
}
