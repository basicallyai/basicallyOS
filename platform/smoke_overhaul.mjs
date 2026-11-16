import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { pasteMarkdown } from './browser-test-helpers.mjs';
import { fixture, mockProvider, waitFor } from './tests/helpers.mjs';
const fix = await fixture(), mock = await mockProvider(), browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
await mkdir('platform/logs', { recursive: true }); const page = await browser.newPage({ viewport: { width: 1480, height: 980 } }), errors = []; page.on('pageerror', error => errors.push(error.message)); let confirmations = 0; page.on('dialog', async dialog => { confirmations++; await dialog.accept(); });
const drag = async (locator, dx, dy = 0) => { const box = await locator.boundingBox(); assert.ok(box); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 }); await page.mouse.up(); };
try {
  await page.goto(fix.app.url); await page.locator('#setup-dialog').waitFor(); await page.keyboard.press('Escape'); await page.locator('#nav-notes').click();
  assert.equal(await page.getByLabel('Active workspace').inputValue(), fix.app.resources.list()[0].id); assert.equal(fix.app.resources.list().length, 1);
  const notes = fix.app.resources.list()[0], create = async path => { await page.locator('.explorer-actions').getByRole('button', { name: 'New note', exact: true }).click(); await page.getByLabel('Note title', { exact: true }).fill(path); await page.getByRole('button', { name: 'Continue', exact: true }).click(); await page.getByLabel('Edit ' + path.split('/').pop().replace(/\.md$/, ''), { exact: true }).waitFor(); };
  await create('Topics/Formula.md');
  const content = String.raw`# Sigmoid notebook

**Bold** *italic* ~~old~~ and \`inline\`.

Inline $x^2$ and \(y+1\).

$$
\sigma(x) = \frac{1}{1 + e^{-x}}
$$

\[\int_0^1 x\,dx = \frac{1}{2}\]

- [x] A task
- Parent
  - Nested child

1. First
2. Second

> A useful quotation.

| Key | Value |
|---|---|
| Equation | Ready |

---

[[Other]] and [safe link](https://example.com).

\`\`\`js
const value = '$not_math$';
\`\`\`
`.replaceAll('\\`', '`');
  await page.getByLabel('Document view').selectOption('source');
  await page.getByLabel('Edit Formula', { exact: true }).fill(content);
  await waitFor(async () => await readFile(join(notes.root, 'Topics/Formula.md'), 'utf8') === content);
  await page.getByLabel('Document view').selectOption('rich');
  await page.locator('.file-rich-editor table').waitFor();
  // User-authored notes keep literal dollar signs; only model-generated equations are typeset.
  assert.equal(await page.locator('.file-rich-editor .katex').count(), 0);
  assert.match(await page.locator('.file-rich-editor').textContent(), /\$x\^2\$/);
  for (const selector of ['h1', 'strong', 'em', 's', 'blockquote', 'table', 'pre code .hljs-keyword', 'ul ul', 'input[type=checkbox]', 'hr']) assert.ok(await page.locator('.file-rich-editor ' + selector).count(), selector);
  await create('Other.md'); await pasteMarkdown(page.getByLabel('Edit Other', { exact: true }), '# Other\n\nConnected knowledge.'); await page.getByText('Backlinks · 1', { exact: true }).waitFor();
  await page.getByLabel('Search workspace').fill('sigmoid'); await page.locator('.knowledge-result').filter({ hasText: 'Topics/Formula' }).click(); await page.getByLabel('Search workspace').fill('');
  const sidebar = page.getByRole('separator', { name: 'Resize main sidebar', exact: true }), before = await page.locator('#sidebar').evaluate(node => node.offsetWidth); await drag(sidebar, 52); await page.waitForFunction(width => document.querySelector('#sidebar').offsetWidth > width + 45, before);
  const context = page.getByRole('separator', { name: 'Resize Notes AI panel', exact: true }); await drag(context, -45);
  assert.equal(await page.getByRole('separator', { name: 'Resize source and preview', exact: true }).count(), 0, 'No split editor in the default document experience');
  const sizes = await page.evaluate(() => JSON.parse(localStorage.getItem('basically:panel-sizes'))); assert.ok(sizes.sidebar > before + 45);
  await waitFor(async () => fix.app.resources.layout.notesAi?.size >= 400); const notesSize = fix.app.resources.layout.notesAi.size;
  await page.reload(); await page.locator('.file-rich-editor .tiptap').first().waitFor(); await page.waitForFunction(width => Math.abs(document.querySelector('#sidebar').offsetWidth - width) < 2, sizes.sidebar); assert.ok(Math.abs((await page.locator('.knowledge-context').boundingBox()).width - notesSize) < 2);
  await sidebar.dblclick(); await page.waitForFunction(() => Math.abs(document.querySelector('#sidebar').offsetWidth - 272) < 2);
  await page.getByRole('button', { name: 'Split right', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 2); await page.getByRole('separator', { name: 'Resize editor panes', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await page.screenshot({ path: 'platform/logs/overhaul-notes.png', fullPage: true, animations: 'disabled' });
  await page.locator('#nav-chat').click(); await page.locator('#model-button').click(); const form = page.locator('#setup-content .provider-editor');
  await form.getByRole('button', { name: 'Custom endpoint', exact: true }).click(); await form.locator('[name=name]').fill('Live metadata demo'); await form.locator('[name=baseUrl]').fill(mock.baseUrl); await form.locator('[name=apiKey]').fill('browser-metadata-key'); await form.locator('[name=modelId]').fill('test-model');
  await page.waitForFunction(() => document.querySelector('#setup-content [name=contextWindow]').value === '128000'); assert.equal(await form.locator('[name=maxTokens]').inputValue(), '1024'); assert.equal(await form.locator('[name=inputPrice]').inputValue(), '1.5'); assert.equal(await form.locator('[name=tools]').isChecked(), true);
  await form.locator('[name=modelId]').fill('unknown-id'); await form.locator('.metadata-status').filter({ hasText: 'Unknown model ID' }).waitFor(); assert.equal(await form.locator('[name=contextWindow]').inputValue(), ''); assert.equal(await form.locator('[name=inputPrice]').inputValue(), '');
  await form.locator('[name=modelId]').fill('test-model'); await page.waitForFunction(() => document.querySelector('#setup-content [name=contextWindow]').value === '128000'); assert.equal(mock.catalogRequests.length, 1, 'Typing IDs reuses the cached catalog.');
  await form.getByRole('button', { name: 'Add model & continue', exact: true }).click(); await page.locator('#setup-dialog').waitFor({ state: 'hidden' }); assert.equal(mock.requests.length, 0);
  await fix.request('/api/providers', { id: 'stream-demo', name: 'Streaming demo', api: 'openai-completions', baseUrl: mock.baseUrl, apiKey: 'key', models: [{ id: 'markdown-stream', name: 'Formatted reasoning', contextWindow: 128000, maxTokens: 2048, tools: false, reasoning: true, reasoningConfig: { format: 'openai', levels: ['low', 'high'] }, cost: { input: 1, output: 2 } }, { id: 'reasoning-alt', name: 'Fixed reasoning', contextWindow: 128000, maxTokens: 1024, tools: false, reasoning: true }] });
  await page.locator('#model-button').click(); await page.locator('#model-menu .model-option[data-model-id="markdown-stream"]').click(); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('#model-button').click(); await page.getByRole('menuitem', { name: /Effort/ }).click(); const effort = page.locator('.model-submenu'); await effort.waitFor(); assert.deepEqual(await effort.locator('[role=menuitemradio]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-level'))), ['low', 'high']); assert.equal(await page.locator('#model-menu select').count(), 0, 'effort is a submenu, not a per-row select'); await page.screenshot({ path: 'platform/logs/overhaul-models.png', fullPage: true, animations: 'disabled' }); await effort.locator('[data-level="high"]').click(); await page.waitForFunction(() => document.querySelector('#model-effort').textContent === 'High');
  await pasteMarkdown(page.locator('.composer-rich .tiptap'), '**Compare** [[Topics/Formula]] and $x^2$.');
  await page.evaluate(() => { window.sawPendingMath = false; window.pendingMathObserver = new MutationObserver(() => { if (document.querySelector('#streaming-content .math-pending')) window.sawPendingMath = true; }); window.pendingMathObserver.observe(document.querySelector('#streaming-content'), { childList: true, subtree: true, attributes: true }); });
  await page.locator('#send').click();
  await page.locator('#streaming-content h1').waitFor(); await page.evaluate(() => { window.stableHeading = document.querySelector('#streaming-content h1'); });
  await page.waitForFunction(() => document.querySelector('#streaming-content').textContent.includes('second expression')); assert.equal(await page.evaluate(() => window.stableHeading === document.querySelector('#streaming-content h1')), true);
  await page.waitForFunction(() => window.sawPendingMath); await page.evaluate(() => window.pendingMathObserver.disconnect()); await page.locator('#messages .assistant-message h1').waitFor(); await page.waitForFunction(() => !document.querySelector('#send').disabled && document.querySelector('#send').getAttribute('aria-label') === 'Send message');
  assert.equal(await page.locator('#messages .assistant-message > .prose .katex').count(), 3); assert.equal(await page.locator('#messages .user-bubble .katex').count(), 0, 'user dollar signs stay literal'); assert.match(await page.locator('#messages .user-bubble').textContent(), /\$x\^2\$/); assert.equal(mock.requests.at(-1).body.reasoning_effort, 'high'); assert.match(JSON.stringify(mock.requests.at(-1).body.messages), /Sigmoid notebook/); assert.ok(confirmations >= 1);
  const formattedChatUrl = page.url();
  await page.locator('#messages .reasoning-panel summary').click(); assert.equal(await page.locator('#messages .reasoning-panel .katex').count(), 1); await page.screenshot({ path: 'platform/logs/overhaul-chat.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('separator', { name: 'Resize reasoning panel', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  await drag(page.getByRole('separator', { name: 'Resize conversation width', exact: true }), 25); assert.ok(await page.locator('.conversation-column').evaluate(node => node.offsetWidth) > 860);
  // Unsafe HTML/math and code delimiters are tested through the actual shared renderer.
  await page.evaluate(async () => { const { markdown } = await import('/markdown.js'); const node = markdown(String.raw`\href{javascript:alert(1)}{bad}

$$\htmlClass{evil}{x}$$

<img src=x onerror="window.xss=1">

\`\`\`latex
$x^2$
\`\`\``.replaceAll('\\`', '`')); document.body.append(node); if (node.querySelector('script,img,[onclick],a[href^="javascript:"]') || window.xss || node.querySelector('pre .katex')) throw new Error('Unsafe renderer'); node.remove(); });
  await fix.request('/api/providers', { id: 'reader', name: 'Tool rendering', api: 'openai-completions', baseUrl: mock.baseUrl, apiKey: 'key', models: [{ id: 'resource-read', name: 'Resource reader', contextWindow: 128000, maxTokens: 2048, tools: true }] });
  await page.locator('#new-chat').click(); await page.locator('#model-button').click(); await page.locator('#model-menu .model-option[data-model-id="resource-read"]').click(); await page.locator('#model-menu').waitFor({ state: 'detached' }); await page.locator('#scope-button').click(); await page.getByRole('checkbox', { name: 'My Notes', exact: true }).check(); await page.getByRole('button', { name: 'Use selected folders', exact: true }).click();
  await page.locator('.composer-rich .tiptap').fill(JSON.stringify({ workspaceId: notes.id, path: 'Topics/Formula.md' })); await page.locator('#send').click(); await page.locator('.tool-card .tool-status.done').waitFor(); await page.locator('.tool-card > summary').click(); await page.locator('.tool-output-body table').waitFor(); assert.equal(await page.locator('.tool-output-body .katex').count(), 0, 'Reading user-written notes does not change math provenance');
  await page.getByRole('separator', { name: 'Resize tools panel', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  await page.reload(); await page.locator('#messages .tool-card').waitFor(); await page.locator('#model-button').click(); assert.equal(await page.getByRole('menuitem', { name: /Effort/ }).isVisible(), false, 'current non-reasoning model hides Effort after reload'); await page.keyboard.press('Escape'); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('#model-button').click(); await page.locator('#model-menu .model-option[data-model-id="markdown-stream"]').click(); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('#model-button').click(); await page.getByRole('menuitem', { name: /Effort/ }).click(); assert.equal(await page.locator('.model-submenu [aria-checked=true]').getAttribute('data-level'), 'high', 'effort persists across reloads for its model'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.locator('#open-settings').click(); await page.getByRole('button', { name: 'Preferences', exact: true }).click(); await page.locator('[name=theme]').selectOption('light'); await page.getByRole('button', { name: 'Save preferences', exact: true }).click(); await page.getByText('Preferences saved.', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.goto(formattedChatUrl); await page.locator('#messages .assistant-message .hljs-number').waitFor(); await page.evaluate(() => document.fonts.ready);
  const symbolContrast = await page.evaluate(() => { const node = document.querySelector('#messages .assistant-message .hljs-number'); const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0); const a = luminance(getComputedStyle(node).color), b = luminance(getComputedStyle(node.closest('pre')).backgroundColor); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }); assert.ok(symbolContrast >= 4.5, 'Light-mode syntax symbols meet normal-text contrast.'); assert.equal(await page.locator('#messages .assistant-message > .prose .katex').count(), 3); await page.screenshot({ path: 'platform/logs/overhaul-light.png', fullPage: true, animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'reduce' }); assert.equal(await page.locator('#sidebar').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#toggle-sidebar').click(); await page.screenshot({ path: 'platform/logs/overhaul-mobile.png', fullPage: true, animations: 'disabled' }); await page.locator('#close-sidebar').click(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []); console.log('Overhaul browser passed: no-attachment notes, nested organization/backlinks/search/autosave, four math syntaxes/GFM/highlighting, cached automatic metadata/unknown IDs, model-specific reasoning and request payload, stable real streaming DOM, Markdown tool output, panel dragging/keyboard/reset/persistence, light/dark rendering with accessible syntax contrast, reduced motion and mobile.');
} catch (error) { await page.screenshot({ path: 'platform/logs/overhaul-failure.png', fullPage: true }).catch(() => {}); throw error; }
finally { await browser.close(); await fix.close(); await mock.close(); }
