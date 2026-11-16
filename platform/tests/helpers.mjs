import { createServer } from 'node:http';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export async function waitFor(callback, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await callback(); if (value) return value; await delay(30); }
  throw new Error('Timed out waiting for condition.');
}
export async function mockProvider() {
  const requests = [], catalogRequests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { catalogRequests.push({ auth: request.headers.authorization }); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'test-model', context_window: 128000, max_output_tokens: 1024, pricing: { unit: 'million_tokens', input: 1.5, output: 3, cacheRead: 0.15 }, capabilities: { tools: true }, modalities: { input: ['text'], output: ['text'] } }, { id: 'tools' }] })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ body, auth: request.headers.authorization, apiKeyHeader: request.headers['x-api-key'], path: request.url });
    const path = request.url.split('?')[0];
    if (path === '/v1/responses') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (type, data) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
      {
        const item = { type: 'message', id: 'msg_native', status: 'in_progress', role: 'assistant', content: [] };
        const base = { id: 'resp_native', object: 'response', model: body.model, status: 'in_progress', output: [], usage: null };
        send('response.created', { response: base });
        if (body.model === 'native-reasoning') {
          const reasoning = { type: 'reasoning', id: 'reasoning_native', summary: [] };
          send('response.output_item.added', { output_index: 1, item: reasoning });
          send('response.reasoning_summary_text.delta', { output_index: 1, item_id: reasoning.id, summary_index: 0, delta: 'Provider summary for the response.' });
          await delay(60);
          send('response.output_item.done', { output_index: 1, item: { ...reasoning, summary: [{ type: 'summary_text', text: 'Provider summary for the response.' }] } });
        }
        send('response.output_item.added', { output_index: 0, item });
        send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        const text = 'Hello from Responses.';
        send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
        send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
        const output = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        send('response.output_item.done', { output_index: 0, item: output });
        send('response.completed', { response: { ...base, status: 'completed', output: [output], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      }
      response.end(); return;
    }
    if (body.model === 'failure') { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Test key rejected', type: 'invalid_api_key' } })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta, finish = null, usage) => response.write('data: ' + JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n');
    send({ role: 'assistant', content: '' });
    if (body.model === 'slow') {
      send({ content: 'Starting ' }); const timer = setInterval(() => send({ content: 'still working ' }), 70);
      response.on('close', () => clearInterval(timer)); return;
    }
    const toolResult = body.messages.find(message => message.role === 'tool');
    if (['reasoning', 'reasoning-alt'].includes(body.model)) { send({ [body.model === 'reasoning' ? 'reasoning_content' : 'reasoning']: 'Provider-exposed reasoning for this answer.' }); await delay(350); }
    if (body.model === 'markdown-stream') {
      send({ reasoning_content: '### Provider note\n\nChecking $x^2$ and the requested **formatting**.' });
      for (const chunk of ['# Streaming answer\n\nCompleted **stable block**.\n\n', 'An inline equation $x^2$ and ', 'a second expression \\(y+1\\).\n\n', '$$\n\\sigma(x) = \\frac{1}{1 + e^{-x}}', '\n$$\n\n', '| Format | State |\n|---|---|\n| Math | Ready |\n\n', '- [x] Rendered\n- Nested list\n  - Child\n\n```js\nconst answer = 42;\n```']) { send({ content: chunk }); await delay(130); } send({}, 'stop');
    } else if (['resource-write', 'resource-read', 'managed-memory'].includes(body.model) && !toolResult) {
      const last = [...body.messages].reverse().find(row => row.role === 'user'), text = typeof last.content === 'string' ? last.content : last.content.find(block => block.type === 'text').text;
      send({ tool_calls: [{ index: 0, id: 'project-' + requests.length, type: 'function', function: { name: body.model === 'resource-write' ? 'write_resource' : body.model === 'resource-read' ? 'read_resource' : 'manage_memory', arguments: JSON.stringify(JSON.parse(text)) } }] }, 'tool_calls');
    } else if (body.model === 'research-flow') {
      const results = body.messages.filter(row => row.role === 'tool'), parse = row => JSON.parse(typeof row.content === 'string' ? row.content : row.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
      const call = (name, args) => send({ tool_calls: [{ index: 0, id: 'web-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
      if (!body.tools?.some(row => row.function.name === 'web_search')) send({ content: 'Web access is disabled.' }, 'stop');
      else if (!results.length) call('web_search', { query: 'current documentation' });
      else if (results.length === 1) call('open_webpage', { url: parse(results[0]).sources[0].url });
      else if (results.length === 2) call('open_webpage', { url: parse(results[1]).links[0].url });
      else send({ content: 'Verified sources: [First](' + parse(results[1]).url + ') and [Follow-up](' + parse(results[2]).url + ').' }, 'stop');
    } else if (body.model === 'document-flow') {
      const results = body.messages.filter(row => row.role === 'tool'), parse = row => JSON.parse(typeof row.content === 'string' ? row.content : row.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
      const call = (name, args) => send({ tool_calls: [{ index: 0, id: 'doc-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
      if (!results.length) call('create_canvas', { title: 'Training', content: '# Training\n\nInitial plan' });
      else if (results.length === 1) call('create_canvas', { title: 'Architecture', content: '# Architecture\n\nIndependent design' });
      else if (results.length === 2) { const first = parse(results[0]); call('edit_canvas', { canvasId: first.canvasId, revision: first.revision, content: '# Training\n\nRevised plan' }); }
      else if (results.length === 3) call('save_canvas_to_notes', { canvasId: parse(results[0]).canvasId });
      else send({ content: 'Finished. Sources are the actual documents.' }, 'stop');
    } else if (body.model === 'note-canvas') {
      const results = body.messages.filter(message => message.role === 'tool'), toolText = message => typeof message.content === 'string' ? message.content : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join(String.fromCharCode(10));
      const call = (name, args) => send({ tool_calls: [{ index: 0, id: 'note-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
      if (!results.length) { const last = [...body.messages].reverse().find(message => message.role === 'user'); call('find_notes', { query: toolText(last) }); }
      else if (results.length === 1) { const found = JSON.parse(toolText(results[0])); call('open_note', { noteId: found.matches[0].noteId }); }
      else if (results.length === 2) { const opened = JSON.parse(toolText(results[1])); call('read_resource', { workspaceId: opened.workspaceId, path: opened.path }); }
      else if (results.length === 3) { const read = JSON.parse(toolText(results[2])); call('edit_resource', { workspaceId: read.workspaceId, path: read.path, revision: read.revision, find: 'Tokenization decisions', replace: 'Tokenization decisions (updated by AI)\n\n$$\n\\sigma(x) = \\frac{1}{1 + e^{-x}}\n$$' }); }
      else send({ content: 'Updated the note in Canvas.' }, 'stop');
    } else if (body.model === 'memory' && !toolResult) {
      const last = [...body.messages].reverse().find(row => row.role === 'user');
      send({ tool_calls: [{ index: 0, id: 'memory-' + requests.length, type: 'function', function: { name: 'write_memory', arguments: JSON.stringify(JSON.parse(typeof last.content === 'string' ? last.content : last.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))) } }] }, 'tool_calls');
    } else if (['tools', 'loop'].includes(body.model) && (!toolResult || body.model === 'loop')) {
      send({ tool_calls: [{ index: 0, id: 'call-' + requests.length, type: 'function', function: { name: body.model === 'loop' ? 'list_files' : 'write_file', arguments: JSON.stringify(body.model === 'loop' ? { path: '.' } : { path: 'result.txt', content: 'Approved file contents' }) } }] }, 'tool_calls');
    } else send({ content: toolResult ? 'Finished the approved workflow.' : 'Hello **from Pi**. <img src=x onerror="window.pwned=1"><script>window.pwned=1</script>' }, 'stop');
    if (body.model !== 'no-usage') send({}, null, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...(body.model === 'reported' ? { cost: .0123, is_byok: false } : {}) });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  return { requests, catalogRequests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, async close() { server.closeAllConnections(); await new Promise(accept => server.close(accept)); } };
}
export async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'basically-pi-'));
  await symlink(resolve(projectRoot, 'platform'), join(directory, 'platform'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(resolve(projectRoot, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const local = { request: async () => ({ phase: 'idle', model: null, models: [], root: join(directory, 'local-models'), backends: {} }), close: async () => {}, connection: async () => { throw new Error('Load a model first.'); } };
  const app = await createApp({ root: directory, home: join(directory, 'home'), port: 0, local, ...options });
  const login = await fetch(app.url, { redirect: 'manual' }), cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.address + path, { method, headers: { Cookie: cookie, Origin: app.address, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok) throw new Error(response.status + ': ' + data.error); return data;
  };
  return { app, directory, cookie, request, async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
export async function connect(fix, mock, { id = 'test', model = 'test-model', cost = { input: 1, output: 2, cacheRead: .1, cacheWrite: 1 } } = {}) {
  await fix.request('/api/providers', { id, name: 'Test API', api: 'openai-completions', baseUrl: mock.baseUrl, apiKey: 'test-private-key', requiresKey: true,
    models: [{ id: model, name: 'Test model', contextWindow: 128000, maxTokens: 1024, tools: true, vision: false, cost }] });
  return { provider: id, model };
}
