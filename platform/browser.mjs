/** Open this app explicitly in Firefox, never the operating system default. */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export function firefoxCommand(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const candidates = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter(Boolean).map(folder => resolve(folder, 'Mozilla Firefox/firefox.exe'));
    return candidates.find(path => existsSync(path)) ?? 'firefox.exe';
  }
  return platform === 'darwin' ? '/usr/bin/open' : 'firefox';
}

export function openBrowser(url) {
  const args = process.platform === 'darwin' ? ['-a', 'Firefox', url] : ['-new-tab', url];
  const browser = spawn(firefoxCommand(), args, { detached: true, stdio: 'ignore', windowsHide: true });
  browser.on('error', () => console.error('Firefox could not be opened. Open the printed local link in your browser.'));
  browser.unref();
}

export function forwardLauncherOutput(child, open = true) {
  let tail = '', opened = false;
  child.stdout.on('data', data => {
    process.stdout.write(data);
    tail = (tail + data.toString()).slice(-8192);
    const match = tail.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[a-zA-Z0-9_-]+(?=\s)/);
    if (!open || opened || !match) return;
    opened = true;
    openBrowser(match[0]);
  });
}