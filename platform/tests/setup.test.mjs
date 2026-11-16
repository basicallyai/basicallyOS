import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixture, mockProvider, connect } from './helpers.mjs';
import { createApp } from '../server.mjs';
import { defaultDataDirectory, appPaths } from '../paths.mjs';
import { normalizeModel, PROTOCOLS } from '../providers.mjs';

test('first launch has zero providers, zero model IDs, no default and no static catalog API', async t => {
  const fix = await fixture(); t.after(() => fix.close());
  const bootstrap = await fix.request('/api/bootstrap');
  assert.deepEqual(bootstrap.providers, []); assert.equal(bootstrap.defaultModel, null);
  await assert.rejects(fix.request('/api/catalog/anything'), /404/);
  const model = normalizeModel({ id: 'an-exact-user-supplied-id' });
  assert.equal(model.cost, null); assert.equal(model.vision, false); assert.equal(model.reasoning, false);
  assert.deepEqual(PROTOCOLS, ['openai-completions', 'openai-responses']);
  await assert.rejects(fix.request('/api/chats', { selection: { provider: 'not-added', model: 'not-added' } }), /removed/);
});

test('upgrade removes old presets, privately backs them up and preserves manual custom connections/history', async t => {
  const fix = await fixture(), mock = await mockProvider(); let second;
  t.after(async () => { await second?.close(); await fix.close(); await mock.close(); });
  const selection = await connect(fix, mock, { id: 'api-mine' });
  const chat = await fix.app.store.createChat(selection);
  const old = { ...fix.app.store.config, version: 1, providers: [
    { id: 'legacy-preset', name: 'Retired preset', apiKey: 'do-not-expose', models: [{ id: 'old-bundled-id' }] },
    { id: 'api-retired', name: 'Unsupported connection', api: 'retired-wire-format', models: [{ id: 'old-custom-id' }] },
    ...fix.app.store.config.providers,
  ], defaultModel: { provider: 'legacy-preset', model: 'old-bundled-id' } };
  await fix.app.store.saveConfig(old);
  second = await createApp({ root: fix.directory, home: join(fix.directory, 'home'), port: 0, local: { close: async () => {} } });
  assert.deepEqual(second.store.config.providers.map(provider => provider.id), ['api-mine']);
  assert.equal(second.store.config.defaultModel, null); assert.equal(second.store.config.version, 2);
  const backup = JSON.parse(await readFile(join(second.store.directory, 'connections.pre-user-models.json'), 'utf8'));
  assert.equal(backup.providers[0].apiKey, 'do-not-expose'); assert.equal((await second.store.chat(chat.id)).id, chat.id);
});

test('installed app paths use persistent user storage; explicit data directory owns files as well as settings', () => {
  assert.equal(defaultDataDirectory('linux', { XDG_DATA_HOME: '/data' }, '/home/test'), join('/data', 'basically-os'));
  assert.equal(defaultDataDirectory('darwin', {}, '/home/test'), join('/home/test', 'Library', 'Application Support', 'basically-os'));
  const paths = appPaths({ dataDir: '/isolated-profile' }, {});
  assert.equal(paths.workspaceRoot, join(paths.home, 'workspaces')); assert.equal(paths.modelDirectory, join(paths.home, 'models'));
});
