/** Shared pointer/keyboard split boundaries. No document re-rendering during drag. */
export function divider({ axis = 'x', label, read, apply, min, max, reset, commit = () => {}, scale = () => 1, step = 10, className = '' }) {
  const node = document.createElement('div'); node.className = 'split-divider ' + className;
  const direction = () => typeof axis === 'function' ? axis() : axis;
  node.updateAxis = () => { node.classList.toggle('columns-divider', direction() === 'x'); node.classList.toggle('rows-divider', direction() === 'y'); node.setAttribute('aria-orientation', direction() === 'x' ? 'vertical' : 'horizontal'); };
  if (typeof axis === 'function') { node.classList.add('dynamic-axis-divider'); queueMicrotask(() => { if (node.isConnected) node.updateAxis(); }); }
  node.tabIndex = 0; node.setAttribute('role', 'separator'); node.setAttribute('aria-label', label); node.updateAxis();
  const bound = value => typeof value === 'function' ? value() : value;
  const change = value => { const low = bound(min), high = Math.max(low, bound(max)); value = Math.max(low, Math.min(high, value)); apply(value); window.dispatchEvent(new Event('panels-resized')); node.setAttribute('aria-valuenow', String(Math.round(value))); node.setAttribute('aria-valuemin', String(Math.round(low))); node.setAttribute('aria-valuemax', String(Math.round(high))); };
  node.setAttribute('aria-valuenow', String(Math.round(read()))); node.setAttribute('aria-valuemin', String(Math.round(bound(min)))); node.setAttribute('aria-valuemax', String(Math.round(bound(max))));
  node.addEventListener('pointerdown', event => {
    if (event.button !== 0) return; event.preventDefault(); node.focus({ preventScroll: true });
    node.updateAxis(); const currentAxis = direction();
    const controller = new AbortController(), start = currentAxis === 'x' ? event.clientX : event.clientY, initial = read(), ratio = scale(); let frame, pending;
    document.body.classList.add('resizing-workspace', currentAxis === 'x' ? 'resizing-columns' : 'resizing-rows');
    const flush = () => { frame = null; if (pending !== undefined) { change(pending); pending = undefined; } };
    const done = () => { if (frame) cancelAnimationFrame(frame); flush(); controller.abort(); document.body.classList.remove('resizing-workspace', 'resizing-columns', 'resizing-rows'); commit(); };
    window.addEventListener('pointermove', move => { pending = initial + ((currentAxis === 'x' ? move.clientX : move.clientY) - start) * ratio; if (!frame) frame = requestAnimationFrame(flush); }, { signal: controller.signal });
    for (const name of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(name, done, { once: true, signal: controller.signal });
  });
  node.addEventListener('keydown', event => { const negative = direction() === 'x' ? 'ArrowLeft' : 'ArrowUp', positive = direction() === 'x' ? 'ArrowRight' : 'ArrowDown'; if ([negative, positive, 'Home', 'End'].includes(event.key)) { event.preventDefault(); change(event.key === 'Home' ? bound(min) : event.key === 'End' ? bound(max) : read() + (event.key === positive ? 1 : -1) * step * (event.shiftKey ? 5 : 1)); commit(); } });
  node.addEventListener('dblclick', () => { change(reset); commit(); }); return node;
}
let axisFrame;
const updateAxes = () => { if (!axisFrame) axisFrame = requestAnimationFrame(() => { axisFrame = null; document.querySelectorAll('.dynamic-axis-divider').forEach(node => node.updateAxis()); }); };
window.addEventListener('resize', updateAxes); window.addEventListener('panels-resized', updateAxes);
const defaults = { sidebar: 272, context: 360, source: 50, conversation: 840, reasoning: 320, tools: 360 };
let sizes; try { sizes = JSON.parse(localStorage.getItem('basically:panel-sizes') || '{}'); } catch { sizes = {}; }
if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) sizes = {};
export function panelSize(name) { return Number.isFinite(sizes[name]) && sizes[name] > 0 && sizes[name] <= 3000 ? sizes[name] : defaults[name]; }
export function savePanelSize(name, value) { sizes[name] = value; try { localStorage.setItem('basically:panel-sizes', JSON.stringify(sizes)); } catch { /* Layout loss must not prevent editing; document drafts report their own failures. */ } }
export function detailDivider(body, kind) {
  let size = panelSize(kind); body.style.maxHeight = size + 'px';
  return divider({ axis: 'y', label: 'Resize ' + kind + ' panel', min: 80, max: () => Math.max(120, innerHeight * .75), reset: defaults[kind], read: () => body.getBoundingClientRect().height || size,
    apply: value => { size = value; body.style.height = value + 'px'; body.style.maxHeight = value + 'px'; }, commit: () => savePanelSize(kind, size), className: 'detail-divider' });
}
export function initializeShellLayout() {
  const root = document.documentElement, app = document.querySelector('#app'), sidebar = document.querySelector('#sidebar');
  let width = panelSize('sidebar'); root.style.setProperty('--sidebar-width', width + 'px'); root.style.setProperty('--conversation-width', panelSize('conversation') + 'px');
  const handle = divider({ label: 'Resize main sidebar', min: 210, max: () => Math.min(480, innerWidth * .4), reset: defaults.sidebar, read: () => sidebar.getBoundingClientRect().width || width, apply: value => { width = value; root.style.setProperty('--sidebar-width', value + 'px'); }, commit: () => savePanelSize('sidebar', width), className: 'sidebar-divider' }); sidebar.after(handle);
  const chat = document.querySelector('#main-chat-pane'); let column = panelSize('conversation');
  chat.append(divider({ label: 'Resize conversation width', min: 420, max: () => Math.max(420, chat.clientWidth - 64), reset: defaults.conversation, scale: () => 2, read: () => Math.min(column, chat.clientWidth - 64), apply: value => { column = value; root.style.setProperty('--conversation-width', value + 'px'); }, commit: () => savePanelSize('conversation', column), className: 'conversation-divider' }));
  return app;
}
