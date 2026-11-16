import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, mockProvider, connect, waitFor } from './helpers.mjs';
import { WebResearch } from '../web-search.mjs';

test('search method and separate provider keys persist without losing local settings or exposing secrets', async () => {
  const fix = await fixture(); try {
    await fix.request('/api/web-search', { provider: 'browser', browser: 'auto', engine: 'duckduckgo' }, 'PUT');
    await fix.request('/api/web-search', { provider: 'brave', apiKey: 'private-brave-key' }, 'PUT');
    await fix.request('/api/web-search', { provider: 'tavily', apiKey: 'private-tavily-key' }, 'PUT');
    let status = await fix.request('/api/web-search'); assert.equal(status.provider, 'tavily'); assert.equal(status.configured, true); assert.equal(status.engine, 'duckduckgo'); assert.deepEqual(status.apiConfigured, { brave: true, tavily: true });
    const reopened = new WebResearch(fix.app.store); await reopened.initialize(); assert.equal(reopened.status().provider, 'tavily'); assert.equal(reopened.config.credentials.tavily, 'private-tavily-key'); await reopened.close();
    await fix.request('/api/web-search', { provider: 'brave' }, 'PUT'); assert.equal(fix.app.web.config.credentials.brave, 'private-brave-key');
    await fix.request('/api/web-search', { provider: 'browser' }, 'PUT'); status = await fix.request('/api/web-search'); assert.equal(status.provider, 'browser'); assert.equal(status.engine, 'duckduckgo'); assert.equal(status.apiProvider, 'brave'); assert.deepEqual(status.apiConfigured, { brave: true, tavily: true });
    assert.doesNotMatch(JSON.stringify(status), /private-brave-key|private-tavily-key|credentials|executablePath/); assert.doesNotMatch(JSON.stringify(await fix.request('/api/bootstrap')), /private-brave-key|private-tavily-key/);
    const stored = JSON.parse(await readFile(fix.app.web.file, 'utf8')); assert.equal(stored.schemaVersion, 2); assert.equal(stored.credentials.brave, 'private-brave-key'); assert.equal(stored.credentials.tavily, 'private-tavily-key');
  } finally { await fix.close(); }
});

test('API routing uses only the selected provider key and works without any installed browser', async () => {
  const fix = await fixture(); try {
    const requests = []; fix.app.web.browsers = []; fix.app.web.reader.read = async () => { throw new Error('An API search must not launch a browser'); };
    fix.app.web.transport = async (url, options) => { requests.push({ url, options }); return url.includes('api.search.brave.com') ? { text: JSON.stringify({ web: { results: [{ title: 'Brave result', url: 'https://example.com/brave', description: 'Actual fixture snippet' }] } }) } : url.includes('api.tavily.com') ? { text: JSON.stringify({ results: [{ title: 'Tavily result', url: 'https://example.com/tavily', content: 'Actual Tavily fixture snippet' }] }) } : { url, type: 'text/html', text: '<html><head><title>Opened source</title></head><body><p>Readable actual source.</p><script>doNotExecute()</script></body></html>' }; };
    await fix.request('/api/web-search', { provider: 'brave', apiKey: 'brave-only-key' }, 'PUT'); assert.equal((await fix.request('/api/web-search')).configured, true);
    assert.equal((await fix.app.web.search('Brave query')).sources[0].url, 'https://example.com/brave'); assert.equal(requests[0].options.headers['X-Subscription-Token'], 'brave-only-key');
    await fix.request('/api/web-search', { provider: 'tavily', apiKey: 'tavily-only-key' }, 'PUT');
    assert.equal((await fix.app.web.search('Tavily query')).sources[0].url, 'https://example.com/tavily'); assert.equal(requests[1].options.headers.Authorization, 'Bearer tavily-only-key'); assert.equal(JSON.parse(requests[1].options.body).query, 'Tavily query'); assert.equal(JSON.stringify(requests[1]).includes('brave-only-key'), false);
    const page = await fix.app.web.open('https://example.com/tavily'); assert.match(page.content, /Readable actual source/); assert.doesNotMatch(page.content, /doNotExecute/);
    await fix.request('/api/web-search', { provider: 'tavily', clearKey: true }, 'PUT'); assert.equal((await fix.request('/api/web-search')).configured, false); const count = requests.length;
    await assert.rejects(fix.app.web.search('Missing key'), /No API search was performed/); assert.equal(requests.length, count); assert.equal(fix.app.web.config.credentials.brave, 'brave-only-key');
    await fix.request('/api/web-search', { provider: 'browser' }, 'PUT'); await assert.rejects(fix.app.web.search('Unavailable local browser'), /must not launch|No supported installed browser/); assert.equal(requests.length, count, 'Local search never falls back to the saved paid API');
  } finally { await fix.close(); }
});

test('API mode keeps model web access optional rather than forcing an external search', async () => {
  const fix = await fixture(), mock = await mockProvider(); try {
    const selection = await connect(fix, mock); await fix.request('/api/web-search', { provider: 'brave', apiKey: 'unused-private-search-key' }, 'PUT'); let searches = 0;
    fix.app.web.transport = async () => { searches++; throw new Error('No search is needed for this response'); };
    const chat = await fix.request('/api/chats', { selection }); await fix.request('/api/chats/' + chat.id, { webSearch: true }, 'PATCH'); await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Say hello without searching' }); await waitFor(() => !fix.app.runtime.active.has(chat.id));
    assert.equal(searches, 0); assert.equal(mock.requests.length, 1); assert.ok(mock.requests[0].body.tools.some(row => row.function.name === 'web_search')); assert.notEqual(mock.requests[0].body.tool_choice, 'required'); assert.equal(JSON.stringify(mock.requests[0]).includes('unused-private-search-key'), false);
  } finally { await fix.close(); await mock.close(); }
});

test('concurrent settings updates preserve both keys, and invalid settings never mutate stored configuration', async () => {
  const fix = await fixture(); try {
    await Promise.all([fix.request('/api/web-search', { provider: 'brave', apiKey: 'concurrent-brave' }, 'PUT'), fix.request('/api/web-search', { provider: 'tavily', apiKey: 'concurrent-tavily' }, 'PUT')]);
    assert.deepEqual(fix.app.web.status().apiConfigured, { brave: true, tavily: true }); const before = await readFile(fix.app.web.file, 'utf8');
    for (const body of [{ provider: 'unknown' }, { provider: 'brave', apiKey: 'invalid\nkey' }, { provider: 'tavily', apiKey: 'replace', clearKey: true }, { provider: 'browser', apiKey: 'wrong place' }, { provider: 'brave', clearKey: 'yes' }]) await assert.rejects(fix.request('/api/web-search', body, 'PUT'));
    assert.equal(await readFile(fix.app.web.file, 'utf8'), before);
    await fix.request('/api/web-search', { provider: 'brave', clearKey: true }, 'PUT'); assert.deepEqual(fix.app.web.status().apiConfigured, { brave: false, tavily: true }); assert.doesNotMatch(await readFile(fix.app.web.file, 'utf8'), /concurrent-brave/);
  } finally { await fix.close(); }
});
