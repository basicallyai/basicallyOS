"""Keyless library, worker authentication, lifecycle, and real CPU inference checks."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

from model_runtime import ModelRuntime, inspect_model, make_handler


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.folder = self.root / "example"
        self.folder.mkdir()
        (self.folder / "config.json").write_text('{"model_type":"test"}')
        (self.folder / "tokenizer.json").write_text('{}')
        (self.folder / "model.safetensors").write_bytes(b'1234567890')

    def test_library_and_missing_shard(self):
        self.assertIsNone(inspect_model(self.folder)["problem"])
        (self.folder / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"a": "missing.safetensors"}}))
        self.assertIn("Missing", inspect_model(self.folder)["problem"])

    def test_lfs_pointer_and_invalid_config(self):
        (self.folder / "model.safetensors").write_text('version https://git-lfs.github.com/spec/v1\n')
        self.assertIn("LFS pointers", inspect_model(self.folder)["problem"])
        (self.folder / "config.json").write_text('not json')
        self.assertIsNotNone(inspect_model(self.folder)["problem"])
        (self.folder / "config.json").write_text('[]')
        self.assertIn("JSON object", inspect_model(self.folder)["problem"])

    def test_folder_escape_and_unloaded_inference(self):
        runtime = ModelRuntime(self.root)
        for name in ("..", "../outside", str(self.root), "missing"):
            with self.assertRaises(ValueError):
                runtime.model_path(name)
        with self.assertRaisesRegex(ValueError, "No local model"):
            runtime.prepare({"model": "local-model", "messages": [{"role": "user", "content": "hi"}]})
        self.assertTrue(runtime.lock.acquire(False))
        runtime.lock.release()

    def test_tool_requests_fail_explicitly(self):
        with self.assertRaisesRegex(ValueError, "does not accept tool declarations"):
            ModelRuntime(self.root).prepare({"model": "local-model", "tools": [{"type": "function"}]})

    def test_status_reuses_library_scan(self):
        from unittest.mock import patch
        runtime = ModelRuntime(self.root)
        with patch('model_runtime.inspect_model', wraps=inspect_model) as inspect:
            runtime.snapshot()
            runtime.snapshot()
            self.assertEqual(inspect.call_count, 1)
            runtime.library_cache_time = 0
            runtime.snapshot()
            self.assertEqual(inspect.call_count, 2)

    def test_tuning_persists_validates_and_reaches_backend(self):
        settings_file = self.root / '.settings.json'
        runtime = ModelRuntime(self.root, settings_file)
        for bad in ({'temperature': True}, {'temperature': float('nan')}, {'top_p': 0},
                    {'top_k': 1.5}, {'max_tokens': 4097}, {'system_prompt': 123}, {'unknown': 1}):
            with self.assertRaises(ValueError):
                runtime.configure(bad)
        saved = runtime.configure({'temperature': 0.2, 'top_p': 0.9, 'top_k': 25,
                                   'max_tokens': 50, 'system_prompt': 'Be concise.'})
        restored = ModelRuntime(self.root, settings_file)
        self.assertEqual(restored.snapshot()['settings'], saved['settings'])

        class Backend:
            def prepare(self, *args):
                return args
        restored.model = object()
        restored.backend = Backend()
        prepared = restored.prepare({'model': 'local-model', 'temperature': 1.5, 'max_tokens': 4000,
                                     'messages': [{'role': 'system', 'content': 'Persona'}, {'role': 'user', 'content': 'Hi'}]})
        try:
            self.assertEqual(prepared[0][0], {'role': 'system', 'content': 'Be concise.\n\nPersona'})
            self.assertEqual(prepared[0][1]['role'], 'user')
            self.assertEqual(prepared[1:], (50, 0.2, 0.9, 25))
        finally:
            restored.lock.release()

    def test_settings_endpoint_is_authenticated(self):
        runtime = ModelRuntime(self.root)
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(runtime, 'test-token'))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f'http://127.0.0.1:{server.server_port}/settings'
        body = json.dumps({'top_k': 10}).encode()
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(url, data=body))
        self.assertEqual(error.exception.code, 401)
        result = json.load(urlopen(Request(url, data=body, headers={'Authorization': 'Bearer test-token'})))
        self.assertEqual(result['settings']['top_k'], 10)

    def test_worker_authentication_and_status(self):
        runtime = ModelRuntime(self.root)
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(runtime, "test-token"))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/status"
        with self.assertRaises(HTTPError) as error:
            urlopen(url)
        self.assertEqual(error.exception.code, 401)
        result = json.load(urlopen(Request(url, headers={"Authorization": "Bearer test-token"})))
        self.assertEqual(result["models"][0]["id"], "example")
        self.assertEqual(result["phase"], "idle")


@unittest.skipUnless(os.environ.get("PLATFORM_INFERENCE_TEST") == "1", "Set PLATFORM_INFERENCE_TEST=1 for real CPU model checks")
class InferenceTests(unittest.TestCase):
    def test_real_safetensors_load_stream_unload(self):
        from tokenizers import Tokenizer
        from tokenizers.models import WordLevel
        from tokenizers.pre_tokenizers import Whitespace
        from transformers import GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerFast
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder = root / "temporary-test-model"
            tokenizer = Tokenizer(WordLevel({"[UNK]": 0, "[EOS]": 1, "hello": 2, "world": 3, "user": 4, "assistant": 5, ":": 6}, unk_token="[UNK]"))
            tokenizer.pre_tokenizer = Whitespace()
            fast = PreTrainedTokenizerFast(tokenizer_object=tokenizer, unk_token="[UNK]", eos_token="[EOS]", pad_token="[EOS]")
            fast.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] + ' ' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"
            fast.save_pretrained(folder)
            model = GPT2LMHeadModel(GPT2Config(vocab_size=7, n_embd=16, n_layer=1, n_head=1, n_positions=128, eos_token_id=1))
            model.save_pretrained(folder, safe_serialization=True)
            runtime = ModelRuntime(root)
            runtime.load(folder.name, False, "cpu")
            deadline = time.monotonic() + 90
            while runtime.snapshot()["phase"] == "loading" and time.monotonic() < deadline:
                time.sleep(.1)
            self.assertEqual(runtime.snapshot()["phase"], "ready", runtime.snapshot()["error"])
            body = {"model": "local-model", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 4, "temperature": 0}
            parts = list(runtime.generate(runtime.prepare(body), threading.Event()))
            self.assertTrue(all(isinstance(part, str) for part in parts))
            self.assertEqual(runtime.snapshot()["phase"], "ready")
            runtime.configure({'temperature': 0.5, 'max_tokens': 4, 'top_p': 0.9, 'top_k': 3,
                               'system_prompt': 'hello'})
            tuned = list(runtime.generate(runtime.prepare(body), threading.Event()))
            self.assertTrue(all(isinstance(part, str) for part in tuned))
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(runtime, "inference-test"))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                request = Request(f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                                  data=json.dumps({**body, "stream": True}).encode(),
                                  headers={"Authorization": "Bearer inference-test", "Content-Type": "application/json"})
                with urlopen(request, timeout=30) as response:
                    self.assertEqual(response.headers["Content-Type"], "text/event-stream")
                    output = response.read().decode()
                self.assertIn('"finish_reason": "stop"', output)
                self.assertIn('data: [DONE]', output)
                chunks = [json.loads(line[6:]) for line in output.splitlines() if line.startswith('data: {')]
                usage = next(chunk['usage'] for chunk in chunks if 'usage' in chunk)
                self.assertGreater(usage['completion_tokens'], 0)
                self.assertEqual(usage['total_tokens'], usage['prompt_tokens'] + usage['completion_tokens'])
                self.assertEqual(runtime.snapshot()['lastGeneration']['outputTokens'], usage['completion_tokens'])
                self.assertGreater(runtime.snapshot()['lastGeneration']['tokensPerSecond'], 0)
            finally:
                server.shutdown()
                server.server_close()
            runtime.unload()
            self.assertEqual(runtime.snapshot()["phase"], "idle")
            # A REAL model without any chat template must also load and generate.
            fast.chat_template = None
            fast.save_pretrained(folder)
            (folder / 'chat_template.jinja').unlink(missing_ok=True)
            runtime.load(folder.name, True, 'cpu')
            deadline = time.monotonic() + 90
            while runtime.snapshot()['phase'] == 'loading' and time.monotonic() < deadline:
                time.sleep(.1)
            self.assertEqual(runtime.snapshot()['phase'], 'ready', runtime.snapshot().get('error'))
            self.assertTrue(runtime.snapshot()['trustRemoteCode'])
            self.assertEqual(runtime.snapshot()['promptFormat'], 'plain-text')
            long_body = {**body, 'messages': [{'role': 'system', 'content': 'hello ' * 300}, {'role': 'user', 'content': 'world'}]}
            parts = list(runtime.generate(runtime.prepare(long_body), threading.Event()))
            self.assertTrue(all(isinstance(part, str) for part in parts))
            self.assertGreater(runtime.snapshot()['lastGeneration']['omittedPromptTokens'], 0)
            self.assertGreater(runtime.snapshot()['lastGeneration']['outputTokens'], 0)
            self.assertLessEqual(runtime.snapshot()['lastGeneration']['promptTokens'] + runtime.snapshot()['lastGeneration']['outputTokens'], 128)
            runtime.unload()


if __name__ == "__main__":
    unittest.main(verbosity=2)
