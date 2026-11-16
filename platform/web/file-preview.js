import { codeDisplay } from './code-display.js';
let previewSequence = 0, releasePreview;
export async function previewFile({ api, info, el, href, path, name }) {
  const sequence = ++previewSequence; releasePreview?.(); releasePreview = null;
  const loading = el('p', { class: 'help' }, 'Loading file…'); info(name || path.split('/').pop(), loading);
  const dialog = document.querySelector('#info-dialog'), current = () => sequence === previewSequence && dialog?.open && loading.isConnected;
  const original = () => el('a', { class: 'secondary-button', href, download: name || path.split('/').pop() }, 'Download original');
  try {
    const file = await api(href.replace(/^\/api/, '') + '&preview=1'); if (!current()) return;
    // Download the inspected UTF-8 snapshot, not a second read that may have changed on disk.
    const snapshot = URL.createObjectURL(new Blob([file.content], { type: 'application/octet-stream' }));
    const release = () => { URL.revokeObjectURL(snapshot); dialog.removeEventListener('close', release); };
    releasePreview = release; dialog.addEventListener('close', release, { once: true });
    info(file.name, codeDisplay(file.content, { filename: file.name }), el('a', { class: 'secondary-button', href: snapshot, download: file.name }, 'Download original'));
  } catch (error) { if (current()) info(name || path, el('p', { class: 'help', role: 'alert' }, error.message), original()); }
}
