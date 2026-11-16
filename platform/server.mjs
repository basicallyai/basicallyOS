import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, atomicJson } from './store.mjs';
import { Runtime } from './runtime.mjs';
import { LocalWorker } from './local-worker.mjs';
import { normalizeProvider, publicProvider, validateEndpoint, PROTOCOLS } from './providers.mjs';
import { createModelCatalog } from './model-catalog.mjs';
import { workspacePath } from './tools.mjs';
import { iconSprite } from './icons.mjs';
import { exportChats, importChats } from './exchange.mjs';
import { receiveModel } from './model-upload.mjs';
import { Resources } from './resources.mjs';
import { Memories } from './memories.mjs';
import { Notes } from './notes.mjs';
import { Canvases } from './canvases.mjs';
import { WebResearch } from './web-search.mjs';
import { resourceRoutes } from './resource-routes.mjs';
import { createFolderPicker } from './folder-picker.mjs';

const rootDefault = fileURLToPath(new URL('../', import.meta.url));
const secureEqual = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const HttpError = class extends Error { constructor(status, message) { super(message); this.status = status; } };
export async function readBody(request, limit = 9 * 1024 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Send application/json.');
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Request is too large.'); chunks.push(chunk); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'Send a JSON object.'); }
}
export async function createApp({ root = rootDefault, home = resolve(root, '.platform-home'), workspaceRoot = resolve(root, 'workspaces'), modelDirectory = resolve(root, 'local-models'), port = 3080, host = '127.0.0.1', local: suppliedLocal, connectionResolver, folderPicker: suppliedFolderPicker } = {}) {
  if (host !== '127.0.0.1') throw new Error('The app must bind to IPv4 loopback.');
  const store = new Store(home); await store.initialize();
  if (store.config.version < 2) {
    await atomicJson(join(store.directory, 'connections.pre-user-models.json'), store.config);
    // Retire every old preset. Keep explicitly-created custom connections, never guessed catalog rows.
    const providers = store.config.providers.filter(provider => PROTOCOLS.includes(provider.api) && (provider.source === 'user' || provider.id.startsWith('api-')));
    const selection = store.config.defaultModel;
    await store.saveConfig({ version: 2, initialized: true, providers, defaultModel: providers.some(provider => provider.id === selection?.provider && provider.models.some(model => model.id === selection.model)) ? selection : null });
  }
  const local = suppliedLocal ?? new LocalWorker(root, home, modelDirectory), folderPicker = suppliedFolderPicker ?? createFolderPicker(), clients = new Set();
  const publish = (chatId, type, data) => {
    const frame = 'data: ' + JSON.stringify({ chatId, type, data }) + '\n\n';
    for (const client of clients) {
      if (client.writableLength > 1024 * 1024) client.destroy();
      else client.write(frame);
    }
  };
  const resources = new Resources(store, publish); await resources.initialize();
  const memories = new Memories(store, resources, publish); await memories.initialize();
  const notes = new Notes(resources); await notes.initialize();
  const runtime = new Runtime({ root, workspaceRoot, store, local, publish, connectionResolver, resources, memories, notes });
  const canvases = new Canvases({ store, resources, notes, runtime, publish }); runtime.canvases = canvases; notes.canvases = canvases;
  const web = new WebResearch(store); await web.initialize(); runtime.web = web;
  let uploadingModel = false, uploadRequest, uploadTask;
  const launchToken = randomBytes(32).toString('base64url'), sessionToken = randomBytes(32).toString('base64url');
  const cookieName = 'basically_session';
  const staticFiles = new Map([
    ['/', ['platform/web/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['platform/web/app.js', 'text/javascript; charset=utf-8']],
    ['/theme.css', ['platform/web/theme.css', 'text/css; charset=utf-8']],
    ['/knowledge.css', ['platform/web/knowledge.css', 'text/css; charset=utf-8']],
    ['/layout.css', ['platform/web/layout.css', 'text/css; charset=utf-8']],
    ['/workspace.css', ['platform/web/workspace.css', 'text/css; charset=utf-8']],
    ['/vendor/editor.js', ['platform/web/vendor/editor.js', 'text/javascript; charset=utf-8']],
    ['/vendor/EDITOR-LICENSES.txt', ['platform/web/vendor/EDITOR-LICENSES.txt', 'text/plain; charset=utf-8']],
    ...['copy-button.js', 'code-display.js', 'file-preview.js'].map(name => ['/' + name, ['platform/web/' + name, 'text/javascript; charset=utf-8']]),
    ['/vendor/katex.mjs', [fileURLToPath(import.meta.resolve('katex')), 'text/javascript; charset=utf-8']],
    ['/vendor/katex.css', [fileURLToPath(new URL('./katex.min.css', import.meta.resolve('katex'))), 'text/css; charset=utf-8']],
    ...['markdown.js', 'math.js', 'render-dom.js', 'stream-state.js', 'tool-output.js', 'model-editor.js', 'model-picker.js', 'split-layout.js', 'wiki.js', 'note-names.js', 'canvas.js', 'knowledge.js', 'memory-ui.js', 'editor-text.js'].map(name => ['/' + name, ['platform/web/' + name, 'text/javascript; charset=utf-8']]),
    ['/vendor/highlight.js', [fileURLToPath(import.meta.resolve('@highlightjs/cdn-assets/highlight.min.js')), 'text/javascript; charset=utf-8']],
    ['/brand-mark.svg', ['platform/assets/brand-mark.svg', 'image/svg+xml']],
    ['/dm-sans.ttf', ['platform/assets/dm-sans.ttf', 'font/ttf']],
    ['/space-mono.ttf', ['platform/assets/space-mono.ttf', 'font/ttf']],
    ['/vendor/marked.js', [fileURLToPath(import.meta.resolve('marked')), 'text/javascript; charset=utf-8']],
    ['/vendor/purify.js', [fileURLToPath(import.meta.resolve('dompurify')), 'text/javascript; charset=utf-8']],
  ]);
  for (const font of await readdir(fileURLToPath(new URL('./fonts/', import.meta.resolve('katex'))))) if (/^KaTeX_[\w-]+\.(woff2?|ttf)$/.test(font)) staticFiles.set('/vendor/fonts/' + font, [fileURLToPath(new URL('./fonts/' + font, import.meta.resolve('katex'))), font.endsWith('woff2') ? 'font/woff2' : font.endsWith('woff') ? 'font/woff' : 'font/ttf']);
  const json = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
  const resourcesRoute = resourceRoutes(resources, memories, { readBody, json });
  const catalog = createModelCatalog();
  const connectionState = () => ({ providers: store.config.providers.map(publicProvider), defaultModel: store.config.defaultModel });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:;  connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const boundPort = server.address()?.port;
      if (![`${host}:${boundPort}`, `localhost:${boundPort}`].includes(request.headers.host)) throw new HttpError(403, 'Untrusted Host header.');
      const origin = 'http://' + request.headers.host;
      if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, 'Cross-origin requests are not allowed.');
      const url = new URL(request.url, origin), path = url.pathname, method = request.method;
      if (path === '/' && method === 'GET' && url.searchParams.has('token')) {
        if (!secureEqual(url.searchParams.get('token'), launchToken)) throw new HttpError(401, 'This launch link is no longer valid. Open the link printed by npm start.');
        // Commit a first-party document, not a cross-site redirect chain that can drop Strict cookies.
        const html = await readFile(resolve(root, 'platform/web/index.html'));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/` }); response.end(html); return;
      }
      if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw new HttpError(403, 'Open the app directly on this computer.');
      const cookie = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      if (!secureEqual(cookie, sessionToken)) throw new HttpError(401, 'Open the authenticated local link printed by npm start.');
      if (!['GET', 'HEAD'].includes(method) && request.headers.origin !== origin) throw new HttpError(403, 'A same-origin request is required.');
      if (path === '/api/bootstrap' && method === 'GET') return json(response, { ...connectionState(), settings: store.settings,
        engine: { name: 'Pi Agent', version: '1.5.2' }, localModelDirectory: modelDirectory,
        localSetup: { script: resolve(root, 'platform/setup_models.py'), environment: resolve(home, 'runtime') } });
      if (path === '/api/events' && method === 'GET') {
        if (clients.size >= 20) throw new HttpError(429, 'Too many open app windows.');
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(': connected\n\n'); clients.add(response);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20000);
        response.once('close', () => { clearInterval(heartbeat); clients.delete(response); }); return;
      }
      if (path === '/api/web-search' && method === 'GET') return json(response, web.status());
      if (path === '/api/web-search' && method === 'PUT') return json(response, await web.configure(await readBody(request, 10000)));
      if (path === '/api/notes/import' && method === 'POST') return json(response, await notes.importFiles((await readBody(request, 18 * 1024 ** 2)).files));
      let documentMatch = path.match(/^\/api\/chats\/([a-f0-9-]{36})\/canvases(?:\/([a-f0-9-]{36})(?:\/(notes|history|restore|state))?)?$/);
      if (documentMatch) {
        const [, id, canvasId, action] = documentMatch, chat = await canvases.chat(id); await canvases.migrate(chat);
        if (method === 'GET') { if (!canvasId) return json(response, { canvases: await canvases.list(chat) }); const row = canvases.row(chat, canvasId); return json(response, action === 'history' ? { history: row.noteId ? await (async () => { const file = await notes.byId(row.noteId); return (await resources.history()).filter(item => item.refs.some(ref => ref.workspaceId === file.workspaceId && ref.path === file.path)); })() : (row.history || []).map(({ content, generatedMath, ...entry }) => entry) } : await canvases.current(row)); }
        if (action === 'state' && method === 'PUT') return json(response, await canvases.setUI(chat, canvasId, await readBody(request)));
        if (runtime.active.has(id) || runtime.reserved.has(id)) throw new Error('Wait for the response to finish before editing Canvas.');
        const body = await readBody(request);
        if (!canvasId && method === 'POST') return json(response, await canvases.create(chat, body), 201);
        if (action === 'restore' && method === 'POST') { const row = canvases.row(chat, canvasId); if (row.noteId) throw new Error('Use Notes file history to undo a linked note.'); const snapshot = row.history?.find(item => item.revision === body.historyRevision); if (!snapshot) throw new Error('That revision is no longer retained.'); return json(response, await canvases.update(chat, canvasId, { revision: body.revision, content: snapshot.content, title: snapshot.title })); }
        if (action === 'notes' && method === 'POST') return json(response, await canvases.saveToNotes(chat, canvasId));
        if (canvasId && method === 'PATCH') return json(response, await canvases.update(chat, canvasId, body));
      }
      if (path === '/api/workspaces/browse' && method === 'POST') return json(response, await folderPicker.pick());
      if (await resourcesRoute(request, response, url)) return;
      if (path === '/icons.svg' && method === 'GET') { response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); response.end(iconSprite); return; }
      if (path === '/api/memory' && method === 'GET') return json(response, { ...await store.memory(), path: store.memoryPath });
      if (path === '/api/memory' && method === 'PUT') { const result = await store.saveMemory(await readBody(request, 400000)); publish(null, 'memory'); return json(response, result); }
      if (path === '/api/chats/import' && method === 'POST') return json(response, await importChats(runtime, await readBody(request, 96 * 1024 * 1024)), 201);
      if (path === '/api/chats/export' && method === 'GET') {
        const backup = await exportChats(runtime);
        response.setHeader('Content-Disposition', 'attachment; filename="basically-os-chats.json"'); return json(response, backup);
      }
      if (path === '/api/local/upload' && method === 'POST') {
        if (uploadingModel) throw new HttpError(409, 'Another local model import is in progress.');
        uploadingModel = true;
        try { uploadRequest = request; uploadTask = receiveModel(request, modelDirectory); const result = await uploadTask; return json(response, result, 201); }
        finally { uploadingModel = false; uploadRequest = undefined; uploadTask = undefined; }
      }
      if (path === '/api/settings' && method === 'PATCH') return json(response, await store.saveSettings(await readBody(request, 100000)));
      if (path === '/api/providers/metadata' && method === 'POST') {
        const body = await readBody(request, 20000), baseUrl = validateEndpoint(body.baseUrl), saved = store.config.providers.find(row => row.id === body.providerId);
        if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || /[\r\n\x00]/.test(body.apiKey) || body.apiKey.length > 8192)) throw new Error('Enter a valid API key.');
        const apiKey = body.requiresKey === false ? '' : body.apiKey?.trim() || (saved?.baseUrl === baseUrl ? saved.apiKey : '') || '';
        const result = await catalog({ baseUrl, apiKey }, { refresh: body.refresh === true, modelId: body.modelId, upstreamProvider: body.upstreamProvider });
        return json(response, { fetchedAt: result.fetchedAt, expiresAt: result.expiresAt, model: result.models.find(row => row.id === body.modelId) || null, status: result.models.some(row => row.id === body.modelId) ? 'found' : 'unknown' });
      }
      if (path === '/api/providers/discover' && method === 'POST') {
        const body = await readBody(request, 20000), baseUrl = validateEndpoint(body.baseUrl);
        if (typeof body.apiKey !== 'string' || /[\r\n\x00]/.test(body.apiKey) || body.apiKey.length > 8192) throw new Error('Enter a valid API key.');
        return json(response, await catalog({ baseUrl, apiKey: body.apiKey.trim() }, { refresh: body.refresh === true }));
      }
      if (path === '/api/providers' && method === 'POST') {
        const body = await readBody(request, 500000);
        await store.updateConfig(config => {
          const previous = config.providers.find(provider => provider.id === body.id);
          const provider = normalizeProvider(body, previous);
          if (!previous && config.providers.length >= 32) throw new Error('At most 32 API connections are supported.');
          config.providers = previous ? config.providers.map(row => row.id === provider.id ? provider : row) : [...config.providers, provider];
          if (config.defaultModel?.provider === provider.id && !provider.models.some(model => model.id === config.defaultModel.model)) config.defaultModel = null;
          if (!config.defaultModel && (!provider.requiresKey || provider.apiKey)) config.defaultModel = { provider: provider.id, model: provider.models[0].id };
          return config;
        });
        publish(null, 'connections'); return json(response, connectionState());
      }
      let match;
      if ((match = path.match(/^\/api\/providers\/([a-z0-9-]+)$/)) && method === 'DELETE') {
        await store.updateConfig(config => {
          config.providers = config.providers.filter(provider => provider.id !== match[1]);
          if (config.defaultModel?.provider === match[1]) config.defaultModel = null; return config;
        });
        publish(null, 'connections'); return json(response, connectionState());
      }
      if ((match = path.match(/^\/api\/providers\/([a-z0-9-]+)\/discover$/)) && method === 'POST') {
        await readBody(request, 1000);
        const provider = store.config.providers.find(row => row.id === match[1]);
        if (!provider) throw new HttpError(404, 'API connection not found.');
        if (provider.requiresKey && !provider.apiKey) throw new Error('Save an API key before fetching models.');
        return json(response, await catalog(provider));
      }
      if (path === '/api/default-model' && method === 'POST') {
        const { selection } = await readBody(request, 5000); runtime.validateSelection(selection);
        await store.updateConfig(config => ({ ...config, defaultModel: selection })); publish(null, 'connections'); return json(response, connectionState());
      }
      if (path === '/api/chats' && method === 'GET') return json(response, { chats: await runtime.list((url.searchParams.get('q') || '').slice(0, 500), url.searchParams.get('archived') === '1') });
      if (path === '/api/chats' && method === 'POST') {
        const { selection, workspaceIds = [], surface = 'chat' } = await readBody(request, 10000); if (selection) runtime.validateSelection(selection);
        if (!Array.isArray(workspaceIds) || workspaceIds.length > 33 || !['chat', 'notes'].includes(surface)) throw new Error('Invalid conversation workspace.'); workspaceIds.forEach(id => resources.get(id));
        const chat = await store.createChat(selection, { workspaceIds, surface }); publish(chat.id, 'changed'); return json(response, await runtime.view(chat.id), 201);
      }
      if ((match = path.match(/^\/api\/chats\/([a-f0-9-]{36})$/))) {
        if (method === 'DELETE') { await runtime.remove(match[1]); return json(response, { deleted: true }); }
        if (method === 'GET') return json(response, await runtime.view(match[1]));
        if (method === 'PATCH') return json(response, await runtime.change(match[1], await readBody(request, 50000)));
      }
      if ((match = path.match(/^\/api\/chats\/([a-f0-9-]{36})\/export$/)) && method === 'GET') {
        const backup = await exportChats(runtime, match[1]);
        response.setHeader('Content-Disposition', 'attachment; filename="basically-os-conversation.json"'); return json(response, backup);
      }
      if ((match = path.match(/^\/api\/chats\/([a-f0-9-]{36})\/(messages|regenerate|stop|approve)$/)) && method === 'POST') {
        const [, id, action] = match, body = await readBody(request);
        if (action === 'stop') { await runtime.stop(id); return json(response, await runtime.view(id)); }
        if (action === 'approve') { runtime.approve(id, body.id, body.allow); return json(response, { ok: true }); }
        if (runtime.active.size >= 4) throw new HttpError(429, 'Four conversations are already running. Stop one or wait for it to finish.');
        return json(response, await runtime.start(id, body, action === 'regenerate'), 202);
      }
      if ((match = path.match(/^\/api\/chats\/([a-f0-9-]{36})\/workspace$/)) && method === 'GET') {
        await runtime.get(match[1]); const folder = url.searchParams.get('path') || '.';
        const directory = await workspacePath(resolve(workspaceRoot, match[1]), folder);
        const rows = await readdir(directory, { withFileTypes: true });
        return json(response, { files: rows.filter(row => !row.isSymbolicLink()).slice(0, 400).map(row => ({ name: row.name, directory: row.isDirectory(), path: folder === '.' ? row.name : folder + '/' + row.name })) });
      }
      if ((match = path.match(/^\/api\/chats\/([a-f0-9-]{36})\/files$/)) && method === 'GET') {
        await runtime.get(match[1]);
        const file = await workspacePath(resolve(workspaceRoot, match[1]), url.searchParams.get('path'));
        const info = await stat(file); if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('Download must be a file smaller than 20 MB.');
        if (url.searchParams.get('preview') === '1') {
          const data = await readFile(file); if (data.includes(0)) throw new Error('Binary file. Use Download to get the original.');
          let content; try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new Error('This file is not valid UTF-8. Download the original instead.'); }
          return json(response, { name: basename(file), content, bytes: data.length });
        }
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(basename(file)) }); response.end(await readFile(file)); return;
      }
      if ((match = path.match(/^\/api\/local\/(status|load|unload|settings|name)$/))) {
        if (method === 'GET' && match[1] === 'status') return json(response, await local.request('/status' + (url.searchParams.get('refresh') === '1' ? '?refresh=1' : '')));
        if (method === 'POST' && ['load', 'unload', 'settings', 'name'].includes(match[1])) {
          const body = await readBody(request, 10000);
          return json(response, await local.request('/' + match[1], body));
        }
      }
      const entry = staticFiles.get(path);
      if (entry && (method === 'GET' || method === 'HEAD')) {
        response.writeHead(200, { 'Content-Type': entry[1] }); response.end(method === 'HEAD' ? undefined : await readFile(resolve(root, entry[0]))); return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      let message = error.message || 'The request failed.';
      for (const provider of store.config.providers) if (provider.apiKey) message = message.replaceAll(provider.apiKey, '[redacted]');
      json(response, { error: message }, error.status ?? 400);
    }
  });
  // Multi-gigabyte loopback model uploads may take longer than Node's five-minute default.
  server.requestTimeout = 24 * 60 * 60 * 1000; server.headersTimeout = 30000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, accept); });
  const address = `http://${host}:${server.address().port}`;
  let closing;
  return { server, store, runtime, local, folderPicker, resources, memories, notes, canvases, web, address, url: address + '/?token=' + launchToken,
    close() {
      return closing ||= (async () => {
        uploadRequest?.destroy(); await uploadTask?.catch(() => {});
        await runtime.close(); await web.close(); await resources.close(); await memories.close(); for (const client of clients) client.end();
        const closed = new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
        server.closeIdleConnections(); await closed; await local.close();
      })();
    } };
}
