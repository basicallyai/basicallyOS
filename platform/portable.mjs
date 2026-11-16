/** The portable archive already contains Node, production dependencies and optional Python. */
import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.env.PATH = resolve(root, 'runtime') + delimiter + process.env.PATH;
process.env.BASICALLY_HOME ||= resolve(root, '.platform-home');
process.env.BASICALLY_WORKSPACES ||= resolve(root, 'workspaces');
process.env.BASICALLY_MODELS ||= resolve(root, 'local-models');
const python = resolve(root, process.platform === 'win32' ? 'runtime/python/python.exe' : 'runtime/python/bin/python3');
if (existsSync(python) && !process.env.AGENT_PLATFORM_PYTHON) process.env.AGENT_PLATFORM_PYTHON = python;
await import('./start.mjs');
