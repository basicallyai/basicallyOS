/** User-defined connections only. No provider presets, bundled catalogs, or account flows. */
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { randomUUID } from 'node:crypto';

export const PROTOCOLS = ['openai-completions', 'openai-responses'];
const implementations = { 'openai-completions': openAICompletionsApi, 'openai-responses': openAIResponsesApi };
const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export function defaults() { return []; }
export function validateEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) API base URL without credentials, query, or fragment.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for remote APIs. HTTP is allowed only for local endpoints.');
  if (/\/(chat\/completions|responses|messages)\/?$/.test(url.pathname)) throw new Error('Enter the API base URL, not its messages/completions endpoint.');
  return url.href.replace(/\/$/, '');
}
export function normalizeModel(value, provider) {
  if (!value || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 250 || /[\s\x00-\x1f]/.test(value.id)) throw new Error('Every model needs an exact, non-empty model ID without spaces.');
  if (value.upstreamProvider != null && typeof value.upstreamProvider !== 'string') throw new Error('The upstream provider must be an exact name or endpoint tag.');
  const upstreamProvider = value.upstreamProvider?.trim() || null;
  if (upstreamProvider && (upstreamProvider.length > 120 || /[\x00-\x1f\x7f]/.test(upstreamProvider))) throw new Error('Enter an exact upstream provider name or endpoint tag (up to 120 characters).');
  const name = value.name?.trim() || value.id;
  if (name.length > 150) throw new Error('Model names must be at most 150 characters.');
  const contextWindow = value.contextWindow == null ? null : Number(value.contextWindow);
  const maxTokens = value.maxTokens == null ? null : Number(value.maxTokens);
  if (contextWindow !== null && (!Number.isInteger(contextWindow) || contextWindow < 256 || contextWindow > 10000000) || maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 10000000) || contextWindow !== null && maxTokens !== null && maxTokens > contextWindow) throw new Error('Check the model context and output token limits.');
  const cost = value.cost ?? null;
  if (cost !== null && ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => cost[key] != null && (!Number.isFinite(cost[key]) || cost[key] < 0 || cost[key] > 100000))) throw new Error('Prices must be non-negative USD amounts per million tokens.');
  for (const key of ['reasoning', 'vision', 'tools']) if (value[key] != null && typeof value[key] !== 'boolean') throw new Error('Model capabilities must be boolean values.');
  const reasoningConfig = value.reasoningConfig ?? null;
  if (reasoningConfig !== null && (!['openai', 'openrouter'].includes(reasoningConfig.format) || !Array.isArray(reasoningConfig.levels) || reasoningConfig.levels.length < 1 || reasoningConfig.levels.length > 6 || reasoningConfig.levels.some(level => !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(level)))) throw new Error('Use only documented reasoning settings for this model.');
  const metadata = value.metadata && typeof value.metadata.source === 'string' ? { source: value.metadata.source.slice(0, 2000), fetchedAt: Number(value.metadata.fetchedAt) || null, provider: String(value.metadata.provider || '').slice(0, 100), upstreamProvider: typeof value.metadata.upstreamProvider === 'string' ? value.metadata.upstreamProvider.slice(0, 120) : null, manualFields: Array.isArray(value.metadata.manualFields) ? value.metadata.manualFields.filter(field => ['modelName', 'contextWindow', 'maxTokens', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice', 'tools', 'vision', 'reasoning', 'reasoningFormat', 'reasoningLevels'].includes(field)) : [] } : null;
  const capabilities = value.capabilities ? { input: Array.isArray(value.capabilities.input) ? value.capabilities.input.filter(item => typeof item === 'string').slice(0, 12).map(item => item.slice(0, 40)) : null, output: Array.isArray(value.capabilities.output) ? value.capabilities.output.filter(item => typeof item === 'string').slice(0, 12).map(item => item.slice(0, 40)) : null, structuredOutput: typeof value.capabilities.structuredOutput === 'boolean' ? value.capabilities.structuredOutput : null } : null;
  return { id: value.id.trim(), name, upstreamProvider, contextWindow, maxTokens, metadata, capabilities, reasoningConfig: reasoningConfig ? { format: reasoningConfig.format, levels: [...new Set(reasoningConfig.levels)] } : null,
    reasoning: value.reasoning ?? false,
    vision: value.vision ?? false,
    tools: value.tools ?? false,
    cost: cost === null ? null : Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, cost[key] ?? null])) };
}
export function normalizeProvider(body, previous) {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new Error('Give this API connection a name (up to 80 characters).');
  const id = previous?.id ?? body.id ?? 'api-' + randomUUID().slice(0, 8);
  if (!/^[a-z][a-z0-9-]{0,60}$/.test(id) || id === 'local') throw new Error('Invalid provider identifier.');
  if (!PROTOCOLS.includes(body.api)) throw new Error('Choose a supported API protocol.');
  if (!Array.isArray(body.models) || body.models.length < 1 || body.models.length > 100) throw new Error('Add between 1 and 100 model IDs.');
  const models = body.models.map(model => normalizeModel(model, id));
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('Model IDs must be unique within an API connection.');
  if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || /[\r\n\x00]/.test(body.apiKey) || body.apiKey.length > 8192)) throw new Error('Enter a valid API key.');
  const baseUrl = validateEndpoint(body.baseUrl);
  if (models.some(model => model.upstreamProvider) && (new URL(baseUrl).hostname !== 'openrouter.ai' || body.api !== 'openai-completions')) throw new Error('Upstream provider routing is supported for OpenRouter Chat Completions only. For other APIs, use a separate connection with that provider’s endpoint.');
  if (previous?.apiKey && baseUrl !== previous.baseUrl && !body.apiKey?.trim() && !body.clearKey && body.requiresKey !== false) throw new Error('Re-enter your API key when changing the endpoint, or clear the saved key.');
  return { id, name: body.name.trim(), api: body.api, baseUrl, models,
    requiresKey: body.requiresKey !== false,
    apiKey: body.clearKey || body.requiresKey === false ? '' : body.apiKey?.trim() || previous?.apiKey || '', source: 'user' };
}
export function publicProvider(provider) {
  const { apiKey, ...safe } = provider;
  return { ...safe, configured: !provider.requiresKey || !!apiKey };
}
export function resolveConnection(config, selection, local) {
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') throw new Error('Choose a model. Open Settings → APIs & models to connect one.');
  const provider = selection.provider === 'local' ? local : config.providers.find(row => row.id === selection.provider);
  if (!provider) throw new Error('This API connection was removed. Choose another model.');
  if (provider.requiresKey && !provider.apiKey) throw new Error('Add your ' + provider.name + ' API key in Settings → APIs & models.');
  const saved = provider.models.find(row => row.id === selection.model);
  if (!saved) throw new Error('This model is not configured. Add its exact ID in Settings → APIs & models.');
  if (!saved.contextWindow || !saved.maxTokens) throw new Error('Context and output limits are unavailable for this model. Set verified limits in Settings → Models & connections before sending.');
  const model = { id: saved.id, name: saved.name, api: provider.api, provider: provider.id, baseUrl: provider.baseUrl,
    contextWindow: saved.contextWindow, maxTokens: saved.maxTokens, reasoning: !!saved.reasoning,
    input: saved.vision ? ['text', 'image'] : ['text'], cost: { ...emptyCost, ...Object.fromEntries(Object.entries(saved.cost || {}).map(([key, value]) => [key, value ?? 0])) },
    compat: { ...(provider.id === 'local' ? { supportsDeveloperRole: false, supportsUsageInStreaming: true } : {}) } };
  const models = createModels({ identity: { userAgent: { custom: 'basically-os/3.2.1' }, attribution: null } });
  models.setProvider(createProvider({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, models: [model],
    auth: { apiKey: { name: provider.name + ' API key', resolve: async () => ({ auth: provider.apiKey ? { apiKey: provider.apiKey } : {} }) } },
    api: implementations[provider.api]() }));
  return { models, model, saved, provider };
}
