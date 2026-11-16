/** Shared ProseMirror document editor. This source is bundled locally; no CDN/runtime imports. */
import { Editor, Node, Extension, InputRule } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
const lowlight = createLowlight(common);
import { Markdown } from '@tiptap/markdown';
import { Marked } from 'marked';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { preserveLineEndings } from './editor-text.js';
import { mathToken } from './math.js';
import katex from '/vendor/katex.mjs';
import { markdown as safeMarkdown } from '/markdown.js';
function imageView(raw, context) { const dom = document.createElement('span'); dom.className = 'document-image'; const rendered = safeMarkdown(raw, context); const paragraph = rendered.firstElementChild; dom.append(...(paragraph ? paragraph.childNodes : rendered.childNodes)); return dom; }

const liveEditors = new Map(); let cleanupFrame;
const cleanupObserver = new MutationObserver(() => { if (cleanupFrame) return; cleanupFrame = requestAnimationFrame(() => { cleanupFrame = null; for (const [element, record] of liveEditors) { if (element.isConnected) record.mounted = true; else if (record.mounted) record.destroy(); } }); });
cleanupObserver.observe(document.body, { childList: true, subtree: true });
const Opaque = Node.create({
  name: 'preservedBlock', group: 'block', atom: true, code: true,
  addAttributes: () => ({ raw: { default: '' } }),
  parseHTML: () => [{ tag: 'pre[data-preserved]', getAttrs: node => ({ raw: node.getAttribute('data-source') || node.textContent }) }],
  renderHTML: ({ node }) => ['pre', { 'data-preserved': '', 'data-source': node.attrs.raw, class: 'preserved-markdown', title: 'Preserved Markdown — edit in Source mode' }, node.attrs.raw],
  markdownTokenName: 'html',
  parseMarkdown: token => ({ type: 'preservedBlock', attrs: { raw: token.raw } }),
  renderMarkdown: node => node.attrs.raw,
});
const PreservedSyntax = Opaque.extend({
  name: 'preservedSyntax', markdownTokenName: 'preservedSyntax',
  markdownTokenizer: { name: 'preservedSyntax', level: 'block', start: src => src.search(/^---\r?\n|^\[\^[^\]]+\]:/m),
    tokenize(src, tokens) { const match = (tokens.length ? /^\[\^[^\]]+\]:[^\n]*(?:\n[ \t]+[^\n]*)*\n?/ : /^(?:---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)|\[\^[^\]]+\]:[^\n]*(?:\n[ \t]+[^\n]*)*\n?)/).exec(src); if (match) return { type: 'preservedSyntax', raw: match[0] }; } },
  parseMarkdown: token => ({ type: 'preservedSyntax', attrs: { raw: token.raw } }),
});
const Wiki = Node.create({
  name: 'wikiReference', group: 'inline', inline: true, atom: true,
  addOptions: () => ({ onNavigate: null, context: () => null }),
  addNodeView() { return ({ node }) => { if (/^!\[\[.*\.(png|jpe?g|webp|gif|avif)(?:\|.*?)?\]\]$/i.test(node.attrs.raw)) return { dom: imageView(node.attrs.raw, this.options.context()) }; const dom = document.createElement('span'); dom.className = 'wiki-link'; dom.title = node.attrs.raw + ' · Ctrl/Cmd+click to open'; dom.textContent = node.attrs.raw.replace(/^!?\[\[|\]\]$/g, '').split('|').pop().replace(/\.(md|markdown)(?=#|$)/i, ''); dom.addEventListener('click', event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); this.options.onNavigate?.(node.attrs.raw.replace(/^!?\[\[|\]\]$/g, '').split('|')[0]); } }); return { dom }; }; },
  addAttributes: () => ({ raw: { default: '' } }),
  parseHTML: () => [{ tag: 'span[data-wiki]', getAttrs: node => ({ raw: node.getAttribute('data-source') || node.textContent }) }],
  renderHTML: ({ node }) => ['span', { 'data-wiki': '', 'data-source': node.attrs.raw, class: 'wiki-link' }, node.attrs.raw],
  markdownTokenizer: { name: 'wikiReference', level: 'inline', start: src => src.indexOf('[['), tokenize(src) { const m = /^!?\[\[[^\]\n]+\]\]/.exec(src); if (m) return { type: 'wikiReference', raw: m[0] }; } },
  parseMarkdown: token => ({ type: 'wikiReference', attrs: { raw: token.raw } }),
  renderMarkdown: node => node.attrs.raw,
});
const FootnoteReference = Wiki.extend({
  name: 'footnoteReference',
  parseHTML: () => [{ tag: 'sup[data-footnote]', getAttrs: node => ({ raw: node.getAttribute('data-source') || node.textContent }) }],
  renderHTML: ({ node }) => ['sup', { 'data-footnote': '', 'data-source': node.attrs.raw }, node.attrs.raw],
  markdownTokenizer: { name: 'footnoteReference', level: 'inline', start: src => src.indexOf('[^'), tokenize(src) { const match = /^\[\^[^\]\n]+\]/.exec(src); if (match) return { type: 'footnoteReference', raw: match[0] }; } },
  parseMarkdown: token => ({ type: 'footnoteReference', attrs: { raw: token.raw } }),
  addNodeView() { return ({ node }) => { const dom = document.createElement('sup'); dom.textContent = node.attrs.raw; return { dom }; }; },
});
const PreservedImage = Wiki.extend({
  name: 'preservedImage', markdownTokenName: 'image', markdownTokenizer: undefined,
  parseHTML: () => [{ tag: 'span[data-preserved-image]', getAttrs: node => ({ raw: node.getAttribute('data-source') || node.textContent }) }],
  renderHTML: ({ node }) => ['span', { 'data-preserved-image': '', 'data-source': node.attrs.raw, class: 'preserved-image', title: 'Image source preserved; remote images are not automatically fetched' }, node.attrs.raw],
  parseMarkdown: token => ({ type: 'preservedImage', attrs: { raw: token.raw } }),
  addNodeView() { return ({ node }) => ({ dom: imageView(node.attrs.raw, this.options.context()) }); },
});
const PreservedDefinition = Opaque.extend({ name: 'preservedDefinition', markdownTokenName: 'def', parseMarkdown: token => ({ type: 'preservedDefinition', attrs: { raw: token.raw } }) });
function mathNodes(allowed) { return [false, true].map(display => Node.create({
  name: display ? 'documentMathBlock' : 'documentMathInline', group: display ? 'block' : 'inline', inline: !display, atom: true,
  addAttributes: () => ({ raw: { default: '' }, tex: { default: '' } }),
  parseHTML: () => [{ tag: (display ? 'div' : 'span') + '[data-document-math]', getAttrs: node => ({ raw: node.getAttribute('data-source') || node.textContent, tex: node.getAttribute('data-tex') || '' }) }],
  renderHTML: ({ node }) => [display ? 'div' : 'span', { class: 'document-math', 'data-document-math': '', 'data-source': node.attrs.raw, 'data-tex': node.attrs.tex }, node.attrs.raw],
  addNodeView() { return ({ node }) => { const dom = document.createElement(display ? 'div' : 'span'); dom.className = 'document-math' + (display ? ' display-math' : ''); try { if (!allowed.has(node.attrs.tex)) throw new Error('Literal user Markdown'); katex.render(node.attrs.tex, dom, { displayMode: display, trust: false, throwOnError: false, maxExpand: 200, maxSize: 20 }); } catch { dom.textContent = node.attrs.raw; } return { dom }; }; },
  markdownTokenizer: { name: display ? 'documentMathBlock' : 'documentMathInline', level: display ? 'block' : 'inline', start: src => src.search(display ? /\$\$|\\\[/ : /\$|\\\(/), tokenize(src) { const token = mathToken(src, display); if (token && !token.pending && allowed.has(token.tex)) return { ...token, type: display ? 'documentMathBlock' : 'documentMathInline' }; } },
  parseMarkdown: token => ({ type: display ? 'documentMathBlock' : 'documentMathInline', attrs: { raw: token.raw, tex: token.tex } }),
  renderMarkdown: node => node.attrs.raw,
})); }
const LinkShortcuts = Extension.create({
  name: 'linkShortcutHelper',
  addInputRules() { return [new InputRule({ find: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/, handler: ({ state, range, match }) => { const mark = state.schema.marks.link; state.tr.insertText(match[1], range.from, range.to).addMark(range.from, range.from + match[1].length, mark.create({ href: match[2] })); } })]; },
});

export function createRichEditor({ element, content = '', onChange = () => {}, onSelection, onSave, editable = true, label = 'Document', math = [], renderMath, onSubmit, toolbar = true, onWikiNavigate, context = null }) {
  let source = content, suppress = false, timer, changed = false, pending = false;
  let referenceContext = context, contextChanged = false;
  const allowedMath = new Set(math || []);
  const extensions = [...mathNodes(allowedMath), PreservedImage.configure({ context: () => referenceContext }), FootnoteReference, CodeBlockLowlight.configure({ lowlight, enableTabIndentation: true }), StarterKit.configure({ codeBlock: false, link: { openOnClick: false, protocols: ['https', 'http', 'mailto'] } }), TableKit.configure({ table: { resizable: false } }), TaskList, TaskItem.configure({ nested: true }), Opaque, PreservedSyntax, PreservedDefinition, Wiki.configure({ onNavigate: onWikiNavigate, context: () => referenceContext }), LinkShortcuts, Markdown.configure({ marked: new Marked(), markedOptions: { gfm: true, breaks: false } })];
  const editor = new Editor({ element, extensions, content: content.replace(/^\uFEFF/, ''), contentType: 'markdown', editable, injectCSS: false,
    editorProps: { handleClick(view, pos, event) { if (event.shiftKey || event.ctrlKey || event.metaKey || !view.state.doc.resolve(pos).parent.inlineContent) return false; view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))); view.focus(); return true; }, attributes: { class: 'rich-document prose', role: 'textbox', 'aria-label': label, 'aria-multiline': 'true' }, handleKeyDown: (_view, event) => { if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && editor.isEditable) { const { $from } = editor.state.selection, itemType = $from.depth >= 2 ? $from.node(-1).type.name : null; if ($from.parent.type.name === 'heading' && editor.chain().splitBlock({ keepMarks: false }).setParagraph().run()) { event.preventDefault(); return true; } if ($from.parent.type.name !== 'codeBlock' && ['listItem', 'taskItem'].includes(itemType) && editor.commands.first(({ commands }) => [() => commands.splitListItem(itemType), () => commands.liftEmptyBlock()])) { event.preventDefault(); return true; } } if (onSubmit && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); onSubmit(); return true; } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); const href = prompt('Link URL (https://…)'); if (/^https?:\/\//i.test(href || '')) editor.chain().focus().setLink({ href }).run(); return true; } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); onSave?.(); return true; } return false; }, handlePaste(view, event) { const text = event.clipboardData?.getData('text/plain'); if (!text || event.clipboardData.getData('text/html') || view.state.selection.$from.parent.type.name === 'codeBlock') return false; try { const doc = editor.schema.nodeFromJSON(editor.markdown.parse(text)); view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 0, 0))); return true; } catch { return false; } }, handleDOMEvents: { drop: (_view, event) => !!event.dataTransfer?.files.length } },
    onUpdate() { if (suppress) return; clearTimeout(timer); timer = setTimeout(() => { source = preserveLineEndings(source, editor.getMarkdown()); onChange(source); }, 120); },
    onSelectionUpdate({ editor }) { const { from, to } = editor.state.selection; onSelection?.(editor.state.doc.textBetween(from, to, '\n')); },
  });
  if (toolbar) {
    const bar = document.createElement('div'); bar.className = 'document-formatbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Document formatting');
    const actions = [['Bold', 'B', () => editor.chain().focus().toggleBold().run()], ['Italic', 'I', () => editor.chain().focus().toggleItalic().run()], ['Strikethrough', 'S', () => editor.chain().focus().toggleStrike().run()], ['Heading', 'H', () => editor.chain().focus().toggleHeading({ level: 2 }).run()], ['Bullet list', '•', () => editor.chain().focus().toggleBulletList().run()], ['Numbered list', '1.', () => editor.chain().focus().toggleOrderedList().run()], ['Blockquote', '❯', () => editor.chain().focus().toggleBlockquote().run()], ['Code block', '<>', () => editor.chain().focus().toggleCodeBlock().run()], ['Table', '▦', () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()], ['Link', '↗', () => { const href = prompt('Link URL (https://…)'); if (/^https?:\/\//i.test(href || '')) editor.chain().focus().setLink({ href }).run(); }]];
    for (const [label, text, action] of actions) { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.title = label; button.setAttribute('aria-label', label); button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', action); bar.append(button); }
    element.prepend(bar);
  }
  // Keep unchanged top-level Markdown blocks byte-for-byte. Edited blocks serialize through the schema.
  // Frontmatter, HTML, wiki references and footnotes have explicit preservation nodes, never executable DOM.
  const blocks = new Map();
  function capture(text) {
    blocks.clear();
    try { for (const token of editor.markdown.instance.lexer(text.replace(/^\uFEFF/, ''))) { if (token.type === 'space') continue; const json = editor.markdown.parse(token.raw); if (json.content?.length === 1) blocks.set(JSON.stringify(editor.schema.nodeFromJSON(json.content[0]).toJSON()), token.raw.replace(/\n+$/, '')); } } catch {}
  }
  capture(content);
  function serialize() {
    if (!changed) return source;
    const json = editor.getJSON();
    const text = (json.content || []).map(node => blocks.get(JSON.stringify(node)) ?? editor.markdown.serialize({ type: 'doc', content: [node] })).join('\n\n');
    return preserveLineEndings(source, text + (source.endsWith('\n') && !text.endsWith('\n') ? '\n' : ''));
  }
  editor.off('update');
  editor.on('update', ({ transaction }) => { if (suppress || !transaction.docChanged) return; changed = true; pending = true; clearTimeout(timer); timer = setTimeout(() => { source = serialize(); pending = false; timer = null; onChange(source); }, 120); });
  let destroyed = false;
  const destroy = () => { if (destroyed) return; destroyed = true; liveEditors.delete(element); if (pending) { clearTimeout(timer); source = serialize(); pending = false; onChange(source); } editor.destroy(); };
  liveEditors.set(element, { mounted: element.isConnected, destroy });
  return {
    editor,
    getMarkdown() { editor.view.domObserver?.flush(); clearTimeout(timer); timer = null; pending = false; return source = serialize(); },
    setContent(text) { if (text === source && !pending && !contextChanged) return; clearTimeout(timer); pending = false; contextChanged = false; source = text; changed = false; suppress = true; const pos = editor.state.selection.from; editor.commands.setContent(text.replace(/^\uFEFF/, ''), { contentType: 'markdown', emitUpdate: false }); editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size))))); suppress = false; capture(text); },
    setContext(value) { contextChanged ||= referenceContext?.workspaceId !== value?.workspaceId || referenceContext?.path !== value?.path; referenceContext = value; },
    setMath(values) { allowedMath.clear(); for (const tex of values || []) allowedMath.add(tex); },
    setEditable(value) { if (editor.isEditable !== value) editor.setEditable(value, false); },
    focus() { editor.commands.focus(); }, undo() { return editor.commands.undo(); }, redo() { return editor.commands.redo(); },
    destroy,
  };
}
