import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from './server.mjs';
import { openBrowser } from './browser.mjs';
import { appPaths, packageRoot } from './paths.mjs';

export function parseArguments(args) {
  const options = { port: Number(process.env.PORT || 3080), noOpen: process.env.AGENT_PLATFORM_NO_OPEN === '1' };
  const values = { '--port': 'port', '--data-dir': 'dataDir', '--workspace-dir': 'workspaceDir', '--models-dir': 'modelsDir' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-v') options.version = true;
    else if (argument === '--no-open') options.noOpen = true;
    else if (values[argument]) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + argument + '.');
      options[values[argument]] = argument === '--port' ? Number(value) : value;
    } else throw new Error('Unknown option: ' + argument + '. Use --help.');
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Use a port between 1 and 65535.');
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log(`basically-os — your models, your assistant\n\nUsage: basically-os [options]\n       npx @basicallyai/bos [options]\n       npm start -- [options]\n\n  --port <number>          Local port (default: 3080)\n  --no-open                Print the link without opening a browser\n  --data-dir <path>        Private settings, keys and conversation directory\n  --workspace-dir <path>   Uploaded and generated files directory\n  --models-dir <path>      Optional local model library\n  -h, --help               Show this help\n  -v, --version            Show package version\n\nOpenRouter is preselected for setup. Add your key and exact model ID, or connect a custom endpoint.\nInstalled/npm/npx runs store data in your user data directory, never the package cache.`);
    return;
  }
  if (options.version) { console.log(JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')).version); return; }
  const paths = appPaths(options);
  const app = await createApp({ ...paths, port: options.port });
  console.log(`\n  basically OS\n\n  ${app.url}\n\n  Data: ${paths.home}\n  Keep this window open. Press Ctrl+C to stop.\n`);
  if (!options.noOpen) openBrowser(app.url);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000); timeout.unref();
    try { await app.close(); } finally { clearTimeout(timeout); }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return app;
}
// Importing this module is the executable entry used by npm, npx and the portable launcher.
if (!process.env.BASICALLY_CLI_IMPORT_ONLY) {
  try { await main(); }
  catch (error) { console.error(error.code === 'EADDRINUSE' ? 'That port is in use. Close the existing app or use --port 3081.' : error.message); process.exitCode = 1; }
}
