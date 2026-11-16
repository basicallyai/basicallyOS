/** Use an installed browser in a fresh temporary profile. Never connect to personal tabs/cookies. */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, delimiter } from 'node:path';
import puppeteer from 'puppeteer-core';
import { parseHTML } from 'linkedom';
const exec = promisify(execFile);
let discovery;
export function installedBrowsers() { return discovery ||= discoverBrowsers(); }
async function discoverBrowsers() {
  const rows = [], add = (id, name, family, paths) => { const path = paths.find(path => path && existsSync(path)); if (path) rows.push({ id, name, family, executablePath: path }); };
  let preferred = '';
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean), paths = path => roots.map(root => join(root, path));
    add('firefox', 'Firefox', 'firefox', paths('Mozilla Firefox/firefox.exe'));
    add('edge', 'Microsoft Edge', 'chrome', paths('Microsoft/Edge/Application/msedge.exe'));
    add('chrome', 'Google Chrome', 'chrome', paths('Google/Chrome/Application/chrome.exe'));
    add('brave', 'Brave', 'chrome', paths('BraveSoftware/Brave-Browser/Application/brave.exe'));
    try { const { stdout } = await exec('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { timeout: 2500, windowsHide: true }); preferred = /firefox/i.test(stdout) ? 'firefox' : /brave/i.test(stdout) ? 'brave' : /chrome/i.test(stdout) ? 'chrome' : /mse|edge/i.test(stdout) ? 'edge' : ''; } catch {}
  } else if (process.platform === 'darwin') {
    const roots = ['/Applications', join(process.env.HOME || '', 'Applications')], paths = path => roots.map(root => join(root, path));
    add('firefox', 'Firefox', 'firefox', paths('Firefox.app/Contents/MacOS/firefox'));
    add('chrome', 'Google Chrome', 'chrome', paths('Google Chrome.app/Contents/MacOS/Google Chrome'));
    add('edge', 'Microsoft Edge', 'chrome', paths('Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
    add('brave', 'Brave', 'chrome', paths('Brave Browser.app/Contents/MacOS/Brave Browser'));
    try { const file = join(process.env.HOME || '', 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'), { stdout } = await exec('/usr/bin/plutil', ['-extract', 'LSHandlers', 'json', '-o', '-', file], { timeout: 2500 }); const handler = JSON.parse(stdout).find(row => row.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll || ''; preferred = /firefox/i.test(handler) ? 'firefox' : /brave/i.test(handler) ? 'brave' : /chrome/i.test(handler) ? 'chrome' : /edge/i.test(handler) ? 'edge' : ''; } catch {}
  } else {
    const paths = names => names.flatMap(name => (process.env.PATH || '').split(delimiter).filter(Boolean).map(root => join(root, name)));
    add('firefox', 'Firefox', 'firefox', paths(['firefox', 'firefox-esr'])); add('chrome', 'Google Chrome', 'chrome', paths(['google-chrome', 'google-chrome-stable'])); add('edge', 'Microsoft Edge', 'chrome', paths(['microsoft-edge', 'microsoft-edge-stable'])); add('chromium', 'Chromium', 'chrome', paths(['chromium', 'chromium-browser'])); add('brave', 'Brave', 'chrome', paths(['brave-browser', 'brave']));
    try { const { stdout } = await exec('xdg-settings', ['get', 'default-web-browser'], { timeout: 2500 }); preferred = /firefox/i.test(stdout) ? 'firefox' : /brave/i.test(stdout) ? 'brave' : /chromium/i.test(stdout) ? 'chromium' : /chrome/i.test(stdout) ? 'chrome' : /edge/i.test(stdout) ? 'edge' : ''; } catch {}
  }
  rows.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred)); return rows;
}
async function stopBrowser(browser) { let timer; await Promise.race([browser.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(() => { browser.process()?.kill('SIGKILL'); resolve(); }, 3000); })]).finally(() => clearTimeout(timer)); }
async function abortable(task, signal) { let onAbort; const aborted = new Promise((_, reject) => { onAbort = () => reject(new Error('Browser research was cancelled or timed out.')); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }); return Promise.race([task, aborted]).finally(() => signal.removeEventListener('abort', onAbort)); }
export class InstalledBrowserReader {
  constructor({ fetch, browser, launch = options => puppeteer.launch(options) }) { Object.assign(this, { fetch, browser, launch }); this.active = new Set(); }
  async read(input, { signal } = {}) {
    const url = new URL(input); if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('Web tools accept public HTTPS URLs on port 443 only.');
    const selected = this.browser(); if (!selected || !existsSync(selected.executablePath)) throw new Error('No supported installed browser was found. Install or select Firefox, Chrome, Edge, Brave or Chromium in Web browsing settings. No browser is downloaded automatically.');
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]); signal.throwIfAborted();
    let browser, failure, pageResult;
    const cancel = () => { if (browser) stopBrowser(browser).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const operation = (async () => {
      const launchOptions = { browser: selected.family, executablePath: selected.executablePath, headless: true, timeout: 20000, protocolTimeout: 25000, args: selected.family === 'chrome' ? ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] : [], extraPrefsFirefox: { 'network.prefetch-next': false, 'network.dns.disablePrefetch': true, 'network.http.speculative-parallel-limit': 0, 'dom.serviceWorkers.enabled': false, 'media.peerconnection.enabled': false } };
      // Firefox can lose its initial BiDi handshake under startup contention. Retrying
      // with a fresh profile is safe: no webpage or search has been requested yet.
      for (let attempt = 0; !browser; attempt++) {
        try { browser = await this.launch(launchOptions); }
        catch (error) {
          if (selected.family !== 'firefox' || attempt >= 2 || signal.aborted || !/session\.new timed out/i.test(error.message)) throw error;
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      this.active.add(browser); if (signal.aborted) { await stopBrowser(browser); this.active.delete(browser); signal.throwIfAborted(); } const userAgent = await browser.userAgent(), page = await browser.newPage(); if (selected.family !== 'firefox') await page.setJavaScriptEnabled(false); await page.setRequestInterception(true);
      // Every webpage request is fulfilled by the bounded DNS-pinned HTTPS transport. All
      // subresources, secondary navigations, scripts and local-network requests are blocked.
      page.on('request', request => { (async () => {
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame() || request.url() !== url.href || pageResult) { await request.abort('blockedbyclient'); return; }
        try {
          pageResult = await this.fetch(url.href, { signal, headers: { 'User-Agent': userAgent, 'Accept-Language': 'en-US,en;q=0.8' } });
          if (!/text\/html|text\/plain|application\/xhtml/i.test(pageResult.type)) throw new Error('This URL is not a readable HTML/text webpage.');
          let body;
          if (/text\/plain/i.test(pageResult.type)) { body = '<html><body><pre>' + pageResult.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;') + '</pre></body></html>'; }
          else { const { document } = parseHTML(pageResult.text); document.querySelectorAll('script,iframe,frame,object,embed,base,link,meta[http-equiv]').forEach(node => node.remove()); body = document.toString(); }
          await request.respond({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': "default-src 'none'; form-action 'none'; frame-src 'none'" }, body });
        } catch (error) { failure = error; await request.abort('failed').catch(() => {}); }
      })().catch(error => { failure ||= error; request.abort('failed').catch(() => {}); }); });
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }); signal.throwIfAborted(); if (failure) throw failure; if (!pageResult) throw new Error('The installed browser did not return a webpage.');
      return { ...pageResult, text: /text\/plain/i.test(pageResult.type) ? pageResult.text : await page.content(), browser: selected.name };
      })(); return await abortable(operation, signal);
    } catch (error) { if (signal.aborted) throw new Error('Browser research was cancelled or timed out.'); throw failure || new Error('Installed browser research failed: ' + error.message); }
    finally { signal.removeEventListener('abort', cancel); if (browser) { this.active.delete(browser); await stopBrowser(browser); } }
  }
  async close() { await Promise.all([...this.active].map(browser => stopBrowser(browser))); this.active.clear(); }
}
