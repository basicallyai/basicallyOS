/** Race-safe automatic metadata lookup for both onboarding and saved connections. */
export function wireModelMetadata(row, { api, connection, el, button }) {
  const input = name => row.querySelector('[name=' + name + ']'), status = el('p', { class: 'metadata-status help', role: 'status' }), dirty = new Set();
  let sequence = 0, timer, lastId = input('modelId').value, fingerprint = '';
  const configuration = () => ({ ...connection(), upstreamProvider: input('upstreamProvider')?.value.trim() || null });
  const fields = ['contextWindow', 'maxTokens', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice', 'tools', 'vision', 'reasoning', 'reasoningFormat', 'reasoningLevels'];
  for (const name of row.source.metadata?.manualFields || []) dirty.add(name);
  if (row.source.name && row.source.name !== row.source.id) dirty.add('modelName');
  if (row.source.id && !row.source.metadata) for (const name of fields) { const node = input(name); if (node && (node.type === 'checkbox' ? row.source[name] != null : node.value !== '' && node.value !== 'none')) dirty.add(name); }
  row.manualFields = dirty;
  row.querySelectorAll('input,select').forEach(node => node.addEventListener('input', () => { if (node.name !== 'modelId') dirty.add(node.name); }));
  const set = (name, value) => { const node = input(name); if (!node || dirty.has(name)) return; if (node.type === 'checkbox') node.checked = value === true; else node.value = value ?? ''; };
  function reset() { for (const name of fields) { dirty.delete(name); set(name, name === 'reasoningFormat' ? 'none' : null); } set('modelName', ''); row.source = {}; }
  async function lookup(refresh = false) {
    clearTimeout(timer); const id = input('modelId').value.trim(), config = configuration();
    if (!id || !config.baseUrl) { row.removeAttribute('aria-busy'); status.textContent = 'Enter a model ID and endpoint to retrieve available metadata.'; return; }
    const current = JSON.stringify({ ...config, modelId: id });
    if (!refresh && current === fingerprint) return row.pendingMetadata?.catch(() => {});
    const version = ++sequence;
    fingerprint = current; status.textContent = 'Retrieving endpoint metadata…'; row.setAttribute('aria-busy', 'true');
    try {
      row.pendingMetadata = api('/providers/metadata', { ...config, modelId: id, refresh });
      const result = await row.pendingMetadata;
      if (version !== sequence || id !== input('modelId').value.trim() || JSON.stringify({ ...configuration(), modelId: id }) !== current || !row.isConnected) return;
      const model = result.model;
      if (!model) { status.textContent = 'Unknown model ID in this endpoint’s catalog. Enter verified limits and capabilities manually; unavailable prices remain unknown.'; return; }
      row.source = model;
      if (!dirty.has('modelName')) set('modelName', model.name);
      set('contextWindow', model.contextWindow); set('maxTokens', model.maxTokens);
      for (const [field, key] of [['inputPrice', 'input'], ['outputPrice', 'output'], ['cacheReadPrice', 'cacheRead'], ['cacheWritePrice', 'cacheWrite']]) set(field, model.cost?.[key]);
      for (const key of ['tools', 'vision', 'reasoning']) set(key, model[key]);
      set('reasoningFormat', model.reasoningConfig?.format || 'none'); set('reasoningLevels', model.reasoningConfig?.levels.join(', ') || '');
      status.textContent = 'From ' + model.metadata.provider + ' · ' + (model.metadata.missing.length ? 'Unavailable: ' + model.metadata.missing.join(', ') + '. Enter verified values manually.' : 'Limits and pricing retrieved.') + ' Manual edits are preserved.';
    } catch (error) { if (version === sequence && row.isConnected) status.textContent = error.message + ' You can configure this model manually.'; }
    finally { if (version === sequence) { row.removeAttribute('aria-busy'); row.pendingMetadata = null; } }
  }
  row.append(el('div', { class: 'metadata-feedback' }, status, button('Refresh metadata', () => lookup(true), 'text-button')));
  row.lookupMetadata = lookup;
  input('modelId').addEventListener('input', () => { sequence++; fingerprint = ''; clearTimeout(timer); if (lastId !== input('modelId').value) { lastId = input('modelId').value; reset(); } status.textContent = 'Waiting for model ID…'; timer = setTimeout(() => lookup(), 450); });
  const invalidateRates = () => {
    for (const name of fields) { dirty.delete(name); set(name, name === 'reasoningFormat' ? 'none' : null); }
    row.source = {}; sequence++; fingerprint = ''; clearTimeout(timer);
    status.textContent = 'Routing changed. Previous endpoint prices and limits cleared; retrieving verified metadata…';
    timer = setTimeout(() => { if (row.isConnected) lookup(); }, 450);
  };
  input('upstreamProvider')?.addEventListener('input', invalidateRates);
  row.refreshMetadata = () => { sequence++; fingerprint = ''; clearTimeout(timer); timer = setTimeout(() => { if (row.isConnected) lookup(); }, 450); };
  status.textContent = row.source.metadata ? 'Metadata from ' + row.source.metadata.provider + '. Manual overrides are supported.' : 'Metadata unavailable until looked up; no limits or prices are assumed.';
  if (lastId && (!row.source.metadata || Date.now() - row.source.metadata.fetchedAt > 900000)) row.refreshMetadata();
}
