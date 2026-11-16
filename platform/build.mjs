/** This is a direct Node/browser app, not a repository build. Verify the distributable inputs. */
import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const { bundleEditor } = await import('./editor-bundle.mjs'); await bundleEditor();
const files = (await readdir(resolve(root, 'platform'))).filter(file => file.endsWith('.mjs')).map(file => 'platform/' + file);
files.push(...(await readdir(resolve(root, 'platform/web'))).filter(file => file.endsWith('.js')).map(file => 'platform/web/' + file), 'bin/basically-os.mjs');
for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(`Syntax check failed: ${file}\n${check.stderr}`);
}
for (const file of ['platform/web/index.html', 'platform/web/theme.css', 'platform/web/knowledge.css', 'platform/web/layout.css', 'platform/web/canvas.js', 'platform/web/note-names.js', 'node_modules/katex/dist/katex.mjs', 'node_modules/katex/dist/katex.min.css', 'platform/ARCHITECTURE.md', 'platform/assets/brand-mark.svg', 'platform/assets/dm-sans.ttf', 'platform/assets/space-mono.ttf', 'node_modules/marked/lib/marked.esm.js', 'node_modules/dompurify/dist/purify.es.mjs', 'node_modules/@highlightjs/cdn-assets/highlight.min.js', 'node_modules/diff/libesm/index.js']) await access(resolve(root, file));
await import('@earendil-works/pi-agent-core'); await import('./providers.mjs');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (packageJson.dependencies['@earendil-works/pi-coding-agent']) throw new Error('The full coding-agent package is not required.');
if (packageJson.private || packageJson.bin?.['basically-os'] !== 'bin/basically-os.mjs') throw new Error('Missing npm/npx executable metadata.');
console.log(`Verified ${files.length} modules, browser assets, npm/npx entry point and pinned Pi packages. Ready: npm start\nThe local editor bundle is included in distributions; installed copies need no build or repository checkout.`);
