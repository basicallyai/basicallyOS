import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
export async function bundleEditor() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({ metafile: true, entryPoints: [fileURLToPath(new URL('./web/rich-editor-source.js', import.meta.url))], outfile: fileURLToPath(new URL('./web/vendor/editor.js', import.meta.url)), bundle: true, external: ['/vendor/*', '/markdown.js'], format: 'esm', minify: true, target: ['chrome120', 'firefox121', 'safari17'], legalComments: 'eof' });
  const packages = new Set(Object.keys(result.metafile.inputs).map(path => path.match(/node_modules[\\/](?:(@[^\\/]+)[\\/])?([^\\/]+)/)).filter(Boolean).map(match => (match[1] ? match[1] + '/' : '') + match[2]));
  const notices = [];
  for (const name of [...packages].sort()) {
    const directory = resolve(root, 'node_modules', name), metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory)).filter(file => /^(license|copying)(\.|$)/i.test(file));
    notices.push(name + '@' + metadata.version + ' (' + (metadata.license || 'See notice') + ')\n' + (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('\n'));
  }
  await writeFile(new URL('./web/vendor/EDITOR-LICENSES.txt', import.meta.url), notices.join('\n\n────────────────────────────────\n\n'));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await bundleEditor();
