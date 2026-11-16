import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { pasteMarkdown } from './browser-test-helpers.mjs';
import { fixture, mockProvider, waitFor } from './tests/helpers.mjs';

await mkdir('platform/logs', { recursive: true });
const fix = await fixture(), mock = await mockProvider(), browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1480, height: 980 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage(), errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('PAGEERROR', error.message); }); page.on('dialog', dialog => dialog.accept());
try {
  const notes = fix.app.resources.list().find(row => row.managed === 'notes');
  const saveNote = (path, content) => fix.request('/api/resources/save', { workspaceId: notes.id, path, content, revision: null });

  await page.goto(fix.app.url); await page.locator('#setup-dialog').waitFor(); await page.locator('#setup-dialog [data-close]').click(); await page.locator('#nav-notes').click();

  // 1. Notes are created and renamed by title; .md never appears as UI naming.
  const newNote = async title => { await page.locator('.explorer-actions').getByRole('button', { name: 'New note', exact: true }).click(); await page.getByText('Files are stored as Markdown; you never need to type the extension.').waitFor(); await page.getByLabel('Note title', { exact: true }).fill(title); await page.getByRole('button', { name: 'Continue', exact: true }).click(); };
  await newNote('Architecture'); await pasteMarkdown(page.getByLabel('Edit Architecture', { exact: true }), '# Attention\n\nTokenization decisions\n\nThe encoder is unchanged.\n');
  await waitFor(async () => (await readFile(join(notes.root, 'Architecture.md'), 'utf8').catch(() => '')).includes('Tokenization decisions'));
  await newNote('Reference.md'); await waitFor(async () => (await readFile(join(notes.root, 'Reference.md'), 'utf8').catch(() => '')).includes('# Reference'));
  await page.locator('.tree-open[title="Reference"]').waitFor();
  assert.equal(await page.locator('.tree-open[title="Architecture.md"]').count(), 0, 'explorer hides .md');
  assert.equal(await page.locator('.tree-open[title="Reference.md"]').count(), 0, 'entered .md is normalized');
  await page.locator('.tree-row', { has: page.locator('.tree-open[title="Reference"]') }).getByRole('button', { name: /File options/ }).click();
  await page.getByRole('button', { name: 'Rename / move', exact: true }).click();
  await page.getByRole('heading', { name: 'Rename note', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Note title', { exact: true }).inputValue(), 'Reference', 'rename starts from the display title');
  await page.getByLabel('Note title', { exact: true }).fill('Reference notes.md'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await waitFor(async () => (await readFile(join(notes.root, 'Reference notes.md'), 'utf8').catch(() => '')).includes('# Reference'));
  await page.locator('.tree-open[title="Reference notes"]').waitFor();
  await page.locator('.document-tab button[title="Reference notes"]').waitFor();

  // 2. AI placement is movable, remembered and never resets the open note or conversation.
  await page.locator('.knowledge-tools').getByRole('button', { name: 'Notes AI', exact: true }).click();
  const placement = async name => { await page.getByRole('button', { name: 'Move Notes AI panel', exact: true }).click(); await page.getByRole('heading', { name: 'Notes AI placement', exact: true }).waitFor(); await page.getByRole('radio', { name: new RegExp(name) }).check(); await page.getByRole('button', { name: 'Apply placement', exact: true }).click(); };
  await placement('Bottom panel'); await page.locator('.notes-side.is-bottom').waitFor();
  assert.equal(await page.locator('.document-tab.active button[title="Reference notes"]').count(), 1, 'placement keeps the active note');
  await placement('Floating panel'); await page.locator('.notes-side.is-floating').waitFor(); assert.equal(await page.locator('.notes-side.is-floating').evaluate(node => getComputedStyle(node).position), 'fixed');
  await placement('Left sidebar'); await page.locator('.notes-side.is-left').waitFor(); assert.equal(await page.locator('.knowledge-body').evaluate(node => node.firstElementChild.className), 'notes-side is-left');
  await placement('Split with editor'); await page.locator('.knowledge-body.ai-split .notes-side.is-split').waitFor();
  await placement('Bottom panel'); await waitFor(async () => fix.app.resources.layout.notesAi?.placement === 'bottom'); await page.reload(); await page.locator('.notes-side.is-bottom').waitFor(); assert.equal(await page.locator('.document-tab.active button[title="Reference notes"]').count(), 1, 'placement and active note persist across sessions');
  await placement('Right sidebar');
  await page.screenshot({ path: 'platform/logs/unity-notes.png', fullPage: true, animations: 'disabled' });

  // 3. Canvas opens from an ordinary conversation and edits the same file.
  await fix.request('/api/providers', { id: 'canvas', name: 'Canvas API', api: 'openai-completions', baseUrl: mock.baseUrl, apiKey: 'k', models: [{ id: 'note-canvas', name: 'Canvas writer', contextWindow: 128000, maxTokens: 2048, tools: true }, { id: 'markdown-stream', name: 'Formatted reasoning', contextWindow: 128000, maxTokens: 2048, tools: false, reasoning: true, reasoningConfig: { format: 'openai', levels: ['low', 'high'] }, cost: { input: 1, output: 2 } }, { id: 'reasoning-alt', name: 'Fixed reasoning', contextWindow: 128000, maxTokens: 1024, tools: false, reasoning: true }] });
  await page.locator('#nav-chat').click(); await page.locator('#model-button').click(); await page.locator('#model-menu .model-option[data-model-id="note-canvas"]').click(); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('#scope-button').click(); await page.getByRole('checkbox', { name: 'My Notes', exact: true }).check(); await page.getByRole('button', { name: 'Use selected folders', exact: true }).click();
  await page.locator('.composer-rich .tiptap').fill('Update my Architecture note about attention.'); await page.locator('.composer-rich .tiptap').press('Enter');
  await page.locator('.approval-card').waitFor(); await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.locator('.chat-canvas').waitFor(); await page.locator('.chat-canvas .canvas-title-text').filter({ hasText: 'Architecture' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.canvas-rich-editor')?.textContent.includes('updated by AI'));
  await page.waitForFunction(() => document.querySelector('#send').getAttribute('aria-label') === 'Send message');
  assert.equal(await page.locator('.chat-canvas .canvas-title-text').textContent(), 'Architecture');
  await page.locator('.chat-canvas .katex').first().waitFor(); assert.ok(await page.locator('.chat-canvas .katex').count() >= 1, 'Canvas typesets model-generated math');
  const edited = await readFile(join(notes.root, 'Architecture.md'), 'utf8');
  assert.match(edited, /updated by AI/); assert.match(edited, /The encoder is unchanged/);

  // Copy copies raw Markdown and confirms with Check, then restores Copy.
  await page.locator('.canvas-copy').click();
  await page.locator('.canvas-copy[aria-label="Copied"]').waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard.replaceAll(String.fromCharCode(13), ''), edited.replaceAll(String.fromCharCode(13), ''));
  await waitFor(async () => (await page.locator('.canvas-copy').getAttribute('aria-label')) === 'Copy Markdown', 4000);
  // A failed clipboard write reports accessibly and restores the Copy icon without a toast.
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied by test'); }; });
  await page.locator('.canvas-copy').click();
  await waitFor(async () => (await page.locator('.canvas-copy').getAttribute('aria-label')).includes('failed'));
  assert.match(await page.locator('.chat-canvas .sr-only').textContent(), /Copy failed/);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'platform/logs/unity-canvas.png', fullPage: true, animations: 'disabled' });

  // Direct user editing autosaves the same file; conflicts are explicit.
  const rich = page.locator('.canvas-rich-editor .tiptap');
  await pasteMarkdown(rich, edited + '\nDirect Canvas edit.\n'); await waitFor(async () => (await readFile(join(notes.root, 'Architecture.md'), 'utf8').catch(() => '')).includes('Direct Canvas edit.'));
  await pasteMarkdown(rich, edited + '\nDraft that must survive.\n');
  await writeFile(join(notes.root, 'Architecture.md'), edited + '\nExternal writer.\n'); await fix.app.resources.sync(true);
  await page.locator('.canvas-conflict:not([hidden])').waitFor();
  assert.match(await readFile(join(notes.root, 'Architecture.md'), 'utf8'), /External writer/);
  await page.locator('.canvas-conflict .secondary-button').click(); await page.waitForFunction(() => !document.querySelector('.canvas-conflict:not([hidden])'));

  // Canvas and Notes remain one document.
  await page.getByRole('button', { name: 'Open in Notes', exact: true }).click(); await page.locator('.file-rich-editor .tiptap').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.file-rich-editor').textContent.includes('External writer'));
  assert.match(await page.locator('.file-rich-editor').first().textContent(), /updated by AI/);
  await page.locator('.file-rich-editor .katex').first().waitFor(); assert.ok(await page.locator('.file-rich-editor .katex').count() >= 1, 'Notes renders the same model-generated math');

  // 4. Thinking is an inline orange disclosure without a box or provider hint.
  await page.locator('#nav-chat').click(); await page.waitForTimeout(400);
  await page.locator('#new-chat').click(); await page.waitForFunction(() => !document.querySelector('#prompt').disabled && !document.querySelector('#main-chat-pane').closest('#knowledge-main'));
  await page.locator('#model-button').click(); await page.locator('#model-menu .model-option[data-model-id="markdown-stream"]').click(); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('.composer-rich .tiptap').fill('Show the sigmoid with reasoning.'); await page.locator('#send').click();
  await page.waitForFunction(() => location.hash.startsWith('#chat='));
  await page.locator('#messages .reasoning-panel').waitFor({ timeout: 12000 }).catch(async error => { console.log('STATE', await page.evaluate(() => ({ hash: location.hash, users: [...document.querySelectorAll('#messages .user-message')].map(n => n.textContent.slice(0, 30)), assistants: [...document.querySelectorAll('#messages .assistant-message')].map(n => n.textContent.slice(0, 40)), model: document.querySelector('#model-label').textContent, toast: document.querySelector('#toast').textContent })), 'requests', mock.requests.length); throw error; });
  await page.waitForFunction(() => !document.querySelector('#send').disabled && document.querySelector('#send').getAttribute('aria-label') === 'Send message');
  const panel = page.locator('#messages .reasoning-panel'), summary = panel.locator('summary'), brand = 'rgb(244, 91, 50)';
  assert.equal(await panel.locator('.reasoning-label').textContent(), 'Thinking');
  assert.equal(await summary.locator('.reasoning-label + .reasoning-chevron').count(), 1, 'the arrow follows the label');
  assert.equal(await page.getByText('Provider-exposed content', { exact: true }).count(), 0);
  assert.equal(await page.locator('#stream-thinking').getByText('Provider-exposed content', { exact: true }).count(), 0);
  assert.equal(await panel.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
  assert.equal(await panel.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await panel.locator('.reasoning-label').evaluate(node => getComputedStyle(node).color), brand);
  assert.equal(await panel.locator('.reasoning-chevron').evaluate(node => getComputedStyle(node).color), brand);
  assert.equal(await panel.locator('.reasoning-body').evaluate(node => getComputedStyle(node).borderLeftWidth), '0px', 'the line is absent while collapsed');
  await summary.click(); await panel.locator('.reasoning-body').waitFor();
  assert.equal(await panel.locator('.reasoning-body').evaluate(node => getComputedStyle(node).borderLeftWidth), '2px');
  assert.equal(await panel.locator('.reasoning-body').evaluate(node => getComputedStyle(node).borderLeftColor), brand);
  assert.equal(await panel.locator('.reasoning-content').evaluate(node => getComputedStyle(node).color), brand);
  assert.equal(await panel.locator('.reasoning-chevron').evaluate(node => getComputedStyle(node).transform !== 'none'), true);
  assert.match(await panel.textContent(), /Provider note/);
  await summary.click(); assert.equal(await panel.getAttribute('open'), null);
  await page.screenshot({ path: 'platform/logs/unity-thinking.png', fullPage: true, animations: 'disabled' });

  // 5. Compact model selector: display name, real effort levels and no provider/secondary metadata.
  assert.equal(await page.locator('#provider-label').count(), 0);
  assert.equal(await page.locator('#model-label').textContent(), 'Formatted reasoning');
  assert.equal(await page.locator('#model-effort').textContent(), 'Low', 'unsupported saved default falls back to a valid advertised level');
  assert.equal(await page.locator('#model-button').textContent().then(text => /markdown-stream/.test(text)), false, 'raw model ID is hidden');
  await page.locator('#model-button').click();
  await page.getByRole('menuitem', { name: /Effort/ }).click(); await page.locator('.model-submenu [data-level="high"]').click();
  await page.waitForFunction(() => document.querySelector('#model-effort').textContent === 'High');
  await page.locator('#model-button').click(); await page.getByRole('menuitem', { name: /Effort/ }).click(); assert.equal(await page.locator('.model-submenu [aria-checked=true]').getAttribute('data-level'), 'high');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('#model-button').click(); await page.locator('#model-menu .model-option[data-model-id="reasoning-alt"]').click(); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('#model-button').click(); assert.equal(await page.getByRole('menuitem', { name: /Effort/ }).isVisible(), false, 'models without advertised levels have no effort control');
  await page.keyboard.press('Escape'); await page.locator('#model-menu').waitFor({ state: 'detached' });
  await page.locator('#model-button').click(); await page.locator('#model-menu .model-option[data-model-id="markdown-stream"]').click(); await page.locator('#model-menu').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#model-effort').textContent(), 'High', 'effort choice persisted for the model');
  await page.locator('.composer-rich .tiptap').fill('Use the new effort.'); await page.locator('#send').click();
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  assert.equal(mock.requests.at(-1).body.reasoning_effort, 'high', 'the visible effort is the one actually sent');
  assert.equal(await page.locator('#messages .user-bubble .katex').count(), 0, 'user-authored math stays literal');

  assert.deepEqual(errors, []);
  console.log('Unity browser passed: extension-free note titles and renames, movable/persisted Notes AI placement, AI Canvas opening and editing the real note, raw-Markdown copy with Check/failure feedback, direct Canvas editing with explicit conflicts, Notes/Canvas synchronization, inline orange thinking disclosure, and compact model display with real, persisted effort levels.');
} catch (error) { await page.screenshot({ path: 'platform/logs/unity-failure.png', fullPage: true }).catch(() => {}); throw error; }
finally { await browser.close(); await fix.close(); await mock.close(); }
