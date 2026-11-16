/** Optional inference worker, started only when the local model library is used. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

export class LocalWorker {
  constructor(root, home = resolve(root, '.platform-home'), modelDirectory = resolve(root, 'local-models')) { this.root = root; this.home = home; this.modelDirectory = modelDirectory; this.token = randomBytes(32).toString('hex'); this.stopped = false; }
  ensure() {
    if (this.stopped) return Promise.reject(new Error('Local worker has stopped.'));
    if (this.failure) return Promise.reject(new Error(this.failure));
    if (this.ready) return this.ready;
    this.ready = new Promise((accept, reject) => {
      const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
      const installedRuntime = resolve(this.home, 'runtime', executable);
      const venv = existsSync(installedRuntime) ? installedRuntime : resolve(this.root, '.venv', executable);
      const python = process.env.AGENT_PLATFORM_PYTHON || (existsSync(venv) ? venv : process.platform === 'win32' ? 'py' : 'python3');
      const args = python === 'py' ? ['-3.12'] : [];
      args.push(resolve(this.root, 'platform/model_runtime.py'), '--root', this.modelDirectory, '--settings', resolve(this.home, 'local-settings.json'));
      const child = this.child = spawn(python, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', AGENT_PLATFORM_WORKER_TOKEN: this.token } });
      let diagnostics = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Local inference did not start. Install Python 3.12 or configure a local API endpoint instead.')); }, 30000);
      const lines = createInterface({ input: child.stdout });
      lines.once('line', line => {
        try {
          const { port } = JSON.parse(line);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid worker port.');
          this.port = port; clearTimeout(timer); accept();
        } catch (error) { child.kill(); clearTimeout(timer); reject(error); }
      });
      child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-2000); });
      child.once('error', error => { clearTimeout(timer); this.failure = error.message; reject(error); });
      child.once('exit', code => {
        clearTimeout(timer); lines.close();
        this.failure = `Local inference worker stopped (${code}). ${diagnostics}`;
        reject(new Error(this.failure));
      });
    });
    return this.ready;
  }
  async request(path, body) {
    await this.ensure();
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path === '/load' ? 600000 : 30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Local inference request failed.');
    return result;
  }
  async connection() {
    const state = await this.request('/status');
    if (!state.model || !['ready', 'generating'].includes(state.phase)) throw new Error('Load a model in Local models first.');
    if (!Number.isInteger(state.contextWindow) || state.contextWindow < 2 || !Number.isInteger(state.maxTokens) || state.maxTokens < 1) throw new Error('The loaded model has no verified context/output limits. Check its repository config.');
    return { id: 'local', name: 'Local', api: 'openai-completions', baseUrl: `http://127.0.0.1:${this.port}/v1`, requiresKey: true, apiKey: this.token,
      models: [{ id: 'local-model', name: state.displayName || state.model, contextWindow: state.contextWindow, maxTokens: state.maxTokens, reasoning: false, vision: false, tools: false, cost: null }] };
  }
  async close() {
    this.stopped = true;
    const child = this.child;
    if (child && child.exitCode === null && child.pid) await new Promise(resolve => {
      child.once('exit', resolve); child.kill(); const timer = setTimeout(resolve, 3000); timer.unref();
    });
  }
}
