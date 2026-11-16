import { Marked, Renderer } from '/vendor/marked.js';
import katex from '/vendor/katex.mjs';
import { mathToken } from '/math.js';
import DOMPurify from '/vendor/purify.js';
import { wikiPattern } from '/wiki.js';
import { codeDisplay } from '/code-display.js';
const wikiAtStart = new RegExp('^' + wikiPattern.source);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
const encode = value => encodeURIComponent(String(value).toWellFormed());
let navigate = () => {}, contextProvider = () => null;
export function configureMarkdown({ onNavigate, context }) { navigate = onNavigate; contextProvider = context; }
const wikiExtension = {
  name: 'wiki', level: 'inline', start: source => source.indexOf('[['),
  tokenizer(source) { const match = wikiAtStart.exec(source); if (match) return { type: 'wiki', raw: match[0], target: match[2].split('|')[0].trim(), label: match[2].split('|').slice(1).join('|') || match[2].split('|')[0], embedded: !!match[1] }; },
  renderer(token) { return '<a href="#wiki=' + encode(token.target) + (token.embedded ? '&embed=1' : '') + '">' + escape(token.label) + '</a>'; },
};
const highlightCache = new Map(), mathCache = new Map();
/**
 * Math is opt-in: model-generated text passes `math: true`; note surfaces pass the set of
 * equations a model actually generated. User-authored dollar signs stay literal Markdown.
 */
