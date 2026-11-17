import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { installedBrowsers, InstalledBrowserReader } from '../browser-research.mjs';

const bing = '<html><body><ol><li class="b_algo"><h2><a href="https://nodejs.org/api/">Node documentation</a></h2><div class="b_caption"><p>Real extracted documentation.</p></div></li></ol></body></html>';
test('installed-browser configuration needs no key, hides executable paths, preserves previous credentials inertly', async () => {
  const fix = await fixture(); try {
    const status = await fix.request('/api/web-search'); assert.equal(status.provider, 'browser'); assert.equal(status.browser, 'auto'); assert.equal(status.engine, 'google'); assert.ok(Array.isArray(status.browsers)); assert.equal(status.apiKey, undefined); assert.equal(JSON.stringify(status).includes('executablePath'), false);
    await writeFile(fix.app.web.file, JSON.stringify({ provider: 'brave', apiKey: 'keep-existing-private-key' }));
    await fix.app.web.initialize(); assert.equal(fix.app.web.status().provider, 'browser'); assert.equal(fix.app.web.config.credentials.brave, 'keep-existing-private-key');
    assert.equal(JSON.stringify(fix.app.web.status()).includes('keep-existing-private-key'), false);
    await fix.request('/api/web-search', { provider: 'browser', browser: 'auto', engine: 'duckduckgo' }, 'PUT'); assert.equal(fix.app.web.config.credentials.brave, 'keep-existing-private-key');
    await assert.rejects(fix.request('/api/web-search', { provider: 'browser', browser: 'not-installed', engine: 'bing' }, 'PUT'), /installed browser/);
    await assert.rejects(fix.request('/api/web-search', { provider: 'browser', browser: 'auto', engine: 'fake' }, 'PUT'), /Google, Bing, Yahoo or DuckDuckGo/);
  } finally { await fix.close(); }
});

test('browser search returns parsed actual links/snippets, decodes result redirects, and discloses challenges', async () => {
  const fix = await fixture(); try {
    fix.app.web.config.engine = 'bing'; let visited; fix.app.web.reader.read = async url => { visited = url; return { url, text: bing, browser: 'Fixture installed browser' }; };
    const result = await fix.app.web.search('Node docs'); assert.equal(visited, 'https://www.bing.com/search?q=Node%20docs'); assert.equal(result.sources[0].url, 'https://nodejs.org/api/'); assert.match(result.sources[0].excerpt, /Real extracted/); assert.equal(result.untrusted, true);
    fix.app.web.config.engine = 'duckduckgo'; fix.app.web.reader.read = async url => ({ url, text: '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2F">Node</a><p class="result__snippet">Snippet</p></div>', browser: 'Fixture' });
    assert.equal((await fix.app.web.search('Node')).sources[0].url, 'https://nodejs.org/');
    fix.app.web.reader.read = async url => ({ url, text: '<html><body>Verification challenge</body></html>' }); await assert.rejects(fix.app.web.search('Node'), /verification challenge/);
    fix.app.web.reader.read = async url => ({ url, text: '<html><body><div class="no-results">No results found</div></body></html>' }); assert.equal((await fix.app.web.search('No results')).sources.length, 0);
    await assert.rejects(fix.app.web.search(''), /1–500/); await assert.rejects(fix.app.web.search('x'.repeat(501)), /1–500/);
  } finally { await fix.close(); }
});

test('web permission exposes optional tools but does not force a model to browse', async () => {
  const fix = await fixture(), mock = await mockProvider(); try {
    const selection = await connect(fix, mock); let calls = 0; fix.app.web.reader.read = async () => { calls++; throw new Error('The model did not need this'); };
    const chat = await fix.request('/api/chats', { selection }); await fix.request('/api/chats/' + chat.id, { webSearch: true }, 'PATCH');
    await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Say hello; no browsing is needed' }); await waitFor(() => !fix.app.runtime.active.has(chat.id));
    assert.equal(calls, 0); assert.equal(mock.requests.length, 1); const request = mock.requests[0].body;
    assert.ok(request.tools.some(tool => tool.function.name === 'web_search')); assert.ok(request.tools.some(tool => tool.function.name === 'open_webpage')); assert.notEqual(request.tool_choice, 'required'); assert.match(JSON.stringify(request.messages), /optional permission, NOT an instruction to search/);
    const disabled = await fix.request('/api/chats', { selection }); await fix.request('/api/chats/' + disabled.id + '/messages', { text: 'Hello' }); await waitFor(() => !fix.app.runtime.active.has(disabled.id)); assert.equal(mock.requests.at(-1).body.tools.some(tool => tool.function.name === 'web_search'), false);
  } finally { await fix.close(); await mock.close(); }
});

test('real installed browsers render an isolated document while blocking scripts/subresources and private URLs', async t => {
  const browsers = await installedBrowsers(); if (!browsers.length) return t.skip('No supported OS-installed browser is available on this test machine.');
  // No live internet calls: transport supplies a fixed document to each REAL installed browser.
  for (const selected of browsers.filter(row => ['chrome', 'edge', 'firefox', 'chromium'].includes(row.id))) await t.test(selected.name, async () => {
    const visited = [], reader = new InstalledBrowserReader({ browser: () => selected, fetch: async url => { visited.push(url); return { url, type: 'text/html', text: '<html><head><script>document.body.textContent="EXECUTED"</script><meta http-equiv="refresh" content="0;url=https://127.0.0.1/"></head><body onload="this.textContent=\'EXECUTED\'"><h1>Safe document</h1><img src="https://127.0.0.1/private"><iframe src="https://127.0.0.1/private"></iframe><a href="https://example.com/next">Follow-up</a></body></html>' }; } });
    try { const page = await reader.read('https://example.com/', { signal: AbortSignal.timeout(60000) }); assert.match(page.text, /Safe document/); assert.doesNotMatch(page.text, /<script|<iframe|http-equiv/); assert.equal(page.browser, selected.name); assert.deepEqual(visited, ['https://example.com/']); assert.equal(reader.active.size, 0); await assert.rejects(reader.read('http://127.0.0.1'), /public HTTPS/); } finally { await reader.close(); }
  });
});

test('browser reader aborts without launching on a cancelled signal or missing browser', async () => {
  let launches = 0; const reader = new InstalledBrowserReader({ fetch: async () => {}, browser: () => null, launch: async () => { launches++; } });
  await assert.rejects(reader.read('https://example.com'), /No supported installed browser/); assert.equal(launches, 0);
  const browsers = await installedBrowsers(); if (browsers.length) { reader.browser = () => browsers[0]; await assert.rejects(reader.read('https://example.com', { signal: AbortSignal.abort() })); assert.equal(launches, 0); }
});
