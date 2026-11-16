/** Native folder chooser for the local, authenticated app. No shell interpolation. */
import { spawn } from 'node:child_process';

const TIMEOUT = 15 * 60 * 1000;
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose a folder for basically OS - open the folder you want'
$dialog.ValidateNames = $false
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.RestoreDirectory = $true
$dialog.DereferenceLinks = $true
$dialog.AddExtension = $false
$dialog.DefaultExt = 'folder'
$dialog.FileName = 'This folder.folder'
$dialog.Filter = 'Current folder|*.folder'
$dialog.FilterIndex = 1
$result = $dialog.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write('__BASICALLY_CANCELLED__')
} else {
    $chosen = $dialog.FileName
    if (Test-Path -LiteralPath $chosen -PathType Container) { $path = (Resolve-Path -LiteralPath $chosen).Path }
    else { $path = [System.IO.Path]::GetDirectoryName($chosen) }
    if ([string]::IsNullOrWhiteSpace($path)) { [Console]::Out.Write('__BASICALLY_CANCELLED__') }
    else { [Console]::Out.Write($path) }
}
`;
const MAC_SCRIPT = 'try\nPOSIX path of (choose folder with prompt "Choose a folder for basically OS")\non error number -128\nreturn "__BASICALLY_CANCELLED__"\nend try';

export function folderDialogs(platform = process.platform) {
  if (platform === 'win32') return [{ command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', WINDOWS_SCRIPT], cancelOnExit: false }];
  if (platform === 'darwin') return [{ command: 'osascript', args: ['-e', MAC_SCRIPT], cancelOnExit: true }];
  return [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=Choose a folder for basically OS'], cancelOnExit: true, allowMissing: true },
    { command: 'kdialog', args: ['--getexistingdirectory', '.', '--title', 'Choose a folder for basically OS'], cancelOnExit: true, allowMissing: true },
  ];
}

function runDialog(dialog, { spawnFn, platform, timeout }) {
  return new Promise((accept, reject) => {
    let child;
    try { child = spawnFn(dialog.command, dialog.args, { windowsHide: dialog.command === 'powershell.exe', stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
    catch (error) { reject(error); return; }
    let out = '', err = '', settled = false, timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); accept({ error, value, missing: error?.code === 'ENOENT' }); };
    timer = setTimeout(() => { child.kill?.('SIGKILL'); finish(new Error('Folder picker timed out.')); }, timeout);
    child.stdout?.on('data', chunk => { if (out.length < 65536) out += chunk.toString(); });
    child.stderr?.on('data', chunk => { if (err.length < 65536) err += chunk.toString(); });
    child.once?.('error', error => finish(error));
    child.once?.('close', code => {
      if (code === 0) { const value = out.trim(); finish(null, value === '__BASICALLY_CANCELLED__' ? null : value); }
      else if (out.includes('__BASICALLY_CANCELLED__') || dialog.cancelOnExit) finish(null, null);
      else finish(new Error((err || out).trim() || 'The folder picker could not be opened.'));
    });
  });
}

export function createFolderPicker({ platform = process.platform, spawnFn = spawn, timeout = TIMEOUT } = {}) {
  let active = null;
  return {
    async pick() {
      if (active) throw new Error('A folder picker is already open. Finish or cancel it first.');
      const task = (async () => {
        for (const dialog of folderDialogs(platform)) {
          const result = await runDialog(dialog, { spawnFn, platform, timeout });
          if (result.missing && dialog.allowMissing) continue;
          if (result.missing) throw new Error('The native folder picker could not be started. Install a desktop folder chooser or enter the path manually.');
          if (result.error) throw result.error;
          return result.value ? { path: result.value } : { cancelled: true };
        }
        throw new Error('No native desktop folder picker is available. Install zenity or kdialog, or enter the path manually.');
      })();
      active = task;
      try { return await task; } finally { active = null; }
    },
  };
}
