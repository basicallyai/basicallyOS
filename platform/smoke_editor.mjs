import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixture } from './tests/helpers.mjs';
import { pasteMarkdown } from './browser-test-helpers.mjs';
const fix = await fixture(), browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(fix.app.url); await page.locator('#setup-dialog [data-close]').click();
  await page.evaluate(async () => { const { createRichEditor } = await import('/vendor/editor.js'); const element = document.createElement('div'); element.id = 'editor-test'; Object.assign(element.style, { position: 'fixed', inset: '80px 80px', overflow: 'auto', zIndex: '99', background: 'var(--bg)' }); document.body.append(element); window.testDocument = createRichEditor({ element, content: '', label: 'Test document' }); });
  const editor = page.getByRole('textbox', { name: 'Test document', exact: true });
  const reset = async () => { await page.evaluate(() => window.testDocument.setContent('')); await editor.click(); };
  for (const [syntax, selector, text] of [['# ', 'h1', 'Title one'], ['## ', 'h2', 'Title two'], ['### ', 'h3', 'Title three'], ['- ', 'ul li', 'Bullet'], ['1. ', 'ol li', 'Numbered'], ['> ', 'blockquote', 'Quote'], ['``` ', 'pre code', 'const answer = 42;']]) {
    await reset(); await editor.pressSequentially(syntax + text); assert.equal(await editor.locator(selector).textContent(), text, syntax);
  }
  for (let level = 1; level <= 6; level++) {
    await reset(); await editor.pressSequentially('#'.repeat(level) + ' Heading'); await editor.press('Shift+Enter'); await editor.pressSequentially('Normal paragraph');
    assert.equal(await editor.locator('h' + level).textContent(), 'Heading'); assert.equal(await editor.locator(':scope > p').filter({ hasText: 'Normal paragraph' }).count(), 1, 'Shift+Enter exits H' + level);
    assert.equal(await page.evaluate(() => window.testDocument.editor.state.selection.$from.parent.type.name), 'paragraph');
  }
  await page.evaluate(() => { window.testDocument.setContent('# HeadingTail'); window.testDocument.editor.commands.setTextSelection(8); }); await editor.focus(); await editor.press('Shift+Enter'); await editor.pressSequentially('Normal '); assert.equal(await editor.locator('h1').textContent(), 'Heading'); assert.equal(await editor.locator(':scope > p').filter({ hasText: 'Normal Tail' }).count(), 1, 'Splitting a heading preserves text after the cursor');
  await reset(); await editor.pressSequentially('## '); await editor.press('Shift+Enter'); await editor.pressSequentially('Normal after empty heading'); assert.equal(await page.evaluate(() => window.testDocument.editor.state.selection.$from.parent.type.name), 'paragraph');
  for (const [syntax, selector] of [['- ', 'ul > li'], ['* ', 'ul > li'], ['1. ', 'ol > li']]) {
    await reset(); await editor.pressSequentially(syntax + 'First item'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Second item');
    assert.equal(await editor.locator(selector).count(), 2, 'Shift+Enter continues ' + syntax); assert.equal(await editor.locator(selector).nth(1).textContent(), 'Second item');
    await page.keyboard.press('Shift+Enter'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Outside the list');
    assert.equal(await editor.locator(selector).count(), 2, 'Empty list item exits ' + syntax); assert.equal(await editor.locator(':scope > p').filter({ hasText: 'Outside the list' }).count(), 1);
  }
  await page.evaluate(() => window.testDocument.setContent('- [x] First task')); await editor.locator('li p').click({ position: { x: 15, y: 10 } }); await page.keyboard.press('End'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Next task'); assert.equal(await editor.locator('ul[data-type="taskList"] > li').count(), 2); assert.equal(await editor.locator('input:checked').count(), 1, 'New task starts unchecked');
  await page.evaluate(() => window.testDocument.setContent('- Parent\n  - Nested')); await editor.locator('ul ul li p').click({ position: { x: 15, y: 10 } }); await page.keyboard.press('End'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Nested sibling'); assert.equal(await editor.locator('ul ul > li').count(), 2); assert.equal(await editor.locator(':scope > ul > li').count(), 1);
  await reset(); await editor.pressSequentially('Plain text'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Same paragraph'); assert.equal(await editor.locator('p').count(), 1); assert.equal(await editor.locator('br').count(), 1);
  await reset(); await editor.pressSequentially('``` ' + 'code'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('next line'); assert.equal(await editor.locator('pre code').textContent(), 'code'); assert.equal(await editor.locator(':scope > p').filter({ hasText: 'next line' }).count(), 1, 'Non-list code behavior is unchanged');
  for (const [open, close, selector] of [['**', '**', 'strong'], ['*', '*', 'em'], ['~~', '~~', 's']]) {
    await reset(); await editor.pressSequentially(open + 'formatted'); assert.equal(await editor.locator(selector).count(), 0, 'Incomplete syntax stays editable'); await editor.pressSequentially(close); assert.equal(await editor.locator(selector).textContent(), 'formatted');
  }
  await reset(); await editor.pressSequentially('[Documentation](https://example.com)'); assert.equal(await editor.locator('a').getAttribute('href'), 'https://example.com');
  await reset(); await editor.pressSequentially('First'); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+b'); await page.keyboard.press('ArrowRight'); assert.equal(await editor.locator('strong').textContent(), 'First'); await page.keyboard.press('Control+z'); assert.equal(await editor.locator('strong').count(), 0); await page.keyboard.press('Control+Shift+z'); assert.equal(await editor.locator('strong').count(), 1);
  const original = '---\ntags: [test]\n---\n\n# Imported\n\nParagraph with [^1] and [[Other.md|Other]].\n\n[^1]: Footnote text\n\n![image](https://example.com/tracker.png)\n\n<!-- preserved comment -->\n\n| A | B |\n|---|---|\n|1|2|\n\n```js\nconst exact = 1;\n```\n';
  await page.evaluate(text => window.testDocument.setContent(text), original); await editor.locator('p').filter({ hasText: 'Paragraph' }).click({ position: { x: 10, y: 10 } }); await page.keyboard.press('End'); await page.keyboard.type(' Edited.');
  const serialized = await page.evaluate(() => window.testDocument.getMarkdown());
  for (const text of ['tags: [test]', '[^1]', '[^1]: Footnote text', '[[Other.md|Other]]', '![image](https://example.com/tracker.png)', '<!-- preserved comment -->', '| A | B |\n|---|---|\n|1|2|', '```js\nconst exact = 1;\n```']) assert.ok(serialized.includes(text), text);
  assert.equal(await editor.locator('img[src],script,iframe').count(), 0, 'Preserved content never executes or fetches images');
  // Copy/paste rich HTML preserves supported structure and opaque source nodes.
  const html = await page.evaluate(() => window.testDocument.editor.getHTML()); await reset();
  await editor.evaluate((node, html) => { const data = new DataTransfer(); data.setData('text/html', html); node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, html);
  const pasted = await page.evaluate(() => window.testDocument.getMarkdown()); assert.match(pasted, /\[\[Other.md\|Other\]\]/); assert.match(pasted, /preserved comment/); assert.match(pasted, /tracker.png/);
  await reset(); await pasteMarkdown(editor, '# Pasted\n\n- Parent\n  - Nested\n\n| A | B |\n|---|---|\n|1|2|'); assert.equal(await editor.locator('h1').textContent(), 'Pasted'); assert.equal(await editor.locator('ul ul').count(), 1); assert.equal(await editor.locator('table').count(), 1);
  await page.evaluate(() => { window.testDocument.destroy(); document.querySelector('#editor-test').remove(); });
  await page.evaluate(() => { window.editorSubmitCount = 0; document.querySelector('#composer').addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); window.editorSubmitCount++; }, { capture: true }); });
  const composer = page.getByRole('textbox', { name: 'Message basically OS', exact: true });
  for (const syntax of ['- ', '1. ']) { await composer.click(); await composer.press('Control+a'); await composer.press('Backspace'); await composer.pressSequentially(syntax + 'First'); await composer.press('Shift+Enter'); await composer.pressSequentially('Second'); assert.equal(await composer.locator('li').count(), 2); assert.equal(await page.evaluate(() => window.editorSubmitCount), 0); }
  await composer.click(); await composer.press('Control+a'); await composer.press('Backspace'); await composer.pressSequentially('## Composer heading'); await composer.press('Shift+Enter'); await composer.pressSequentially('Normal composer paragraph'); assert.equal(await composer.locator('h2').textContent(), 'Composer heading'); assert.equal(await composer.locator(':scope > p').filter({ hasText: 'Normal composer paragraph' }).count(), 1); assert.equal(await page.evaluate(() => window.editorSubmitCount), 0, 'Shift+Enter exits a heading without submitting');
  const headingSize = await composer.locator('h2').evaluate(node => parseFloat(getComputedStyle(node).fontSize)), paragraphSize = await composer.locator(':scope > p').filter({ hasText: 'Normal composer paragraph' }).evaluate(node => parseFloat(getComputedStyle(node).fontSize)); assert.ok(headingSize > paragraphSize + 5, 'Composer heading has a real visual hierarchy, not body-text size');
  for (let level = 1; level <= 6; level++) { await composer.click(); await composer.press('Control+a'); await composer.press('Backspace'); await composer.pressSequentially('#'.repeat(level) + ' Heading level ' + level); const heading = composer.locator('h' + level); await heading.waitFor(); assert.equal(await heading.evaluate(node => getComputedStyle(node).fontWeight), '600'); assert.equal(await page.evaluate(() => window.editorSubmitCount), 0); }
  await composer.press('Enter'); assert.equal(await page.evaluate(() => window.editorSubmitCount), 1, 'Plain Enter still submits in the composer');
  assert.deepEqual(errors, []); console.log('Rich editor browser passed: live Markdown shortcuts, Shift+Enter heading exit (H1–H6, empty/mid-heading, composer) and list continuation, incomplete syntax, links, selection/format shortcuts, undo/redo, nested lists/tables, exact preservation of frontmatter/wiki/footnotes/images/HTML/code, rich and Markdown paste.');
} catch (error) { await page.screenshot({ path: 'platform/logs/editor-failure.png' }).catch(() => {}); throw error; }
finally { await browser.close(); await fix.close(); }
