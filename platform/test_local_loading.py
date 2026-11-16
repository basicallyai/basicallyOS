"""Local trust, prompt fallback, context budgeting and display-name regressions (no downloads)."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from model_runtime import ModelRuntime, inspect_model


class Tensor:
    def __init__(self, length):
        self.shape = (1, length)

    def __getitem__(self, key):
        return Tensor(min(self.shape[-1], -key[-1].start))


class Batch(dict):
    def to(self, device):
        return self


class Tokenizer:
    chat_template = None
    model_max_length = 128

    def __init__(self, length=12):
        self.length = length
        self.prompt = None
        self.native_calls = 0

    def __call__(self, prompt, **options):
        self.prompt = prompt
        return Batch(input_ids=Tensor(self.length), attention_mask=Tensor(self.length), token_type_ids=Tensor(self.length))

    def apply_chat_template(self, messages, **options):
        self.native_calls += 1
        return Batch(input_ids=Tensor(self.length), attention_mask=Tensor(self.length))


class LocalLoadingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root / 'model-id'
        self.folder.mkdir()
        (self.folder / 'config.json').write_text('{"model_type":"test"}')
        (self.folder / 'tokenizer.json').write_text('{}')
        (self.folder / 'model.safetensors').write_bytes(b'weights')

    def test_missing_declared_python_is_reported_without_executing_code(self):
        (self.folder / 'config.json').write_text(json.dumps({'model_type': 'custom', 'auto_map': {'AutoConfig': 'configuration_test.Config', 'AutoModelForCausalLM': 'modeling_test.Model'}}))
        row = inspect_model(self.folder)
        self.assertEqual(row['missingCode'], ['configuration_test.py', 'modeling_test.py'])
        self.assertIn('Reimport the complete', row['problem'])
        for name in row['missingCode']:
            (self.folder / name).write_text('raise RuntimeError("must not execute during inspection")')
        self.assertIsNone(inspect_model(self.folder)['problem'])
        self.assertTrue(inspect_model(self.folder)['customCode'])

    def test_tokenizer_custom_code_is_detected_and_validated(self):
        (self.folder / 'tokenizer_config.json').write_text(json.dumps({'auto_map': {'AutoTokenizer': [None, 'tokenization_test.Tokenizer']}}))
        self.assertEqual(inspect_model(self.folder)['missingCode'], ['tokenization_test.py'])
        (self.folder / 'tokenizer_config.json').write_text('[]')
        self.assertIn('JSON object', inspect_model(self.folder)['problem'])

    def test_trust_true_reaches_both_loaders_and_missing_template_is_not_rejected(self):
        tokenizer = Tokenizer()
        model = SimpleNamespace(eval=lambda: None, config=SimpleNamespace(max_position_embeddings=128))
        loaders = SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=Mock(return_value=tokenizer)), AutoModelForCausalLM=SimpleNamespace(from_pretrained=Mock(return_value=model)))
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), backends=SimpleNamespace(), float32='float32')
        runtime = ModelRuntime(self.root)
        with patch.dict('sys.modules', {'torch': torch, 'transformers': loaders}):
            runtime.lock.acquire()
            runtime._load(self.folder, True, 'cpu')
            self.assertEqual(runtime.state['phase'], 'ready', runtime.state.get('error'))
            self.assertEqual(runtime.state['promptFormat'], 'plain-text')
            self.assertEqual(runtime.state['contextWindow'], 128)
            self.assertTrue(runtime.state['trustRemoteCode'])
            for loader in [loaders.AutoTokenizer, loaders.AutoModelForCausalLM]:
                self.assertTrue(loader.from_pretrained.call_args.kwargs['trust_remote_code'])
                self.assertTrue(loader.from_pretrained.call_args.kwargs['local_files_only'])
            self.assertTrue(loaders.AutoModelForCausalLM.from_pretrained.call_args.kwargs['use_safetensors'])
            self.assertTrue(runtime.lock.acquire(False)); runtime.lock.release()

    def ready(self, length=12):
        runtime = ModelRuntime(self.root)
        runtime.model = SimpleNamespace(device='cpu', forward=lambda input_ids, attention_mask=None: None)
        runtime.tokenizer = Tokenizer(length)
        runtime.update(phase='ready', model='model-id', contextWindow=128, maxTokens=32)
        return runtime

    def test_no_template_formats_all_roles_as_generic_text(self):
        runtime = self.ready()
        prepared = runtime.prepare({'model': 'local-model', 'max_tokens': 4, 'messages': [{'role': 'system', 'content': 'Be concise'}, {'role': 'user', 'content': 'Hello'}, {'role': 'assistant', 'content': 'Hi'}, {'role': 'user', 'content': 'Continue'}]})
        try:
            self.assertEqual(runtime.tokenizer.prompt, 'System: Be concise\n\nUser: Hello\n\nAssistant: Hi\n\nUser: Continue\n\nAssistant:')
            self.assertEqual(runtime.tokenizer.native_calls, 0)
            self.assertEqual(prepared[1], 4)
            self.assertNotIn('token_type_ids', prepared[0])
        finally:
            runtime.lock.release()

    def test_existing_template_is_retained_and_small_context_is_bounded(self):
        runtime = self.ready(length=200)
        runtime.tokenizer.chat_template = 'native template'
        prepared = runtime.prepare({'model': 'local-model', 'max_tokens': 4096, 'messages': [{'role': 'user', 'content': 'Hello'}]})
        try:
            self.assertEqual(runtime.tokenizer.native_calls, 1)
            self.assertIsNone(runtime.tokenizer.prompt)
            self.assertEqual(prepared[1], 32)
            self.assertEqual(prepared[0]['input_ids'].shape[-1], 96)
            self.assertEqual(runtime.state['lastGeneration']['omittedPromptTokens'], 104)
        finally:
            runtime.lock.release()

    def test_unknown_context_is_an_explicit_error_not_an_invented_limit(self):
        runtime = self.ready()
        runtime.update(contextWindow=None)
        with self.assertRaisesRegex(ValueError, 'verified limit'):
            runtime.prepare({'model': 'local-model', 'messages': [{'role': 'user', 'content': 'Hello'}]})
        self.assertTrue(runtime.lock.acquire(False)); runtime.lock.release()

    def test_names_persist_separately_and_do_not_move_model_files(self):
        config = self.root / 'private' / 'local-settings.json'
        runtime = ModelRuntime(self.root, config)
        runtime.update(model='model-id', phase='ready')
        original = (self.folder / 'config.json').read_bytes()
        result = runtime.rename({'id': 'model-id', 'name': 'My tiny model'})
        self.assertEqual(result['displayName'], 'My tiny model')
        self.assertEqual(result['models'][0]['name'], 'My tiny model')
        self.assertEqual(result['models'][0]['id'], 'model-id')
        self.assertEqual((self.folder / 'config.json').read_bytes(), original)
        restored = ModelRuntime(self.root, config)
        self.assertEqual(restored.names['model-id'], 'My tiny model')
        for bad in [{'id': '../escape', 'name': 'No'}, {'id': 'model-id', 'name': ''}, {'id': 'model-id', 'name': 'X' * 151}, {'id': 'model-id', 'name': 'Bad\nName'}]:
            with self.assertRaises(ValueError):
                runtime.rename(bad)


if __name__ == '__main__':
    unittest.main(verbosity=2)
