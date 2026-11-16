import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixture, mockProvider, waitFor } from './tests/helpers.mjs';
const mock = await mockProvider(), calls = [];
let localState = { phase: 'idle', model: null, displayName: null, root: 'fixture-local-models', trustRemoteCode: true, contextWindow: 4096, maxTokens: 1024, promptFormat: 'plain-text', models: [{ id: 'folder-id', name: 'folder-id', bytes: 20000, format: 'transformers', customCode: true, available: true, problem: null }] };
const local = { async request(path, body) {
  calls.push({ path, body });
  if (path === '/name') { localState.models[0].name = body.name; if (localState.model) localState.displayName = body.name; }
  if (path === '/load') { localState.phase = 'ready'; localState.model = body.id; localState.displayName = localState.models[0].name; localState.trustRemoteCode = body.trust; }
  if (path === '/unload') { localState.phase = 'idle'; localState.model = null; }
  return structuredClone(localState);
}, async connection() { return { id: 'local', name: 'Local', api: 'openai-completions', baseUrl: mock.baseUrl, requiresKey: true, apiKey: 'fixture-key', models: [{ id: 'local-model', name: localState.displayName, contextWindow: 4096, maxTokens: 1024, tools: false, cost: null }] }; }, async close() {} };
const fix = await fixture({ local }), browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1400, height: 960 } }), page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await fix.request('/api/providers', { id: 'api', name: 'Fixture API', api: 'openai-completions', baseUrl: mock.baseUrl, requiresKey: false, models: [{ id: 'test-model', name: 'Named API', contextWindow: 4096, maxTokens: 1024 }] });
  await page.goto(fix.app.url); await page.locator('#open-local').click(); await page.locator('[name=trustRemoteCode]').waitFor();
  assert.equal(await page.locator('[name=trustRemoteCode]').isChecked(), true);
  let confirmations = 0; page.on('dialog', async dialog => { confirmations++; assert.match(dialog.message(), /execute repository Python/); await dialog.accept(); });
  await page.getByRole('button', { name: 'Rename', exact: true }).click(); await page.getByLabel('Local model display name', { exact: true }).fill('My small local model'); await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.locator('.local-model-row strong').filter({ hasText: 'My small local model' }).waitFor(); assert.equal(localState.models[0].id, 'folder-id');
  await page.getByRole('button', { name: 'Load model', exact: true }).click(); await page.getByRole('button', { name: 'Use this model', exact: true }).waitFor();
  assert.equal(confirmations, 1); assert.equal(calls.find(row => row.path === '/load').body.trust, true);
  assert.match(await page.locator('#settings-content').textContent(), /generic System \/ User \/ Assistant/);
  await page.getByRole('button', { name: 'Use this model', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#model-label').textContent === 'My small local model');
  await page.locator('.composer-rich .tiptap').fill('Hello from the local model.'); await page.locator('#send').click();
  const speed = page.locator('#messages .assistant-message .response-speed'); await speed.waitFor(); await waitFor(async () => /\d+\.\d tok\/s/.test(await speed.textContent()));
  assert.match(await speed.getAttribute('title'), /request-to-completion/); assert.equal(await page.locator('#messages .assistant-heading small').textContent(), 'My small local model');
  await page.locator('#messages .assistant-message .raw-copy').click(); const copied = await page.evaluate(() => navigator.clipboard.readText()); assert.doesNotMatch(copied, /tok\/s/);
  await waitFor(() => !fix.app.runtime.active.size);
  await page.reload(); await speed.waitFor(); assert.equal(await page.locator('#model-label').textContent(), 'My small local model');
  await page.screenshot({ path: 'platform/logs/local-model-response.png' });
  await page.locator('#open-local').click(); await page.getByRole('button', { name: 'Rename', exact: true }).click(); await page.getByLabel('Local model display name', { exact: true }).fill('Renamed local model'); await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#model-label').textContent === 'Renamed local model'); await page.locator('#settings-dialog [data-close]').click(); assert.equal(await page.locator('#messages .assistant-heading small').textContent(), 'My small local model', 'response keeps its historical configured name');
  await page.locator('#model-button').click(); assert.equal(await page.locator('#model-menu .model-option[data-model-id="local-model"]').innerText(), 'Renamed local model'); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 380, height: 800 }); assert.equal(await page.locator('.response-footer').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true); await page.screenshot({ path: 'platform/logs/local-model-response-mobile.png' });
  const stored = (await fix.app.store.list()).find(row => row.selection?.provider === 'local'); stored.messages.find(row => row.role === 'assistant').content = []; await fix.app.store.saveChat(stored);
  await page.reload(); await page.getByText('This model returned no readable text.', { exact: true }).waitFor(); assert.match(await speed.textContent(), /\d+\.\d tok\/s/);
  assert.deepEqual(errors, []); console.log('Local-model browser passed: visible default trust, custom-code confirmation, naming before/after loading, no-template disclosure, persistent selector/response names, measured tok/s, raw copy and mobile fitting. No real model code executed in this UI fixture.');
} catch (error) { await page.screenshot({ path: 'platform/logs/local-model-failure.png', fullPage: true }).catch(() => {}); throw error; }
finally { await browser.close(); await fix.close(); await mock.close(); }
