/** Exercise the editor's actual plain-text clipboard parser, rather than assigning HTML or model state. */
export async function pasteMarkdown(locator, text) {
  await locator.fill('');
  await locator.evaluate((node, text) => { const data = new DataTransfer(); data.setData('text/plain', text); node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, text);
}
