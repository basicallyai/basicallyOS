const LABELS = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export const levelLabel = level => LABELS[level] || level[0].toUpperCase() + level.slice(1);
export function reasoningKey(provider, model) { return provider.id + '/' + model.id; }
export function effortFor(model, settings, provider) {
  if (!model.reasoning || !model.reasoningConfig?.levels?.length) return null;
  const levels = model.reasoningConfig.levels, preferred = settings.reasoningOverrides?.[reasoningKey(provider, model)] || settings.reasoningLevel;
  return levels.includes(preferred) ? preferred : levels[0];
}

/**
 * Compact anchored model menu modelled on Claude's selector, in basically OS styling.
 * The list contains display names only. Effort is a separate submenu; no technical metadata.
 */
export function modelMenu({ trigger, providers, selection, settings, choose, setReasoning, manage, el, icon }) {
  let root = null, submenu = null, effortItem = null, search = null, list = null, index = 0, query = '';
  const getProviders = () => typeof providers === 'function' ? providers() : providers;
  const getSelection = () => typeof selection === 'function' ? selection() : selection;
  const getSettings = () => typeof settings === 'function' ? settings() : settings;
  const all = () => getProviders().flatMap(provider => provider.models.map(model => ({ provider, model })));
  const selectedRow = () => { const active = getSelection(); return all().find(row => row.provider.id === active?.provider && row.model.id === active?.model) || null; };
  const levelsFor = row => row?.model.reasoning && row.model.reasoningConfig?.levels?.length ? row.model.reasoningConfig.levels : [];
  const rowNodes = () => [...(list?.querySelectorAll('.model-option') || [])];
  const menuNodes = () => [...(root?.querySelectorAll('[role=menuitem],[role=menuitemradio]') || [])].filter(node => !node.hidden && !node.disabled);

  function fits(node, anchor, side, gap = 6, margin = 10) {
    const box = anchor.getBoundingClientRect(), size = node.getBoundingClientRect();
    return side === 'right' ? box.right + gap + size.width <= innerWidth - margin : box.left - gap - size.width >= margin;
  }
  function placeMenu() {
    if (!root) return;
    root.style.visibility = 'hidden'; root.style.left = '0px'; root.style.top = '0px'; root.style.maxHeight = 'min(460px, calc(100dvh - 20px))';
    const box = trigger.getBoundingClientRect(), size = root.getBoundingClientRect(), gap = 8, margin = 10, height = Math.min(size.height, innerHeight - margin * 2);
    const above = box.top - gap >= height || box.top > innerHeight - box.bottom;
    root.style.top = (above ? Math.max(margin, box.top - gap - height) : Math.min(innerHeight - height - margin, box.bottom + gap)) + 'px';
    root.style.left = Math.max(margin, Math.min(innerWidth - size.width - margin, box.right - size.width)) + 'px';
    root.style.visibility = '';
  }
  function placeSubmenu() {
    if (!submenu || !effortItem) return;
    submenu.style.visibility = 'hidden'; submenu.style.left = '0px'; submenu.style.top = '0px'; submenu.style.maxHeight = 'min(320px, calc(100dvh - 20px))';
    const box = effortItem.getBoundingClientRect(), menu = root.getBoundingClientRect(), size = submenu.getBoundingClientRect(), gap = 6, margin = 10;
    if (fits(submenu, effortItem, 'right', gap, margin)) submenu.style.left = menu.right + gap + 'px';
    else if (fits(submenu, effortItem, 'left', gap, margin)) submenu.style.left = menu.left - gap - size.width + 'px';
    else submenu.style.left = Math.max(margin, Math.min(innerWidth - size.width - margin, box.left)) + 'px';
    submenu.style.top = Math.max(margin, Math.min(box.top - 6, innerHeight - size.height - margin)) + 'px';
    submenu.style.visibility = '';
  }
  function closeSubmenu({ restore = false } = {}) {
    if (!submenu) return;
    submenu.remove(); submenu = null;
    if (effortItem) { effortItem.setAttribute('aria-expanded', 'false'); if (restore) effortItem.focus(); effortItem = null; }
  }
  async function applyEffort(row, level) {
    const buttons = [...(submenu?.querySelectorAll('button') || [])];
    buttons.forEach(button => button.disabled = true); const target = submenu?.querySelector('[data-level="' + level + '"]'); target?.setAttribute('aria-busy', 'true');
    try { await setReasoning(reasoningKey(row.provider, row.model), level); close(); trigger.focus(); }
    catch { buttons.forEach(button => button.disabled = false); target?.removeAttribute('aria-busy'); }
  }
  function openSubmenu({ focus = false } = {}) {
    closeSubmenu();
    const row = selectedRow(), levels = levelsFor(row); if (!row || !levels.length) return;
    effortItem = root.querySelector('[data-role=effort]'); if (!effortItem) return;
    const currentLevel = effortFor(row.model, getSettings(), row.provider);
    submenu = el('div', { class: 'model-submenu', role: 'menu', 'aria-label': 'Effort' });
    levels.forEach((level, i) => {
      const active = level === currentLevel;
      const item = el('button', { class: 'model-menu-item' + (active ? ' is-selected' : ''), role: 'menuitemradio', 'aria-checked': String(active), 'data-level': level, tabindex: '-1', title: levelLabel(level) },
        el('span', { class: 'model-menu-name' }, levelLabel(level)), active ? el('span', { class: 'model-menu-check' }, icon('check')) : null);
      item.addEventListener('click', () => applyEffort(row, level));
      item.addEventListener('keydown', event => {
        const rows = [...submenu.querySelectorAll('[role=menuitemradio]')], at = rows.indexOf(item);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); const next = rows[(at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]; rows.forEach(node => node.tabIndex = -1); next.tabIndex = 0; next.focus(); }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); event.stopPropagation(); const next = rows[event.key === 'Home' ? 0 : rows.length - 1]; rows.forEach(node => node.tabIndex = -1); next.tabIndex = 0; next.focus(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSubmenu({ restore: true }); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); closeSubmenu({ restore: true }); }
      });
      submenu.append(item);
    });
    const recommended = row.model.reasoningConfig?.default;
    if (recommended && levels.includes(recommended)) submenu.append(el('p', { class: 'model-menu-note' }, levelLabel(recommended) + ' is the provider default.'));
    effortItem.setAttribute('aria-expanded', 'true'); document.body.append(submenu); placeSubmenu();
    if (focus) { const rows = [...submenu.querySelectorAll('[role=menuitemradio]')]; (rows.find(node => node.getAttribute('aria-checked') === 'true') || rows[0])?.focus(); }
  }
  function effortRow() {
    const row = selectedRow(), levels = levelsFor(row), item = root?.querySelector('[data-role=effort]');
    if (!item) return;
    item.hidden = !levels.length; item.querySelector('[data-effort-value]').textContent = levels.length ? levelLabel(effortFor(row.model, getSettings(), row.provider) || levels[0]) : '';
    if (!levels.length) closeSubmenu();
  }
  function close({ restore = false } = {}) {
    if (!root) return;
    const inside = root.contains(document.activeElement) || submenu?.contains(document.activeElement);
    closeSubmenu(); root.remove(); root = null; submenu = null; list = null; search = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', pointerOutside, true); document.removeEventListener('focusin', focusOutside, true);
    removeEventListener('resize', reposition); removeEventListener('blur', reposition);
    if (restore || inside) trigger.focus();
  }
  const pointerOutside = event => { if (!root?.contains(event.target) && !submenu?.contains(event.target) && !trigger.contains(event.target)) close(); };
  const focusOutside = event => { if (root && !root.contains(event.target) && !submenu?.contains(event.target) && !trigger.contains(event.target)) close(); };
  const reposition = () => { placeMenu(); if (submenu) placeSubmenu(); };
  function moveMenu(delta) { const rows = menuNodes(); if (!rows.length) return; rows.forEach(node => node.tabIndex = -1); index = (index + delta + rows.length) % rows.length; rows[index].tabIndex = 0; rows[index].focus(); }
  function render() {
    if (!list) return;
    list.replaceChildren(); const term = query.trim().toLocaleLowerCase(), rows = all().filter(({ provider, model }) => !term || (model.name + ' ' + model.id + ' ' + provider.name).toLocaleLowerCase().includes(term)).slice(0, 150);
    if (!rows.length) { list.append(el('p', { class: 'model-menu-empty' }, term ? 'No matching models.' : 'No models yet. Add one in Manage models.')); return; }
    rows.forEach(({ provider, model }, i) => {
      const active = getSelection()?.provider === provider.id && getSelection()?.model === model.id;
      const item = el('button', { class: 'model-option' + (active ? ' is-selected' : ''), role: 'menuitemradio', 'aria-checked': String(active), 'data-provider': provider.id, 'data-model-id': model.id, tabindex: i === 0 ? '0' : '-1', title: model.name },
        el('span', { class: 'model-menu-name' }, model.name), active ? el('span', { class: 'model-menu-check' }, icon('check')) : null);
      item.addEventListener('click', () => chooseRow(provider, model)); item.addEventListener('focus', () => { index = i; });
      list.append(item);
    });
  }
  async function chooseRow(provider, model) {
    try { await choose(provider, model); close(); } catch { itemFocus(); }
  }
  function itemFocus() { const node = list?.querySelector('[role=menuitemradio][aria-checked=true]') || list?.querySelector('[role=menuitemradio]'); node?.focus(); }
  function open() {
    if (root) { close({ restore: true }); return; }
    query = '';
    root = el('div', { class: 'model-menu', id: 'model-menu', role: 'menu', 'aria-label': 'Models' });
    if (all().length > 5) {
      search = el('input', { type: 'search', class: 'model-menu-search', placeholder: 'Search models', 'aria-label': 'Search models', autocomplete: 'off', spellcheck: 'false' });
      search.addEventListener('input', () => { query = search.value; render(); root.querySelector('.model-menu-list')?.scrollTo(0, 0); });
      search.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); index = -1; moveMenu(event.key === 'ArrowDown' ? 1 : -1); }
        else if (event.key === 'ArrowRight') { const effort = root.querySelector('[data-role=effort]:not([hidden])'); if (effort) { event.preventDefault(); effort.focus(); } }
      });
      root.append(el('div', { class: 'model-menu-search-row' }, icon('search'), search));
    }
    list = el('div', { class: 'model-menu-list', role: 'group', 'aria-label': 'Available models' }); root.append(list);
    const effort = el('button', { class: 'model-menu-item model-menu-effort', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-role': 'effort', tabindex: '-1' },
      el('span', { class: 'model-menu-name' }, 'Effort'), el('span', { class: 'model-menu-value' }, el('span', { 'data-effort-value': '' }), icon('chevron')));
    effort.addEventListener('click', () => openSubmenu({ focus: true }));
    effort.addEventListener('mouseenter', () => openSubmenu());
    effort.addEventListener('keydown', event => { if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSubmenu({ focus: true }); } else if (event.key === 'Escape') { event.preventDefault(); close({ restore: true }); } });
    const manageRow = el('button', { class: 'model-menu-item model-menu-manage', id: 'manage-models', role: 'menuitem', tabindex: '-1' }, el('span', { class: 'model-menu-name' }, 'Manage models'), icon('external'));
    manageRow.addEventListener('click', () => { close(); manage(); });
    root.append(el('div', { class: 'model-menu-separator' }), effort, manageRow);
    root.addEventListener('keydown', event => {
      const active = document.activeElement, isSearch = active === search;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ restore: true }); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { if (isSearch) return; event.preventDefault(); const rows = menuNodes(), at = rows.indexOf(active); if (at < 0) { index = -1; moveMenu(event.key === 'ArrowDown' ? 1 : -1); } else { rows.forEach(node => node.tabIndex = -1); index = (at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length; rows[index].tabIndex = 0; rows[index].focus(); } }
      else if (event.key === 'Home' || event.key === 'End') { if (isSearch) return; event.preventDefault(); const rows = menuNodes(); index = event.key === 'Home' ? 0 : rows.length - 1; rows.forEach(node => node.tabIndex = -1); rows[index].tabIndex = 0; rows[index].focus(); }
      else if (event.key === 'Tab') { event.preventDefault(); moveMenu(event.shiftKey ? -1 : 1); }
    });
    document.body.append(root); render(); effortRow(); placeMenu(); trigger.setAttribute('aria-expanded', 'true');
    index = Math.max(0, rowNodes().findIndex(node => node.getAttribute('aria-checked') === 'true'));
    document.addEventListener('pointerdown', pointerOutside, true); document.addEventListener('focusin', focusOutside, true);
    addEventListener('resize', reposition); addEventListener('blur', reposition);
    (search || rowNodes()[index] || root.querySelector('[role=menuitem]'))?.focus();
  }

  trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!root) open(); else moveMenu(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Escape' && root) { event.preventDefault(); close({ restore: true }); }
  });
  return {
    open, close,
    refresh() { if (root) { render(); effortRow(); placeMenu(); } },
    isOpen: () => !!root,
    contains: target => !!(root?.contains(target) || submenu?.contains(target) || trigger.contains(target)),
  };
}
