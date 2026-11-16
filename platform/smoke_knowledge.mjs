import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { pasteMarkdown } from './browser-test-helpers.mjs';
import { fixture, mockProvider, connect, waitFor } from './tests/helpers.mjs';
let nextFolder; const fix = await fixture({ folderPicker: { pick: async () => nextFolder ? { path: nextFolder } : { cancelled: true } } }), mock = await mockProvider(); let browser;
try {
  await connect(fix, mock); const root = join(fix.directory, 'browser-vault'); await mkdir(root);
  await writeFile(join(root, 'script.js'), '\uFEFFconst count = 1;\r\n// Code is source, not Markdown.\r\n');
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1480, height: 980 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(fix.app.url); await page.locator('#nav-notes').click();
  await page.getByRole('button', { name: 'Attach local folder', exact: true }).click(); nextFolder = null; await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await page.getByText('Folder selection cancelled. Nothing was attached.', { exact: true }).waitFor(); assert.equal((await fix.request('/api/workspaces')).workspaces.length, 1);
  nextFolder = root; await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await page.getByLabel('Active workspace').selectOption({ label: 'browser-vault' }); await page.locator('#info-dialog').waitFor({ state: 'hidden' });
  // Empty main-chat and Notes AI composers keep independent unsent drafts.
  await page.locator('.knowledge-tools').getByRole('button', { name: 'Notes AI', exact: true }).click(); await page.locator('.composer-rich .tiptap').fill('Unsent Notes draft');
  await page.locator('#nav-chat').click(); await page.locator('.composer-rich .tiptap').fill('Unsent main draft'); await page.locator('#nav-notes').click(); assert.equal(await page.locator('#prompt').inputValue(), 'Unsent Notes draft');
  await page.locator('#nav-chat').click(); assert.equal(await page.locator('#prompt').inputValue(), 'Unsent main draft'); await page.locator('.composer-rich .tiptap').fill(''); await page.locator('#nav-notes').click(); await page.locator('.composer-rich .tiptap').fill('');
  await page.locator('.context-tabs').getByRole('button', { name: 'Connections', exact: true }).click();
  const create = async (path, content) => {
    await page.locator('.explorer-actions').getByRole('button', { name: 'New note', exact: true }).click(); await page.getByLabel('Note title', { exact: true }).fill(path); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('.document-tab.active button[title="' + path.replace(/\.md$/, '') + '"]').waitFor();
    await page.getByLabel('Document view').selectOption('source');
    await page.getByLabel('Edit ' + path.replace(/\.md$/, ''), { exact: true }).fill(content);
    await waitFor(async () => (await readFile(join(root, path), 'utf8')) === content);
    await page.getByLabel('Document view').selectOption('rich');
  };
  await create('Architecture.md', '# Architecture\n\n## Decisions\nUse local files. [[Training Plan|Roadmap]]\n\n- [ ] Validate integration.');
  await create('Training Plan.md', '# Training Plan\n\n#project\nConsult [[Architecture#Decisions]].');
  await page.locator('.file-rich-editor .wiki-link').click({ modifiers: ['Control'] });
  await page.locator('.links-panel .connection-card').filter({ hasText: 'Training Plan' }).first().waitFor();
  await page.getByRole('button', { name: 'Split right', exact: true }).click();
  await page.getByLabel('Document view').first().selectOption('source'); await page.getByLabel('Document view').last().selectOption('source');
  await page.waitForFunction(() => document.querySelectorAll('.file-source[aria-label="Edit Architecture"]').length === 2);
  const sources = page.getByLabel('Edit Architecture', { exact: true }); const updated = '# Architecture\n\n## Decisions\nUse local files. [[Training Plan|Roadmap]]\n\n- [ ] Validate integration.\n\nSynchronized split editing.';
  await sources.first().fill(updated); await waitFor(async () => (await sources.last().inputValue()) === updated); await waitFor(async () => (await readFile(join(root, 'Architecture.md'), 'utf8')) === updated);
  await page.getByLabel('Document view').first().selectOption('rich'); await page.locator('.file-rich-editor input[type=checkbox]').first().check(); await waitFor(async () => (await readFile(join(root, 'Architecture.md'), 'utf8')).includes('- [x]'));
  await page.getByLabel('Document view').first().selectOption('source');
  // Save a draft, force a conflicting disk change before its autosave, and explicitly choose disk.
  await sources.first().fill(updated + '\nUnsaved local draft.'); await writeFile(join(root, 'Architecture.md'), '# External change\nExternal wins until explicitly resolved.'); await fix.app.resources.sync(true);
  await page.locator('.file-conflict:not([hidden])').first().getByRole('button', { name: 'Review conflict', exact: true }).click();
  await page.getByRole('button', { name: 'Reload disk version', exact: true }).click();
  await waitFor(async () => (await sources.first().inputValue()).includes('External wins')); assert.equal(await readFile(join(root, 'Architecture.md'), 'utf8'), '# External change\nExternal wins until explicitly resolved.');
  // External edits to clean files update every open view.
  await writeFile(join(root, 'Architecture.md'), '# Architecture\n\n## Decisions\nAn externally synchronized decision.'); await fix.app.resources.sync(true);
  await waitFor(async () => (await sources.first().inputValue()).includes('externally synchronized'));
  // Code editing keeps the UTF-8 BOM and untouched original line endings.
  await page.locator('.tree-open[title="script.js"]').click(); const code = page.getByLabel('Edit script.js', { exact: true });
  await code.fill('\uFEFFconst count = 2;\n// Code is source, not Markdown.\n');
  await waitFor(async () => (await readFile(join(root, 'script.js'), 'utf8')).includes('count = 2'));
  assert.equal(await readFile(join(root, 'script.js'), 'utf8'), '\uFEFFconst count = 2;\r\n// Code is source, not Markdown.\r\n');
  await page.getByLabel('Search workspace', { exact: true }).fill('tag:project type:md'); await page.locator('.knowledge-result').filter({ hasText: 'Training Plan' }).click();
  await page.getByLabel('Search workspace', { exact: true }).fill('');
  // Notes AI is the existing chat DOM/runtime, not a second provider implementation.
  await page.waitForFunction(() => [...document.querySelectorAll('.file-rich-editor p')].some(node => node.textContent.includes('Consult')));
  await page.evaluate(() => { const paragraph = [...document.querySelectorAll('.file-rich-editor p')].find(node => node.textContent.includes('Consult')); const range = document.createRange(); range.selectNodeContents(paragraph); const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range); });
  await page.waitForFunction(() => window.getSelection().toString().includes('Consult'));
  await page.locator('.knowledge-tools').getByRole('button', { name: 'Notes AI', exact: true }).click();
  await pasteMarkdown(page.locator('.composer-rich .tiptap'), 'Summarize [[Training Plan]] and the current note.'); await page.locator('#send').click();
  await page.locator('.assistant-message').first().waitFor(); await waitFor(async () => (await fix.request('/api/chats')).chats?.length || (await fix.request('/api/chats')).length);
  assert.match(JSON.stringify(mock.requests.at(-1).body.messages), /Consult \[\[Architecture#Decisions\]\]/); assert.match(JSON.stringify(mock.requests.at(-1).body.messages), /User-selected text/);
  const notesChats = await fix.request('/api/chats'); assert.equal(notesChats.chats[0].surface, 'notes');
  await page.screenshot({ path: 'platform/logs/knowledge-notes.png', fullPage: true });
  await page.locator('#nav-chat').click(); assert.equal(await page.locator('#knowledge-main').isVisible(), false); await page.locator('#nav-notes').click(); await page.locator('.assistant-message').first().waitFor();
  await page.keyboard.press('Control+Shift+p'); await page.getByLabel('Command palette search').fill('backlinks'); await page.getByRole('button', { name: 'Show backlinks', exact: true }).click();
  await page.reload(); await page.locator('.editor-group').first().waitFor(); assert.equal(await page.locator('.editor-group').count(), 2); await page.getByLabel('Active workspace').selectOption({ label: 'browser-vault' });
  // Reusable GFM, no raw HTML execution or automatic third-party image loads.
  await page.evaluate(async () => { const { markdown } = await import('/markdown.js'); const rendered = markdown('| A | B |\n|---|---|\n| 1 | 2 |\n\n~~old~~ **new**\n\n```js\nconst a = 1;\n```\n\n<img src=x onerror=alert(1)>\n\n![remote](https://example.com/private-tracker.png)\n\n[malformed](#wiki=%FF)'); document.body.append(rendered); if (!rendered.querySelector('table') || !rendered.querySelector('del') || !rendered.querySelector('code') || rendered.querySelector('img')) throw new Error('Unsafe or incomplete shared renderer'); rendered.remove(); });
  // Managed-memory controls, creation, filtering and editing use the same backend as agent tools.
  await page.locator('#open-settings').click(); await page.getByRole('button', { name: 'Memory', exact: true }).click(); await page.getByRole('button', { name: 'New memory', exact: true }).click();
  await page.getByLabel('Memory title', { exact: true }).fill('Portable notes preference'); await page.getByLabel('Memory content', { exact: true }).fill('Prefer ordinary Markdown files for long-lived knowledge.'); await page.getByRole('button', { name: 'Save managed memory', exact: true }).click();
  await page.locator('.managed-memory').filter({ hasText: 'Portable notes preference' }).waitFor();
  await page.getByLabel('Filter managed memories').fill('portable'); assert.equal(await page.locator('.managed-memory').count(), 1);
  await page.screenshot({ path: 'platform/logs/knowledge-memory.png', fullPage: true }); await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  // Live thinking is provider content, stays collapsible after settlement and is absent on ordinary replies.
  await fix.request('/api/providers', { id: 'visual-reason', name: 'Reasoning test', api: 'openai-completions', baseUrl: mock.baseUrl, apiKey: 'mock-reason-key', requiresKey: true, models: [{ id: 'reasoning', name: 'Reasoning model', contextWindow: 128000, maxTokens: 1024, reasoning: true, tools: false }] });
  await page.locator('#nav-chat').click(); await page.locator('#model-button').click(); await page.locator('#model-menu .model-option[data-model-id="reasoning"]').click(); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('.composer-rich .tiptap').fill('Explain the workspace.'); await page.locator('#send').click(); await page.locator('#stream-thinking:not([hidden])').waitFor(); await page.locator('#stream-thinking summary').click();
  await page.locator('#messages .reasoning-panel[open]').waitFor(); assert.match(await page.locator('#messages .reasoning-panel').textContent(), /Provider-exposed reasoning/);
  await page.locator('#messages .reasoning-panel summary').click(); assert.equal(await page.locator('#messages .reasoning-panel').getAttribute('open'), null);
  await page.screenshot({ path: 'platform/logs/knowledge-reasoning.png', fullPage: true });
  await page.locator('#nav-notes').click(); await page.waitForFunction(() => !document.querySelector('#send').disabled && !document.querySelector('#messages .reasoning-panel')); assert.equal(await page.locator('#messages .reasoning-panel').count(), 0);
  // External renames follow the same document into its new tab/explorer path without overwriting contents.
  await rename(join(root, 'Training Plan.md'), join(root, 'Roadmap.md')); await fix.app.resources.sync(true); await page.locator('.document-tab button[title="Roadmap"]').first().waitFor(); await page.locator('.tree-open[title="Roadmap"]').waitFor();
  // Resizable split proportions are keyboard accessible and durably stored.
  await page.getByRole('separator', { name: 'Resize editor panes' }).focus(); await page.keyboard.press('ArrowRight');
  await waitFor(async () => (await fix.request('/api/knowledge/layout')).panes[0].weight > 1);
  await page.screenshot({ path: 'platform/logs/knowledge-notes-refined.png', fullPage: true });
  // Resolve an ambiguous basename across two explicitly attached vaults before any generation request.
  await mkdir(join(root, 'A')); await writeFile(join(root, 'A/Shared.md'), '# Shared\nFIRST_SHARED_CONTEXT');
  const second = join(fix.directory, 'second-vault'); await mkdir(join(second, 'B'), { recursive: true }); await writeFile(join(second, 'B/Shared.md'), '# Shared\nSECOND_SHARED_PRIVATE');
  await page.getByRole('button', { name: 'Attach local folder', exact: true }).click(); nextFolder = second; await page.getByRole('button', { name: 'Choose folder…', exact: true }).click(); await page.getByLabel('Active workspace').selectOption({ label: 'second-vault' });
  await page.getByRole('button', { name: 'New Notes AI conversation', exact: true }).click(); await pasteMarkdown(page.locator('.composer-rich .tiptap'), 'Compare [[Shared]].'); const requestCount = mock.requests.length; await page.locator('#send').click();
  await page.getByRole('heading', { name: 'Resolve ambiguous references', exact: true }).waitFor(); assert.equal(mock.requests.length, requestCount); await page.getByLabel('Shared', { exact: true }).selectOption({ label: 'browser-vault / A/Shared' }); await page.getByRole('button', { name: 'Use these files', exact: true }).click();
  await waitFor(() => mock.requests.length > requestCount); assert.match(JSON.stringify(mock.requests.at(-1).body.messages), /FIRST_SHARED_CONTEXT/); assert.doesNotMatch(JSON.stringify(mock.requests.at(-1).body.messages), /SECOND_SHARED_PRIVATE/); await page.waitForFunction(() => !document.querySelector('#send').disabled && document.querySelector('#send').getAttribute('aria-label') === 'Send message');
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'platform/logs/knowledge-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); assert.deepEqual(errors, []);
  console.log('Knowledge browser checks passed: explicit attachment, notes/autosave, wiki/backlinks, synchronized splits, external conflicts, BOM/CRLF source preservation, search, shared Notes AI, persisted layout, sanitized GFM, memory management and mobile.');
} catch (error) { console.error('Diagnostic conversations:', (await fix.app.store.list(true)).map(row => ({ id: row.id, title: row.title, surface: row.surface, error: row.error, messages: row.messages.length })), 'models requested:', mock.requests.map(row => row.body.model)); if (browser) await browser.contexts()[0]?.pages()[0]?.screenshot({ path: 'platform/logs/knowledge-browser-failure.png', fullPage: true }).catch(() => {}); throw error; }
finally { await browser?.close(); await fix.close(); await mock.close(); }
