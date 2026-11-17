import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, mockProvider, waitFor } from './helpers.mjs';
import { InstalledBrowserReader, firefoxProfileBase } from '../browser-research.mjs';
import { catalogModel } from '../model-catalog.mjs';
import { normalizeModel } from '../providers.mjs';
import { WebResearch } from '../web-search.mjs';

test('four local search engines preserve preferences, parse real fixture snippets and keep pinned navigation', async () => {
  const fix = await fixture(); try {
    assert.equal(fix.app.web.status().engine, 'google');
    for (const engine of ['google', 'bing', 'yahoo', 'duckduckgo']) assert.equal((await fix.request('/api/web-search', { provider: 'browser', engine }, 'PUT')).engine, engine);
    await assert.rejects(fix.request('/api/web-search', { provider: 'browser', engine: '__proto__' }, 'PUT'), /Choose Google/);
    await fix.request('/api/web-search', { provider: 'browser', engine: 'bing' }, 'PUT'); const reopened = new WebResearch(fix.app.store); await reopened.initialize(); assert.equal(reopened.status().engine, 'bing'); await reopened.close();
    const fixtures = [
      ['google', 'www.google.com', '<div class="g"><a href="/url?q=https%3A%2F%2Fexample.net%2Fa%3Fx%3D1%26y%3D2"><h3>Google result</h3></a><div class="VwiC3b">Google snippet</div></div>', 'https://example.net/a?x=1&y=2', 'Google snippet'],
      ['yahoo', 'search.yahoo.com', '<div class="relsrch"><h3><a href="https://r.search.yahoo.com/x/RU=https%3A%2F%2Fexample.org%2Fa/RK=2/RS=x">Yahoo result</a></h3><p class="compText">Yahoo snippet</p></div>', 'https://example.org/a', 'Yahoo snippet'],
    ];
    for (const [engine, host, html, target, snippet] of fixtures) {
      await fix.request('/api/web-search', { provider: 'browser', engine }, 'PUT'); let options;
      fix.app.web.reader.read = async (url, passed) => { assert.equal(new URL(url).hostname, host); assert.equal(new URL(url).searchParams.get('q') || new URL(url).searchParams.get('p'), 'query & data'); options = passed; return { url, text: html, browser: 'Fixture' }; };
      const result = await fix.app.web.search('query & data'); assert.equal(result.sources[0].url, target); assert.equal(result.sources[0].excerpt, snippet); assert.equal(options.direct, undefined); assert.equal(result.untrusted, true);
    }
    fix.app.web.reader.read = async url => ({ url, text: '<html><body>Our systems have detected unusual traffic</body></html>' }); await assert.rejects(fix.app.web.search('challenge'), /verification challenge/);
    fix.app.web.reader.read = async url => ({ url, text: '<html><body>No results found</body></html>' }); assert.equal((await fix.app.web.search('empty')).sources.length, 0);
    assert.equal(JSON.parse(await readFile(fix.app.web.file, 'utf8')).engine, 'yahoo');
  } finally { await fix.close(); }
});

test('max effort is opt-in, accepts seven levels, persists and reaches both real Pi protocols unchanged', async () => {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(normalizeModel({ id: 'verified', reasoningConfig: { format: 'openai', levels } }).reasoningConfig.levels, levels);
  assert.deepEqual(catalogModel({ id: 'verified', reasoning_levels: levels }, 'https://example.com/v1').reasoningConfig.levels, levels);
  assert.equal(catalogModel({ id: 'unknown' }, 'https://example.com/v1').reasoningConfig, null);
  const fix = await fixture(), mock = await mockProvider(); try {
    for (const [id, api, format] of [['completions', 'openai-completions', 'openai'], ['responses', 'openai-responses', 'openai'], ['router', 'openai-completions', 'openrouter']]) {
      await fix.request('/api/providers', { id, name: id, api, baseUrl: mock.baseUrl, requiresKey: false, models: [{ id: 'test-model', contextWindow: 4096, maxTokens: 1024, reasoning: true, reasoningConfig: { format, levels } }] });
      await fix.request('/api/settings', { reasoningLevel: 'max', reasoningOverrides: { [id + '/test-model']: 'max' } }, 'PATCH');
      const chat = await fix.request('/api/chats', { selection: { provider: id, model: 'test-model' } }); await fix.request('/api/chats/' + chat.id + '/messages', { text: 'Use the documented effort.' }); await waitFor(() => !fix.app.runtime.active.has(chat.id));
      const body = mock.requests.at(-1).body; if (api === 'openai-responses' || format === 'openrouter') assert.equal(body.reasoning.effort, 'max'); else assert.equal(body.reasoning_effort, 'max');
      assert.equal(fix.app.store.settings.reasoningOverrides[id + '/test-model'], 'max');
    }
  } finally { await fix.close(); await mock.close(); }
});

