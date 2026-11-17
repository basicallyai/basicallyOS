"""Transformers-only library validation, backend capability and portable archive checks."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from local_backends import capabilities
from model_runtime import ModelRuntime, inspect_model
from package_releases import write_archive


class FormatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root / 'transformers'
        self.folder.mkdir()
        (self.folder / 'config.json').write_text('{"model_type":"llama"}')
        (self.folder / 'tokenizer.json').write_text('{}')
        (self.folder / 'model.safetensors').write_bytes(b'weights')

    def test_transformers_repository_is_supported(self):
        row = inspect_model(self.folder)
        self.assertEqual(row['format'], 'transformers')
        self.assertIsNone(row['problem'])
        self.assertEqual(ModelRuntime(self.root).model_path('transformers'), self.folder.resolve())

    def test_gguf_files_and_folders_are_rejected(self):
        gguf = self.root / 'chat.gguf'
        gguf.write_bytes(b'GGUF' + b'\0' * 80)
        self.assertIn('GGUF', inspect_model(gguf)['problem'])
        with self.assertRaisesRegex(ValueError, 'safetensors model folder'):
            ModelRuntime(self.root).model_path('chat.gguf')
        folder = self.root / 'gguf-folder'
        folder.mkdir()
        (folder / 'chat.gguf').write_bytes(b'GGUF')
        self.assertIn('safetensors', inspect_model(folder)['problem'])

    def test_mlx_manifest_override_is_rejected(self):
        (self.folder / 'basically-model.json').write_text(json.dumps({'format': 'mlx'}))
        self.assertIn('Only Transformers', inspect_model(self.folder)['problem'])
        (self.folder / 'basically-model.json').write_text(json.dumps({'format': 'transformers'}))
        self.assertIsNone(inspect_model(self.folder)['problem'])

    def test_only_transformers_capability_is_exposed(self):
        self.assertEqual(set(capabilities()), {'transformers'})
        runtime = ModelRuntime(self.root)
        with patch('model_runtime.capabilities', return_value={'transformers': {'available': False, 'hint': 'Install Transformers'}}):
            with self.assertRaisesRegex(ValueError, 'Install Transformers'):
                runtime.load('transformers', False, 'auto')
        self.assertTrue(runtime.lock.acquire(False))
        runtime.lock.release()

    def test_snapshot_ignores_gguf_files(self):
        (self.root / 'ignored.gguf').write_bytes(b'GGUF')
        models = ModelRuntime(self.root).snapshot()['models']
        self.assertEqual([row['id'] for row in models], ['transformers'])

    def test_archives_exclude_private_data_and_atomic_finish(self):
        folder = self.root / 'stage'
        folder.mkdir()
        (folder / 'app.txt').write_text('ok')
        (folder / '.platform-home').mkdir()
        (folder / '.platform-home/secret').write_text('private')
        output = self.root / 'app.zip'
        write_archive(folder, output)
        self.assertFalse(output.with_suffix('.zip.partial').exists())
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(archive.namelist(), ['app.txt'])
            self.assertIsNone(archive.testzip())
        import tarfile
        output = self.root / 'app.tar.gz'
        write_archive(folder, output)
        with tarfile.open(output) as archive:
            self.assertEqual(archive.getnames(), ['app.txt'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
