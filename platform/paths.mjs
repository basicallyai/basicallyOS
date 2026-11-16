import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export function defaultDataDirectory(platform = process.platform, env = process.env, userHome = homedir()) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || env.APPDATA || join(userHome, 'AppData', 'Local'), 'basically-os');
  if (platform === 'darwin') return join(userHome, 'Library', 'Application Support', 'basically-os');
  return join(env.XDG_DATA_HOME || join(userHome, '.local', 'share'), 'basically-os');
}
export function appPaths(options = {}, env = process.env) {
  const source = existsSync(resolve(packageRoot, '.gitignore')) && existsSync(resolve(packageRoot, 'platform/tests'));
  const explicitHome = options.dataDir || env.BASICALLY_HOME;
  const home = resolve(explicitHome || (source ? resolve(packageRoot, '.platform-home') : defaultDataDirectory()));
  return { root: packageRoot, home,
    workspaceRoot: resolve(options.workspaceDir || env.BASICALLY_WORKSPACES || (source && !explicitHome ? resolve(packageRoot, 'workspaces') : resolve(home, 'workspaces'))),
    modelDirectory: resolve(options.modelsDir || env.BASICALLY_MODELS || (source && !explicitHome ? resolve(packageRoot, 'local-models') : resolve(home, 'models'))) };
}
