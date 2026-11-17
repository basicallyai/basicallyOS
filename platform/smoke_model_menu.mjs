import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { fixture, mockProvider, waitFor } from './tests/helpers.mjs';
await mkdir('platform/logs', { recursive: true });
const fix = await fixture(), mock = await mockProvider(), browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } }), page = await context.newPage();
const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('PAGEERROR', error.message); });
try {
  await fix.request('/api/providers', { id: 'lab', name: 'Research API', api: 'openai-completions', baseUrl: mock.baseUrl, apiKey: 'private-key', models: [
    { id: 'alpha-model', name: 'Deepseek', contextWindow: 128000, maxTokens: 4096, tools: true, reasoning: true, reasoningConfig: { format: 'openai', levels: ['low', 'medium', 'high', 'max'] }, cost: { input: 1, output: 2 } },
    { id: 'beta-model', name: 'Plain model', contextWindow: 64000, maxTokens: 2048, tools: false, cost: { input: 3, output: 4 } },
    { id: 'gamma-model', name: 'Claude', contextWindow: 64000, maxTokens: 2048 },
    { id: 'delta-model', name: 'Gemini', contextWindow: 64000, maxTokens: 2048 },
    { id: 'epsilon-model', name: 'Llama', contextWindow: 64000, maxTokens: 2048 },
    { id: 'zeta-model', name: 'Mistral', contextWindow: 64000, maxTokens: 2048 },
  ] });
  await page.goto(fix.app.url); if (await page.locator('#setup-dialog').isVisible()) await page.locator('#setup-dialog [data-close]').click();
  const trigger = page.locator('#model-button'), menu = page.locator('#model-menu');
  assert.equal(await page.locator('#model-dialog').count(), 0, 'legacy modal removed');
  assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await trigger.click(); await menu.waitFor();
  assert.equal(await page.locator('dialog[open] #model-options').count(), 0, 'quick selection is not a dialog');
  assert.deepEqual(await page.locator('#model-menu .model-option').evaluateAll(nodes => nodes.map(node => node.textContent.trim())), ['Deepseek', 'Plain model', 'Claude', 'Gemini', 'Llama', 'Mistral'], 'display names only, no provider or metadata');
  const menuText = await menu.textContent(); for (const leaked of ['128', '4096', 'alpha-model', 'Research API', 'tools', 'ctx', '$1']) assert.equal(menuText.includes(leaked), false, 'quick list omits ' + leaked);
  const triggerBox = await trigger.boundingBox(), menuBox = await menu.boundingBox(); assert.ok(menuBox.y + menuBox.height <= triggerBox.y + 1, 'opens above the selector'); assert.ok(menuBox.width <= 320, 'compact width'); assert.ok(menuBox.height <= 460, 'compact height');
  assert.equal(await page.locator('#model-menu .model-option[data-model-id="alpha-model"] .model-menu-check').count(), 1, 'selected model checked');
  assert.equal(await page.getByRole('menuitem', { name: /Effort/ }).count(), 1); const initialEffort = (await page.getByRole('menuitem', { name: /Effort/ }).locator('[data-effort-value]').textContent()).toLocaleLowerCase(); assert.ok(['low', 'medium', 'high', 'max'].includes(initialEffort)); assert.match(await page.getByRole('menuitem', { name: /Effort/ }).textContent(), new RegExp(initialEffort, 'i'));
  await page.getByRole('menuitem', { name: /Effort/ }).click(); const submenu = page.locator('.model-submenu'); await submenu.waitFor();
  assert.deepEqual(await submenu.locator('[role=menuitemradio]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-level'))), ['low', 'medium', 'high', 'max'], 'only advertised levels');
  assert.equal(await submenu.locator('[aria-checked=true]').getAttribute('data-level'), initialEffort);
  const subBox = await submenu.boundingBox(), effortBox = await page.getByRole('menuitem', { name: /Effort/ }).boundingBox(); assert.ok(subBox.x >= menuBox.x + menuBox.width || subBox.x + subBox.width <= menuBox.x, 'submenu sits beside the menu, flipping when needed');
  await submenu.locator('[data-level=high]').click(); await waitFor(async () => await page.locator('#model-effort').textContent() === 'High'); assert.equal(await menu.count(), 0, 'menu closes after effort selection');
  assert.equal(fix.app.store.settings.reasoningOverrides['lab/alpha-model'], 'high', 'effort persisted');
  await trigger.click(); await page.locator('#model-menu .model-option[data-model-id="beta-model"]').click(); await waitFor(async () => await page.locator('#model-label').textContent() === 'Plain model');
  assert.equal(await page.locator('#model-effort').isVisible(), false, 'no effort indicator for unsupported model');
  await trigger.click(); assert.equal(await page.getByRole('menuitem', { name: /Effort/ }).isVisible(), false, 'Effort item hidden when unsupported');
  const modelSearch = page.getByLabel('Search models', { exact: true }); await modelSearch.waitFor(); await modelSearch.fill('plain'); assert.deepEqual(await page.locator('#model-menu .model-option').evaluateAll(nodes => nodes.map(node => node.textContent.trim())), ['Plain model']); await modelSearch.fill(''); await waitFor(async () => await page.locator('#model-menu .model-option').count() === 6);
  // Keyboard: open with ArrowDown, move through rows, Escape restores focus.
  await page.keyboard.press('Escape'); await waitFor(async () => !(await menu.isVisible().catch(() => false)));
  await trigger.focus(); await page.keyboard.press('ArrowDown'); await menu.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Search models', 'keyboard opens with search focused');
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitemradio', 'ArrowDown moves into model rows');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0); assert.equal(await page.evaluate(() => document.activeElement.id), 'model-button');
  // Outside click and Manage models.
  await trigger.click(); await page.locator('#composer-area').click({ position: { x: 5, y: 5 } }); await waitFor(async () => await menu.count() === 0);
  await trigger.click(); await page.getByRole('menuitem', { name: 'Manage models' }).click(); await page.locator('#settings-dialog').waitFor(); assert.equal(await page.locator('#settings-dialog').getAttribute('open'), '');
  await page.locator('#settings-dialog [data-close]').click(); await trigger.click();
  // Narrow viewport: menu stays inside the viewport and within reach of the trigger.
  await page.setViewportSize({ width: 380, height: 560 }); await menu.waitFor(); await waitFor(async () => { const box = await menu.boundingBox(); return box && box.x >= 0 && box.x + box.width <= 380 && box.y >= 0 && box.y + box.height <= 560; }); const narrow = await menu.boundingBox(); assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 380 && narrow.y >= 0 && narrow.y + narrow.height <= 560, 'menu remains in viewport');
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1280, height: 820 });
  await trigger.click(); await page.locator('#model-menu .model-option[data-model-id="alpha-model"]').click(); await waitFor(async () => await page.locator('#model-effort').textContent() === 'High');
  // Actual request uses the visible effort; collapse shows exact display name + effort only.
  const composer = page.locator('.composer-rich .tiptap'); await composer.fill('Use the selected effort.'); await page.locator('#send').click(); await waitFor(() => mock.requests.length > 0); await waitFor(() => !fix.app.runtime.active.size);
  assert.equal(mock.requests.at(-1).body.reasoning_effort, 'high'); assert.equal(mock.requests.at(-1).body.model, 'alpha-model');
  assert.equal(await page.locator('#model-label').textContent(), 'Deepseek'); assert.equal(await page.locator('#model-effort').textContent(), 'High'); assert.ok(parseFloat(await trigger.evaluate(node => getComputedStyle(node).gap)) >= 5, 'model and effort are visually distinct on one line');
  assert.equal(await trigger.getAttribute('title').then(text => /Research API|alpha-model/.test(text)), false, 'collapsed title has no provider/raw ID');
  // Composer density, dynamic height, internal scrolling and toolbar alignment.
  await page.locator('#new-chat').click(); await page.locator('#setup-dialog').isVisible().catch(() => false);
  const emptyBox = await page.locator('#composer').boundingBox(), editorBox = await composer.boundingBox(), padding = await page.locator('.composer-rich .rich-document').evaluate(node => getComputedStyle(node).paddingTop), composerPad = await page.locator('#composer').evaluate(node => getComputedStyle(node).paddingTop);
  assert.ok(emptyBox.height >= 100 && emptyBox.height < 120, 'composer gains a little breathing room without becoming oversized: ' + emptyBox.height); assert.ok(editorBox.height >= 44); assert.ok(editorBox.y - emptyBox.y < 20, 'text begins near the top edge'); assert.equal(padding, '4px'); assert.equal(composerPad, '10px');
  assert.equal(await page.locator('.composer-controls').evaluate(node => getComputedStyle(node).alignItems), 'center');
  const toolsBox = await page.locator('.composer-tools').boundingBox(), sendBox = await page.locator('#send').boundingBox(); assert.ok(Math.abs((toolsBox.y + toolsBox.height / 2) - (sendBox.y + sendBox.height / 2)) < 1, 'toolbar controls aligned');
  await composer.fill(Array.from({ length: 40 }, (_, i) => 'Line ' + (i + 1)).join('\n')); await waitFor(async () => (await page.locator('#composer').boundingBox()).height > emptyBox.height);
  const longBox = await page.locator('#composer').boundingBox(), rich = page.locator('.composer-rich');
  assert.ok(longBox.height < 290, 'composer stops growing at a reasonable height'); assert.ok(await rich.evaluate(node => node.scrollHeight > node.clientHeight + 1), 'long content scrolls internally'); assert.ok(await rich.evaluate(node => node.clientHeight <= 200));
  await composer.fill(''); await waitFor(async () => (await page.locator('#composer').boundingBox()).height < emptyBox.height + 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'platform/logs/model-menu.png', animations: 'disabled' });
  await trigger.click(); await page.locator('#model-menu').waitFor(); assert.equal(await page.locator('#model-menu .model-option[data-model-id="alpha-model"] .model-menu-check').count(), 1, 'selection remains checked after reopening');
  await page.screenshot({ path: 'platform/logs/model-menu-open.png', animations: 'disabled' });
  await page.getByRole('menuitem', { name: /Effort/ }).click(); await page.locator('.model-submenu [data-level=max]').click(); await waitFor(async () => await page.locator('#model-effort').textContent() === 'Max');
  await composer.fill('Use the documented max effort.'); await page.locator('#send').click(); await waitFor(() => !fix.app.runtime.active.size && mock.requests.at(-1).body.reasoning_effort === 'max'); await page.reload(); await waitFor(async () => await page.locator('#model-effort').textContent() === 'Max');
  assert.deepEqual(errors, []);
  console.log('Model menu browser passed: anchored compact list, display names only, checkmark, separate supported-effort submenu, keyboard/outside/Escape behavior, persistence and real request effort, hidden unsupported effort, Manage models, viewport fitting, and tighter dynamic composer spacing.');
} catch (error) { await page.screenshot({ path: 'platform/logs/model-menu-failure.png', fullPage: true }).catch(() => {}); console.log('TOAST', await page.locator('#toast').textContent().catch(() => '')); throw error; }
finally { await browser.close(); await fix.close(); await mock.close(); }