export function markdown(value, suppliedContext, { streaming = false, math = false } = {}) {
  const context = suppliedContext === undefined ? contextProvider() : suppliedContext;
  const renderer = new Renderer(), equations = [], mathSet = math instanceof Set ? math : null, mathEnabled = math === true || !!mathSet;
  const allowed = token => mathEnabled && (!mathSet || mathSet.has(token.tex));
  const mathRenderer = token => { if (!allowed(token)) return token.display ? '<p>' + escape(token.raw) + '</p>' : escape(token.raw); const index = equations.push(token) - 1; return '<span class="math-slot math-slot-' + index + '"></span>'; };
  const extensions = [wikiExtension];
  if (mathEnabled) extensions.push(
    { name: 'mathBlock', level: 'block', start: source => { const at = source.search(/\$\$|\\\[/); return at < 0 ? undefined : at; }, tokenizer: source => mathToken(source, true), renderer: mathRenderer },
    { name: 'mathInline', level: 'inline', start: source => { const at = source.search(/\$|\\[([]/); return at < 0 ? undefined : at; }, tokenizer: source => mathToken(source), renderer: mathRenderer });
  const parser = new Marked({ extensions });
  renderer.html = ({ text }) => escape(text);
  renderer.code = token => { const language = (token.lang || '').trim().split(/\s/)[0]; return '<pre><code' + (/^[a-z0-9_+-]+$/i.test(language) ? ' class="language-' + escape(language) + '"' : '') + '>' + escape(token.text) + '</code></pre>'; };
  renderer.image = ({ href, text }) => '<a href="#image=' + encode(href) + '">' + escape(text || 'Image') + '</a>';
  const node = document.createElement('div'); node.className = 'prose';
  try { node.innerHTML = DOMPurify.sanitize(parser.parse(String(value || '').replace(/^\uFEFF/, ''), { breaks: true, gfm: true, renderer }), { FORBID_TAGS: ['style', 'img', 'iframe', 'form', 'button', 'svg', 'math'], FORBID_ATTR: ['style', 'id', 'name'], ALLOW_DATA_ATTR: false }); }
  catch { node.textContent = String(value || ''); return node; }
  equations.forEach((equation, index) => {
    const host = node.querySelector('.math-slot-' + index); if (!host) return;
    host.className = 'math-expression' + (equation.display ? ' display-math' : '');
    if (equation.pending) { host.classList.add('math-pending'); host.textContent = streaming ? 'Equation streaming…' : equation.display ? 'Incomplete equation — add the closing math delimiter.' : equation.raw; return; }
    if (equation.tex.length > 20000) { host.textContent = 'Equation exceeds the 20,000-character rendering limit.'; return; }
    try { const key = equation.display + ':' + equation.tex;
      if (mathCache.has(key)) host.append(...mathCache.get(key).map(node => node.cloneNode(true)));
      else { katex.render(equation.tex, host, { displayMode: equation.display, throwOnError: false, trust: false, strict: 'warn', maxExpand: 200, maxSize: 20, output: 'htmlAndMathml' }); if (equation.tex.length <= 2000) { if (mathCache.size >= 32) mathCache.delete(mathCache.keys().next().value); mathCache.set(key, [...host.childNodes].map(node => node.cloneNode(true))); } }
    }
    catch { host.textContent = equation.tex; host.classList.add('math-error'); }
  });
  node.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#wiki=')) {
      const target = decode(href.slice(6).split('&embed=')[0]); link.className = 'wiki-link'; link.title = '[[' + target + ']]';
      link.addEventListener('click', event => { event.preventDefault(); navigate(target, context, { newTab: event.ctrlKey || event.metaKey, embedded: href.includes('&embed=') }); });
      if (href.includes('&embed=') && context?.workspaceId && /\.(png|jpe?g|webp|gif|avif)(?:#.*)?$/i.test(target)) showLocalImage(link, target.split('|')[0], context, target);
    } else if (href.startsWith('#image=')) {
      const target = decode(href.slice(7));
      if (context?.workspaceId && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//')) showLocalImage(link, target, context, link.textContent);
      else if (/^https:\/\//i.test(target)) {
        let url; try { url = new URL(target); } catch { link.removeAttribute('href'); return; }
        const button = document.createElement('button'); button.type = 'button'; button.className = 'image-consent'; button.textContent = 'Load image from ' + url.hostname;
        button.addEventListener('click', () => { const image = document.createElement('img'); image.src = target; image.alt = link.textContent; image.referrerPolicy = 'no-referrer'; image.loading = 'lazy'; button.replaceWith(image); }); link.replaceWith(button);
      } else { link.removeAttribute('href'); link.textContent = '[Image: ' + link.textContent + ']'; }
    } else if (href.startsWith('#')) {
      link.addEventListener('click', event => { event.preventDefault(); const fragment = decode(href.slice(1)).toLocaleLowerCase(), slug = text => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'); const heading = [...node.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(item => item.textContent.toLocaleLowerCase() === fragment || slug(item.textContent) === fragment); if (heading) heading.scrollIntoView({ block: 'center' }); else if (context?.workspaceId) navigate('#' + decode(href.slice(1)), context); });
    } else if (context?.workspaceId && href && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href) && !href.startsWith('#')) {
      link.addEventListener('click', event => { event.preventDefault(); navigate(decode(href), context, { newTab: event.ctrlKey || event.metaKey }); });
    } else { if (!/^(https?:\/\/|mailto:|#)/i.test(href)) link.removeAttribute('href'); link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  });
  const inputs = [...node.querySelectorAll('input')];
  inputs.forEach((input, index) => { if (input.type !== 'checkbox') { input.remove(); return; } input.closest('li')?.classList.add('task-list-item'); input.disabled = !context?.onTaskToggle; if (context?.onTaskToggle) input.addEventListener('change', () => context.onTaskToggle(index, input.checked, inputs.length)); });
  node.querySelectorAll('pre code').forEach(code => { try { const key = code.className + ':' + code.textContent; if (highlightCache.has(key)) { code.innerHTML = highlightCache.get(key).html; code.className = highlightCache.get(key).className; code.dataset.highlighted = 'yes'; } else if (window.hljs && code.textContent.length <= 20000 && (!code.className || window.hljs.getLanguage(code.className.replace('language-', '')))) { window.hljs.highlightElement(code); if (highlightCache.size >= 64) highlightCache.delete(highlightCache.keys().next().value); highlightCache.set(key, { html: code.innerHTML, className: code.className }); } } catch {} });
  node.querySelectorAll('pre > code').forEach(code => { const pre = code.parentElement, marker = document.createTextNode(''); pre.replaceWith(marker); marker.replaceWith(codeDisplay(code.textContent, { language: code.className.match(/language-([\w+-]+)/)?.[1] || 'text', pre })); });
  return node;
}
function showLocalImage(link, target, context, alt) { queueMicrotask(() => { if (link.isConnected) loadLocalImage(link, target, context, alt); }); }
function loadLocalImage(link, target, context, alt) {
  if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(target)) return;
  fetch('/api/resources/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [target], base: { workspaceId: context.workspaceId, path: context.path } }) }).then(response => { if (!response.ok) throw new Error('Unavailable image'); return response.json(); }).then(data => {
    const result = data.links[0]; if (result.status !== 'resolved') throw new Error('Ambiguous or unavailable image'); const ref = result.matches[0];
    const image = document.createElement('img'); image.alt = alt || target; image.loading = 'lazy'; image.src = '/api/resources/asset?' + new URLSearchParams({ workspaceId: ref.workspaceId, path: ref.path }); image.onerror = () => { image.replaceWith(document.createTextNode('[Image unavailable: ' + target + ']')); }; link.replaceWith(image);
  }).catch(() => { link.textContent = '[Image unavailable: ' + target + ']'; });
}
export function codePreview(value, filename = '') { return codeDisplay(value, { filename }); }
