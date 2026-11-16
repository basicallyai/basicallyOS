/** Product-owned storage. Atomic, serialized writes; credentials never enter public views. */
import { mkdir, readFile, readdir, rename, writeFile, chmod, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function atomicJson(path, value) { return atomicText(path, JSON.stringify(value, null, 2) + '\n'); }
export async function atomicText(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, value, { mode: 0o600 });
    // Windows indexers/read handles can briefly deny replacement. Never unlink the live file.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break; }
      catch (error) {
        if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(Math.min(15 * 2 ** attempt, 250));
      }
    }
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}
export class Store {
  constructor(home) { this.home = resolve(home); this.directory = join(this.home, 'app'); this.queue = Promise.resolve(); }
  async initialize() {
    await mkdir(join(this.directory, 'chats'), { recursive: true, mode: 0o700 });
    this.config = await readJson(join(this.directory, 'connections.json'), null);
    if (!this.config) {
      this.config = { version: 2, initialized: true, providers: [], defaultModel: null };
      await atomicJson(join(this.directory, 'connections.json'), this.config);
    }
    this.settings = { theme: 'dark', instructions: '', maxTurns: 16, memoryMode: 'review', memoryRetentionDays: 0, reasoningLevel: 'medium', reasoningOverrides: {}, ...await readJson(join(this.directory, 'settings.json'), {}) };
    this.memoryPath = join(this.directory, 'MEMORY.md');
    try { await writeFile(this.memoryPath, '# Memory\n\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  exclusive(callback) {
    const operation = this.queue.then(callback);
    this.queue = operation.catch(() => {});
    return operation;
  }
  saveConfig(next) {
    return this.exclusive(async () => { await atomicJson(join(this.directory, 'connections.json'), next); this.config = next; });
  }
  updateConfig(callback) {
    return this.exclusive(async () => {
      const next = await callback(structuredClone(this.config));
      await atomicJson(join(this.directory, 'connections.json'), next); this.config = next;
      return next;
    });
  }
  saveSettings(value) {
    return this.exclusive(async () => {
      if (Object.keys(value).some(key => !['theme', 'instructions', 'maxTurns', 'memoryMode', 'memoryRetentionDays', 'reasoningLevel', 'reasoningOverrides'].includes(key))) throw new Error('Unknown preference.');
      const next = { ...this.settings, ...value };
      if (value.reasoningOverrides && typeof value.reasoningOverrides === 'object' && !Array.isArray(value.reasoningOverrides)) next.reasoningOverrides = { ...this.settings.reasoningOverrides, ...value.reasoningOverrides };
      if (!['light', 'dark', 'system'].includes(next.theme)) throw new Error('Choose a valid theme.');
      if (typeof next.instructions !== 'string' || next.instructions.length > 30000) throw new Error('Instructions must be at most 30,000 characters.');
      if (!Number.isInteger(next.maxTurns) || next.maxTurns < 1 || next.maxTurns > 64) throw new Error('Request limit must be between 1 and 64.');
      if (!['off', 'review', 'automatic'].includes(next.memoryMode) || !Number.isInteger(next.memoryRetentionDays) || next.memoryRetentionDays < 0 || next.memoryRetentionDays > 3650) throw new Error('Choose a valid memory mode and retention (0–3,650 days).');
      if (!['off', 'minimal', 'low', 'medium', 'high'].includes(next.reasoningLevel)) throw new Error('Choose a valid reasoning effort.');
      if (!next.reasoningOverrides || typeof next.reasoningOverrides !== 'object' || Array.isArray(next.reasoningOverrides) || Object.entries(next.reasoningOverrides).length > 500 || Object.entries(next.reasoningOverrides).some(([key, level]) => key.length > 400 || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(level))) throw new Error('Invalid per-model reasoning preferences.');
      await atomicJson(join(this.directory, 'settings.json'), next); this.settings = next;
      return next;
    });
  }
  async memory() {
    const content = await readFile(this.memoryPath, 'utf8');
    if (Buffer.byteLength(content) > 65536 || content.includes('\0')) throw new Error('MEMORY.md must be UTF-8 text smaller than 64 KB.');
    return { content, revision: createHash('sha256').update(content).digest('hex') };
  }
  saveMemory({ content, revision } = {}) {
    return this.exclusive(async () => {
      if (typeof content !== 'string' || Buffer.byteLength(content) > 65536 || content.includes('\0')) throw new Error('Memory must be text smaller than 64 KB.');
      if (!revision || revision !== (await this.memory()).revision) throw new Error('Memory changed since you opened it. Reload before saving to avoid overwriting another edit.');
      await atomicText(this.memoryPath, content); return this.memory();
    });
  }
  deleteChat(id) { return this.exclusive(() => rm(this.chatPath(id), { force: true })); }
  chatPath(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid conversation ID.');
    return join(this.directory, 'chats', id + '.json');
  }
  async chat(id) { const value = await readJson(this.chatPath(id), null); if (!value) throw new Error('Conversation not found.'); return value; }
  async list(includeArchived = false) {
    const files = (await readdir(join(this.directory, 'chats'))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    const chats = await Promise.all(files.map(name => readJson(join(this.directory, 'chats', name), null)));
    return chats.filter(chat => chat && (includeArchived || !chat.archived)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  saveChat(chat) { return this.exclusive(() => atomicJson(this.chatPath(chat.id), chat)); }
  async createChat(selection = this.config.defaultModel, { workspaceIds = [], surface = 'chat' } = {}) {
    const chat = { id: randomUUID(), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), selection,
      messages: [], inputs: [], ledger: [], archived: false, workspaceIds, surface };
    await this.saveChat(chat); return chat;
  }
}
