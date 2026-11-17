/** Validate the actual npm tarball, not just package metadata. Never publish or use paid APIs. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, access, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const packageName = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run test:package.');
const directory = await mkdtemp(join(tmpdir(), 'basically npm test '));
function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
}
function runNpm(args, cwd = directory) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { stop(child); reject(new Error('npm command timed out: ' + args[0])); }, 180000);
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept(output) : reject(new Error(`npm ${args[0]} failed (${code}):\n${errors}\n${output}`)); });
  });
}
async function freePort() {
  const probe = createServer(); await new Promise(accept => probe.listen(0, '127.0.0.1', accept));
  const port = probe.address().port; await new Promise(accept => probe.close(accept)); return port;
}
async function smoke(executableArgs, label) {
  const port = await freePort(), home = join(directory, label + ' data');
  const child = spawn(process.execPath, [...executableArgs, '--no-open', '--port', String(port), '--data-dir', home], {
    cwd: directory, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    const url = await new Promise((accept, reject) => {
      // npx must first extract/install the local tarball; a cold Windows cache can exceed a minute.
      const timer = setTimeout(() => reject(new Error(label + ' did not start.\n' + output)), label.startsWith('npx') ? 180000 : 60000);
      child.stdout.on('data', data => {
        output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
        if (match) { clearTimeout(timer); accept(match[0]); }
      });
      child.stderr.on('data', data => output += data);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(label + ' exited: ' + code + '\n' + output)); });
    });
    const login = await fetch(url), cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const html = await login.text(); assert.match(html, /Space to think/);
    const base = `http://127.0.0.1:${port}`;
    const bootstrap = await (await fetch(base + '/api/bootstrap', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(bootstrap.providers, []); assert.equal(bootstrap.defaultModel, null);
    assert.equal(bootstrap.localModelDirectory, join(home, 'models'));
    for (const path of ['/app.js', '/theme.css', '/knowledge.css', '/layout.css', '/knowledge.js', '/markdown.js', '/math.js', '/render-dom.js', '/stream-state.js', '/split-layout.js', '/model-picker.js', '/model-editor.js', '/tool-output.js', '/canvas.js', '/note-names.js', '/copy-button.js', '/code-display.js', '/file-preview.js', '/workspace.css', '/vendor/editor.js', '/vendor/EDITOR-LICENSES.txt', '/vendor/katex.mjs', '/vendor/katex.css', '/vendor/fonts/KaTeX_Main-Regular.woff2', '/wiki.js', '/editor-text.js', '/memory-ui.js', '/vendor/highlight.js', '/vendor/marked.js', '/vendor/purify.js', '/icons.svg', '/dm-sans.ttf']) {
      const response = await fetch(base + path, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, label + ': missing ' + path); assert.ok((await response.arrayBuffer()).byteLength > 100);
    }
    for (const path of ['/api/workspaces', '/api/memories', '/api/knowledge/layout']) { const response = await fetch(base + path, { headers: { Cookie: cookie } }); assert.equal(response.status, 200, label + ': missing ' + path); }
    const notes = (await (await fetch(base + '/api/workspaces', { headers: { Cookie: cookie } })).json()).workspaces.find(row => row.managed === 'notes'); assert.ok(notes); assert.equal(notes.root, await realpath(join(home, 'notes')));
    const saved = await fetch(base + '/api/resources/save', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: notes.id, path: 'Packaged.md', content: '# Packaged notes\n\n$$x^2$$', revision: null }) }); assert.equal(saved.status, 200); assert.match(await readFile(join(home, 'notes/Packaged.md'), 'utf8'), /Packaged notes/);
    const post = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status < 300, true, path); return response.json(); };
    const chat = await post('/api/chats', {}), canvas = await post('/api/chats/' + chat.id + '/canvases', { title: 'Packaged Canvas', content: '# Standalone Canvas\n\nSaved by the installed app.' });
    const linked = await post('/api/chats/' + chat.id + '/canvases/' + canvas.canvasId + '/notes', {}); assert.ok(linked.noteId); assert.match(await readFile(join(home, 'notes/Packaged Canvas.md'), 'utf8'), /Saved by the installed app/);
    const web = await (await fetch(base + '/api/web-search', { headers: { Cookie: cookie } })).json(); assert.equal(web.provider, 'browser'); assert.equal(typeof web.configured, 'boolean'); assert.ok(Array.isArray(web.browsers)); assert.deepEqual(web.apiConfigured, { brave: false, tavily: false }); assert.equal(web.apiKey, undefined); assert.equal(JSON.stringify(web).includes('executablePath'), false);
    await access(join(home, 'app/connections.json'));
    console.log(label + ': startup, authentication, empty model setup, persistent notes/standalone Canvas/Save to Notes, local rich-editor/code assets, KaTeX/fonts and opt-in search setup passed.');
  } finally {
    const exited = new Promise(accept => { if (child.exitCode !== null) accept(); else child.once('close', accept); });
    stop(child); await exited;
  }
}
try {
  const manifest = JSON.parse(await runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory], root))[0];
  assert.equal(manifest.name, '@basicallyai/bos');
  assert.ok(manifest.files.some(file => file.path === 'LICENSE'), 'Product license is missing from the package.');
  assert.ok(manifest.files.some(file => file.path === 'bin/basically-os.mjs')); assert.ok(manifest.files.some(file => file.path === 'platform/folder-picker.mjs'), 'Native folder picker is missing from the package.');
  assert.ok(manifest.files.every(file => !/(^|\/)(\.platform-home|workspaces|local-models|node_modules|logs|tests|releases)(\/|$)/.test(file.path)), 'Tarball leaked private or development files.');
  const tarball = join(directory, manifest.filename), prefix = join(directory, 'global install');
  console.log('Tarball allowlist and executable checked. Installing with npm…');
  await runNpm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const installed = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', ...packageName.split('/'));
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@basicallyai/bos'); assert.equal(metadata.license, 'Apache-2.0');
  assert.equal(metadata.repository.url, 'git+https://github.com/basicallyai/basicallyOS.git');
  assert.equal(metadata.bin['basically-os'], 'bin/basically-os.mjs'); assert.ok(!existsSync(join(installed, 'node_modules/playwright')));
  await access(process.platform === 'win32' ? join(prefix, 'basically-os.cmd') : join(prefix, 'bin/basically-os'));
  await smoke([join(installed, 'bin/basically-os.mjs')], 'npm global install');
  const execArgs = [npmCli, 'exec', '--yes', '--offline', '--package', tarball, '--', 'basically-os'];
  await smoke(execArgs, 'npx local tarball');
  assert.ok(!existsSync(join(installed, '.platform-home')), 'App wrote state into its installation.');
  console.log('npm and npx package checks passed. No registry publication or paid model requests.');
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); }
