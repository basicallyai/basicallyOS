/** Explicit real CPU/Pi integration check using temporary random weights; never downloads a model. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalWorker } from './local-worker.mjs';
import { fixture, projectRoot, waitFor } from './tests/helpers.mjs';
const directory = await mkdtemp(join(tmpdir(), 'basically-local-inference-')), models = join(directory, 'models'), home = join(directory, 'private');
const python = process.env.AGENT_PLATFORM_PYTHON || resolve(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let fix, worker;
try {
  const script = `from pathlib import Path
import sys
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerFast
folder = Path(sys.argv[1]) / 'tiny-without-template'
tokenizer = Tokenizer(WordLevel({'[UNK]':0,'[EOS]':1,'hello':2,'world':3,'User':4,'Assistant':5,':':6}, unk_token='[UNK]'))
tokenizer.pre_tokenizer = Whitespace()
fast = PreTrainedTokenizerFast(tokenizer_object=tokenizer, unk_token='[UNK]', eos_token='[EOS]', pad_token='[EOS]')
fast.save_pretrained(folder)
model = GPT2LMHeadModel(GPT2Config(vocab_size=7,n_embd=16,n_layer=1,n_head=1,n_positions=128,eos_token_id=1,pad_token_id=1))
model.save_pretrained(folder,safe_serialization=True)
`;
  const made = spawnSync(python, ['-c', script, models], { encoding: 'utf8', timeout: 90000, windowsHide: true });
  assert.equal(made.status, 0, 'Install the Python 3.12 local runtime first. ' + made.stderr);
  worker = new LocalWorker(projectRoot, home, models); fix = await fixture({ local: worker });
  await fix.request('/api/local/name', { id: 'tiny-without-template', name: 'My tiny local model' });
  await fix.request('/api/local/load', { id: 'tiny-without-template', trust: true, device: 'cpu' });
  const status = await waitFor(async () => { const value = await fix.request('/api/local/status'); if (value.phase === 'error') throw Error(value.error); return value.phase === 'ready' && value; }, 90000);
  assert.equal(status.promptFormat, 'plain-text'); assert.equal(status.trustRemoteCode, true); assert.equal(status.contextWindow, 128);
  await fix.request('/api/local/settings', { temperature: 0, max_tokens: 4 });
  const chat = await fix.request('/api/chats', { selection: { provider: 'local', model: 'local-model' } });
  await fix.request('/api/chats/' + chat.id + '/messages', { text: 'hello world' });
  const result = await waitFor(async () => { const value = await fix.request('/api/chats/' + chat.id); return !value.running && value; }, 90000);
  assert.equal(result.error, null, result.error);
  const stored = await fix.app.store.chat(chat.id), assistant = stored.messages.find(row => row.role === 'assistant');
  assert.ok(assistant.usage.input > 0); assert.ok(assistant.usage.output > 0); assert.equal(assistant.performance.outputTokens, assistant.usage.output); assert.ok(assistant.performance.tokensPerSecond > 0);
  assert.deepEqual(result.messages.find(row => row.role === 'assistant').performance, assistant.performance, 'even an EOS-only response retains its measured response footer');
  assert.equal(assistant.displayName, 'My tiny local model'); assert.ok(assistant.localContext.omittedPromptTokens > 0); assert.equal(assistant.localContext.contextWindow, 128);
  assert.equal(stored.ledger[0].kind, 'local'); assert.equal(stored.ledger[0].output, assistant.usage.output);
  await fix.request('/api/local/unload', {}); await fix.close(); fix = null;
  worker = new LocalWorker(projectRoot, home, models);
  assert.equal((await worker.request('/status')).models[0].name, 'My tiny local model'); await worker.close(); worker = null;
  console.log('Real local CPU/Pi check passed: trust=true, no-template load/generation, actual small-context budgeting and disclosure, persistent naming, real usage and per-response tok/s. Temporary random weights only; no downloads or owner-model code executed.');
} finally { if (fix) await fix.close(); else if (worker) await worker.close(); await rm(directory, { recursive: true, force: true }); }