test('Snap Firefox uses distinct private temporary profiles on retries and removes failed profiles', async () => {
  const selected = { family: 'firefox', name: 'Fixture Firefox', executablePath: process.execPath };
  assert.equal(firefoxProfileBase(selected, { platform: 'win32', home: '/home/test', exists: () => true }), null);
  assert.equal(firefoxProfileBase(selected, { platform: 'linux', home: '/home/test', exists: () => true }), join('/home/test', 'snap/firefox/common'));
  const base = await mkdtemp(join(tmpdir(), 'basically snap fixture ')), profiles = [];
  const reader = new InstalledBrowserReader({ browser: () => selected, profileBase: () => base, fetch: async () => { throw Error('Must not fetch'); }, launch: async options => { if (profiles.length) await assert.rejects(access(profiles.at(-1))); await access(options.userDataDir); profiles.push(options.userDataDir); throw Error(profiles.length === 1 ? 'session.new timed out' : 'fixture launch failure'); } });
  try { await assert.rejects(reader.read('https://example.com/'), /fixture launch failure/); assert.equal(profiles.length, 2); assert.notEqual(profiles[0], profiles[1]); for (const path of profiles) await assert.rejects(access(path)); assert.equal(reader.active.size, 0); }
  finally { await reader.close(); await rm(base, { recursive: true, force: true }); }
});

test('cold-start timeouts retry safely, while sandbox failures and real limits are never retried', async () => {
  const results = [];
  for (const [message, family] of [['Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!', 'chrome'], ['session.new timed out', 'firefox'], ['Failed to launch the browser process:  Code: null', 'chrome']]) {
    let launches = 0; const reader = new InstalledBrowserReader({ browser: () => ({ family, name: 'Fixture', executablePath: process.execPath }), fetch: async () => { throw Error('No page may be requested during startup'); }, launch: async () => { launches++; throw Error(message); } });
    await assert.rejects(reader.read('https://example.com/'), /WS endpoint|session\.new|Failed to launch/); results.push(launches); await reader.close();
  }
  assert.deepEqual(results, [3, 3, 1], 'startup timeouts retry up to three attempts; sandbox configuration errors fail immediately');
});

test('cancelled late browser launches are stopped before their temporary profile is deleted', async () => {
  const base = await mkdtemp(join(tmpdir(), 'basically delayed profile ')), controller = new AbortController(); let path, finish, stopped = false;
  const reader = new InstalledBrowserReader({ browser: () => ({ family: 'firefox', name: 'Fixture', executablePath: process.execPath }), profileBase: () => base, fetch: async () => { throw Error('No fetch'); }, launch: async options => { path = options.userDataDir; return new Promise(resolve => { finish = () => resolve({ close: async () => { await access(path); stopped = true; }, process: () => null }); }); } });
  try { const pending = reader.read('https://example.com/', { signal: controller.signal }); await waitFor(() => finish); controller.abort(); await assert.rejects(pending, /cancelled|timed out/); await access(path); finish(); await reader.close(); assert.equal(stopped, true); await assert.rejects(access(path)); }
  finally { await reader.close(); await rm(base, { recursive: true, force: true }); }
});
