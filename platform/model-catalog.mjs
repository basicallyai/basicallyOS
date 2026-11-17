/** Live endpoint metadata only; no bundled model IDs, price tables or guessed limits. */
import { createHash } from 'node:crypto';
import { validateEndpoint } from './providers.mjs';
const number = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const positive = value => { const n = number(value); return Number.isInteger(n) && n > 0 ? n : null; };
const flag = value => typeof value === 'boolean' ? value : null;
export function catalogModel(row, baseUrl, fetchedAt = Date.now()) {
  const router = new URL(baseUrl).hostname === 'openrouter.ai', parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters.filter(value => typeof value === 'string') : null;
  const modalities = row.architecture || row.modalities || {};
  const input = modalities.input_modalities || modalities.input || null, output = modalities.output_modalities || modalities.output || null;
  const price = row.pricing || {}, perToken = router || price.unit === 'token';
  const rate = value => { const n = number(value); if (n === null || !router && !['token', 'million_tokens'].includes(price.unit)) return null; const [coefficient, exponent = '0'] = String(n).split('e'); return perToken ? Number(coefficient + 'e' + (Number(exponent) + 6)) : n; };
  const cost = { input: rate(price.prompt ?? price.input), output: rate(price.completion ?? price.output), cacheRead: rate(price.input_cache_read ?? price.cacheRead ?? price.cached_input), cacheWrite: rate(price.input_cache_write ?? price.cacheWrite) };
  let reasoningConfig = null;
  const efforts = row.reasoning?.supported_efforts || row.reasoning_levels;
  if (Array.isArray(efforts)) reasoningConfig = { format: router ? 'openrouter' : 'openai', levels: efforts.filter(level => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) };
  // OpenRouter documents normalization of these effort values across its reasoning providers.
  else if (router && parameters?.includes('reasoning')) reasoningConfig = { format: 'openrouter', levels: ['low', 'medium', 'high'] };
  if (!reasoningConfig?.levels.length) reasoningConfig = null;
  const reasoning = flag(row.reasoning?.supported ?? row.reasoning) ?? (parameters ? parameters.some(name => name === 'reasoning' || name === 'reasoning_effort') : reasoningConfig ? true : null);
  const tools = flag(row.capabilities?.tools ?? row.tools) ?? (parameters ? parameters.includes('tools') : null);
  return { id: row.id, name: typeof row.name === 'string' ? row.name : row.id,
    contextWindow: positive(row.context_length ?? row.context_window ?? row.contextWindow ?? row.max_model_len),
    maxTokens: positive(row.top_provider?.max_completion_tokens ?? row.max_completion_tokens ?? row.max_output_tokens ?? row.maxTokens),
    cost: Object.values(cost).some(value => value !== null) ? cost : null,
    tools, vision: flag(row.vision) ?? (Array.isArray(input) ? input.includes('image') : null), reasoning, reasoningConfig,
    capabilities: { input: Array.isArray(input) ? input.filter(value => typeof value === 'string').slice(0, 12) : null, output: Array.isArray(output) ? output.filter(value => typeof value === 'string').slice(0, 12) : null, tools, reasoning, structuredOutput: flag(row.capabilities?.structured_output) ?? (parameters ? parameters.includes('structured_outputs') || parameters.includes('response_format') : null) },
    metadata: { source: baseUrl + '/models', fetchedAt, provider: router ? 'OpenRouter' : new URL(baseUrl).hostname === 'api.openai.com' ? 'OpenAI' : 'Configured endpoint', missing: ['contextWindow', 'maxTokens', 'pricing'].filter(key => key === 'contextWindow' ? !positive(row.context_length ?? row.context_window ?? row.contextWindow ?? row.max_model_len) : key === 'maxTokens' ? !positive(row.top_provider?.max_completion_tokens ?? row.max_completion_tokens ?? row.max_output_tokens ?? row.maxTokens) : cost.input === null || cost.output === null) } };
}
export function createModelCatalog({ ttl = 15 * 60 * 1000, fetcher = fetch } = {}) {
  const cache = new Map();
  return async function catalog(provider, { refresh = false, modelId, upstreamProvider } = {}) {
    const baseUrl = validateEndpoint(provider.baseUrl);
    if (upstreamProvider && (new URL(baseUrl).hostname !== 'openrouter.ai' || typeof modelId !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(modelId) || typeof upstreamProvider !== 'string' || upstreamProvider.length > 120)) throw new Error('Provider-specific metadata requires an exact OpenRouter model ID and provider name or endpoint tag.');
    const path = upstreamProvider ? '/models/' + modelId.split('/').map(encodeURIComponent).join('/') + '/endpoints' : '/models';
    const key = baseUrl + path + ':' + (upstreamProvider || '') + ':' + createHash('sha256').update(provider.apiKey || '').digest('hex'), now = Date.now(), old = cache.get(key);
    if (old && (old.pending || old.until > now && (!refresh || old.error))) { if (old.error) throw new Error(old.error); return old.pending || old.result; }
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    const entry = { until: now + ttl }; cache.set(key, entry);
    entry.pending = (async () => {
      try {
        const response = await fetcher(baseUrl + path, { headers: provider.apiKey ? { Authorization: 'Bearer ' + provider.apiKey } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) { entry.retry = response.status === 429 ? Math.min(120000, Math.max(10000, Number(response.headers.get('retry-after')) * 1000 || 30000)) : 10000; throw new Error('Metadata request returned HTTP ' + response.status + '. Unavailable values must be configured manually.'); }
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('The model catalog exceeds 4 MB.'); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let rows = body.data;
        if (upstreamProvider) {
          if (!Array.isArray(body.data?.endpoints)) throw new Error('The endpoint did not return provider-specific metadata.');
          const endpoints = body.data.endpoints;
          const tagged = endpoints.filter(row => row.tag === upstreamProvider);
          const matches = tagged.length ? tagged : endpoints.filter(row => row.provider_name === upstreamProvider);
          if (matches.length !== 1) throw new Error(matches.length ? 'This provider has multiple endpoints. Enter an exact endpoint tag: ' + matches.map(row => row.tag).filter(Boolean).slice(0, 12).join(', ') : 'This provider or endpoint tag is not advertised for the model. Check the exact name; no fallback pricing is used.');
          rows = [{ ...matches[0], id: modelId, name: body.data.name || modelId, architecture: body.data.architecture }];
        }
        if (!Array.isArray(rows)) throw new Error('The endpoint did not return a model catalog.');
        const models = rows.slice(0, 5000).filter(row => row && typeof row.id === 'string' && row.id.length <= 250).map(row => catalogModel(row, baseUrl, now));
        if (upstreamProvider) for (const model of models) model.metadata = { ...model.metadata, source: baseUrl + path, upstreamProvider, provider: 'OpenRouter · ' + upstreamProvider };
        entry.result = { models, fetchedAt: now, expiresAt: now + ttl };
        return entry.result;
      } catch (error) { entry.until = Date.now() + (entry.retry || 10000); entry.error = error.message; throw error; }
      finally { entry.pending = null; }
    })(); return entry.pending;
  };
}
export function reasoningPayload(payload, saved, api, level) {
  if (saved.upstreamProvider) payload.provider = { only: [saved.upstreamProvider], allow_fallbacks: false };
  // Pi's inferred provider defaults must not send unsupported settings to arbitrary compatible APIs.
  delete payload.reasoning; delete payload.reasoning_effort; delete payload.thinking; delete payload.enable_thinking; delete payload.chat_template_kwargs;
  const config = saved.reasoningConfig;
  if (!saved.reasoning || !config || !config.levels.includes(level)) return payload;
  const effort = level === 'off' ? 'none' : level;
  if (config.format === 'openrouter') payload.reasoning = level === 'off' ? { enabled: false } : { effort };
  else if (api === 'openai-responses') payload.reasoning = { effort };
  else payload.reasoning_effort = effort;
  return payload;
}
