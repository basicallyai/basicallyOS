"""Loopback-only, authenticated Transformers/safetensors model worker."""
from __future__ import annotations

import argparse
import gc
import importlib.util
import inspect
import json
import math
import os
from pathlib import Path
import queue
import secrets
import sys
import threading
import time
import uuid
from local_backends import capabilities
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def inspect_model(folder: Path) -> dict:
    """Inspect one Transformers repository without importing or executing its Python files."""
    row = {"id": folder.name, "name": folder.name, "bytes": 0, "architecture": "Unknown", "problem": None, "customCode": False, "format": "transformers"}
    try:
        if not folder.is_dir():
            raise ValueError('Only complete Transformers/safetensors model folders are supported. GGUF and MLX models are no longer supported.')
        if any(folder.glob('*.gguf')):
            raise ValueError('GGUF models are no longer supported. Use a complete Transformers/safetensors model folder.')
        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise ValueError("config.json must contain a JSON object.")
        row["architecture"] = config.get("model_type", "Unknown")
        tokenizer_config = folder / 'tokenizer_config.json'
        tokenizer_metadata = json.loads(tokenizer_config.read_text(encoding='utf-8')) if tokenizer_config.exists() else {}
        if not isinstance(tokenizer_metadata, dict):
            raise ValueError('tokenizer_config.json must contain a JSON object.')
        maps = [config.get('auto_map', {}), tokenizer_metadata.get('auto_map', {})]
        row['customCode'] = any(maps) or any(folder.glob('*.py'))
        missing = []
        for mapping in maps:
            for reference in mapping.values() if isinstance(mapping, dict) else []:
                for item in reference if isinstance(reference, (list, tuple)) else [reference]:
                    if not isinstance(item, str) or '.' not in item:
                        continue
                    module = item.split('--')[-1].rsplit('.', 1)[0]
                    relative = Path(*module.split('.')).with_suffix('.py')
                    candidate = folder / relative
                    if not candidate.resolve().is_relative_to(folder.resolve()) or not candidate.is_file():
                        missing.append(relative.as_posix())
        if missing:
            row['missingCode'] = sorted(set(missing))
            raise ValueError('Missing custom model code: ' + ', '.join(row['missingCode']) + '. Reimport the complete original repository including its Python files; code is never downloaded automatically.')
        manifest = folder / 'basically-model.json'
        if manifest.exists():
            metadata = json.loads(manifest.read_text(encoding='utf-8'))
            if not isinstance(metadata, dict):
                raise ValueError('basically-model.json must contain a JSON object.')
            if metadata.get('format', 'transformers') != 'transformers':
                raise ValueError('Only Transformers/safetensors models are supported. GGUF and MLX are no longer supported.')
        files = list(folder.glob("*.safetensors"))
        if not files:
            raise ValueError("No safetensors weights found. Include the complete model repository.")
        for file in files:
            if file.is_symlink() or not file.resolve().is_relative_to(folder.resolve()):
                raise ValueError("Model weights must be regular files inside this repository.")
            with file.open("rb") as handle:
                if handle.read(80).startswith(b"version https://git-lfs.github.com/spec"):
                    raise ValueError("Weights are Git LFS pointers. Download the actual weight files.")
            row["bytes"] += file.stat().st_size
        index = folder / "model.safetensors.index.json"
        if index.exists():
            for shard in set(json.loads(index.read_text(encoding="utf-8"))["weight_map"].values()):
                shard_path = (folder / shard).resolve()
                if not shard_path.is_relative_to(folder.resolve()) or not shard_path.is_file():
                    raise ValueError(f"Missing or invalid weight shard: {shard}")
        if not any((folder / name).exists() for name in ("tokenizer.json", "tokenizer.model", "vocab.json", "vocab.txt")):
            raise ValueError("Tokenizer files are missing. Copy the complete repository.")
    except (OSError, ValueError, KeyError, TypeError) as error:
        row["problem"] = str(error)
    return row

class ModelRuntime:
    """Owns the single loaded model and serializes load, unload, and inference."""

    def __init__(self, root: Path, settings_file: Path | None = None):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.model = None
        self.tokenizer = None
        self.backend = None
        self.state = {"phase": "idle", "model": None, "error": None, "device": None}
        self.settings_file = settings_file
        self.settings_saved = False
        self.names_file = settings_file.with_name('local-model-names.json') if settings_file else None
        self.names = json.loads(self.names_file.read_text(encoding='utf-8')) if self.names_file and self.names_file.exists() else {}
        if not isinstance(self.names, dict) or any(not isinstance(k, str) or not isinstance(v, str) or not v.strip() or len(v) > 150 for k, v in self.names.items()):
            raise ValueError('Invalid local model display-name file.')
        self.library_cache = None
        self.library_cache_time = 0
        self.library_lock = threading.Lock()
        self.settings = {'temperature': 0.7, 'max_tokens': 1024, 'top_p': 1.0, 'top_k': 0, 'system_prompt': ''}
        if settings_file and settings_file.exists():
            self.settings = self.validate_settings(json.loads(settings_file.read_text(encoding='utf-8')))
            self.settings_saved = True

    def validate_settings(self, value):
        if not isinstance(value, dict) or set(value) - set(self.settings):
            raise ValueError('Unknown local tuning setting.')
        result = {**self.settings, **value}
        for key, low, high in [('temperature', 0, 2), ('max_tokens', 1, 4096), ('top_p', 0.000001, 1), ('top_k', 0, 1000)]:
            number = result[key]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or not low <= number <= high:
                raise ValueError(f'{key} must be between {low} and {high}.')
            if key in ('max_tokens', 'top_k') and not isinstance(number, int):
                raise ValueError(f'{key} must be an integer.')
        if not isinstance(result['system_prompt'], str) or len(result['system_prompt']) > 30000:
            raise ValueError('System prompt must be text of at most 30000 characters.')
        return result

    def configure(self, value):
        with self.state_lock:
            settings = self.validate_settings(value)
            if self.settings_file:
                self.settings_file.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.settings_file.with_suffix('.tmp')
                temporary.write_text(json.dumps(settings, indent=2), encoding='utf-8')
                temporary.replace(self.settings_file)
            self.settings = settings
            self.settings_saved = True
        return self.snapshot()

    def rename(self, value):
        model_id, name = value.get('id'), value.get('name')
        if not isinstance(model_id, str) or not model_id or Path(model_id).name != model_id:
            raise ValueError('Choose a model folder from the library.')
        path = self.root / model_id
        if path.is_symlink() or path.is_junction() or not path.is_dir() or not path.resolve().is_relative_to(self.root):
            raise ValueError('Choose a model folder inside the local library.')
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 150 or any(ord(c) < 32 for c in name):
            raise ValueError('Use a display name of 1–150 characters without control characters.')
        with self.state_lock:
            names = {**self.names, model_id: name.strip()}
            if self.names_file:
                self.names_file.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.names_file.with_name(self.names_file.name + '.' + uuid.uuid4().hex + '.tmp')
                try:
                    with temporary.open('w', encoding='utf-8') as handle:
                        json.dump(names, handle, ensure_ascii=False, indent=2)
                    temporary.chmod(0o600)
                    temporary.replace(self.names_file)
                finally:
                    temporary.unlink(missing_ok=True)
            self.names = names
        return self.snapshot()

    def update(self, **fields):
        with self.state_lock:
            self.state = {**self.state, **fields}

    def snapshot(self):
        with self.state_lock:
            state = dict(self.state)
            names = dict(self.names)
            settings = dict(self.settings)
        if state.get('maxTokens'):
            state['maxTokens'] = min(state['maxTokens'], settings['max_tokens'])
        backends = capabilities()
        # Status polling must not reopen every weight shard on every request.
        # Model loading still performs a fresh validation of the selected path.
        with self.library_lock:
            if self.library_cache is None or time.monotonic() - self.library_cache_time >= 15:
                self.library_cache = [inspect_model(p) for p in sorted(self.root.iterdir()) if p.is_dir() and not p.is_symlink() and not p.name.startswith('.')]
                self.library_cache_time = time.monotonic()
            models = [dict(row) for row in self.library_cache]
        for model in models:
            model['name'] = names.get(model['id'], model['name'])
            backend = backends.get(model['format'], backends['transformers'])
            model['available'] = backend['available']
            model['runtimeHint'] = backend['hint']
        return {**state, 'displayName': names.get(state['model'], state['model']), 'settings': settings, 'root': str(self.root), 'dependencies': any(b['available'] for b in backends.values()),
                'backends': backends, 'models': models}

    def model_path(self, model_id: str) -> Path:
        if not isinstance(model_id, str) or not model_id or Path(model_id).name != model_id:
            raise ValueError("Choose a model folder from the library.")
        path = self.root / model_id
        if path.is_symlink() or path.is_junction() or not path.resolve().is_relative_to(self.root) or not path.is_dir():
            raise ValueError("Choose a complete Transformers/safetensors model folder inside the local library.")
        row = inspect_model(path)
        if row["problem"]:
            raise ValueError(row["problem"])
        return path

    def load(self, model_id: str, trust: bool, device: str):
        path = self.model_path(model_id)
        if device not in ("auto", "cpu", "cuda", "mps") or not isinstance(trust, bool):
            raise ValueError("Choose Auto, CPU, CUDA, or Apple GPU and a boolean custom-code preference.")
        row = inspect_model(path)
        backend = capabilities()[row['format']]
        if not backend['available']:
            raise ValueError(backend['hint'])
        if not self.lock.acquire(blocking=False):
            raise ValueError("The model is busy. Stop the current response or wait for loading to finish.")
        self.update(phase="loading", model=model_id, error=None, device=device)
        threading.Thread(target=self._load, args=(path, trust, device), daemon=True).start()

    def _clear(self):
        if self.backend is not None:
            self.backend.close()
            self.backend = None
        self.model = None
        self.tokenizer = None
        gc.collect()
        if "torch" in sys.modules and sys.modules["torch"].cuda.is_available():
            sys.modules["torch"].cuda.empty_cache()

    def _load(self, path: Path, trust: bool, device: str):
        try:
            self._clear()
            row = inspect_model(path)
            if row['problem']:
                raise ValueError(row['problem'])
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
            mps = hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()
            selected = ('cuda' if torch.cuda.is_available() else 'mps' if mps else 'cpu') if device == 'auto' else device
            if selected == 'mps' and not mps:
                raise ValueError('Apple GPU is unavailable. Choose CPU or use an Apple Silicon Mac with MPS-enabled PyTorch.')
            if selected == "cuda" and not torch.cuda.is_available():
                raise ValueError("CUDA is unavailable. Choose CPU or install a CUDA-enabled PyTorch build.")
            tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True, trust_remote_code=trust)
            model = AutoModelForCausalLM.from_pretrained(path, local_files_only=True, trust_remote_code=trust,
                                                       use_safetensors=True, dtype="auto" if selected in ('cuda', 'mps') else torch.float32,
                                                       device_map=selected)
            model.eval()
            self.model, self.tokenizer = model, tokenizer
            limits = [getattr(model.config, key, None) for key in ('max_position_embeddings', 'n_positions', 'max_sequence_length', 'seq_length', 'max_seq_len', 'n_ctx')]
            limits.append(getattr(tokenizer, 'model_max_length', None))
            limits = [n for n in limits if isinstance(n, int) and 1 < n < 10000000]
            context = min(min(limits), 32768) if limits else None
            self.update(phase='ready', model=path.name, device=selected, error=None, format='transformers', contextWindow=context,
                        maxTokens=min(4096, max(1, context // 4)) if context else None, trustRemoteCode=trust,
                        promptFormat='model-template' if getattr(tokenizer, 'chat_template', None) else 'plain-text', lastGeneration=None)
        except Exception as error:
            self._clear()
            self.update(phase='error', model=None, device=None, contextWindow=None, maxTokens=None, error=f'Could not load {path.name}: {error}')
        finally:
            self.lock.release()

    def unload(self):
        if not self.lock.acquire(blocking=False):
            raise ValueError("The model is busy. Stop the response or wait for loading to finish.")
        try:
            self._clear()
            self.update(phase='idle', model=None, device=None, error=None, format=None, contextWindow=None, maxTokens=None, lastGeneration=None)
        finally:
            self.lock.release()

    def prepare(self, body: dict):
        if body.get("model") != "local-model":
            raise ValueError("Select the local-model model ID.")
        if body.get("tools"):
            raise ValueError("Local inference does not accept tool declarations. Choose a tool-capable API model for workspace actions.")
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("A non-empty messages array is required.")
        clean = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in ("system", "user", "assistant"):
                raise ValueError("Local chat supports system, user, and assistant text messages.")
            content = message.get("content", "")
            if isinstance(content, list):
                if any(not isinstance(p, dict) or p.get("type") != "text" for p in content):
                    raise ValueError("This local runtime supports text only. Choose an external multimodal provider for attachments.")
                content = "\n".join(p.get("text", "") for p in content)
            if not isinstance(content, str):
                raise ValueError("Message content must be text.")
            if clean and clean[-1]['role'] == message['role']:
                clean[-1]['content'] += '\n\n' + content
            else:
                clean.append({"role": message["role"], "content": content})
        # Saved local tuning deliberately takes precedence over adapter defaults.
        # Explicit wire values are used until the user saves a tuning profile.
        configured = self.settings_saved
        settings = dict(self.settings)
        if not configured:
            settings.update({key: body[key] for key in ('temperature', 'top_p', 'top_k') if key in body})
            settings['max_tokens'] = body.get('max_completion_tokens', body.get('max_tokens', settings['max_tokens']))
        settings = self.validate_settings(settings)
        max_tokens, temperature = settings['max_tokens'], settings['temperature']
        if settings['system_prompt'].strip():
            if clean and clean[0]['role'] == 'system':
                clean[0]['content'] = settings['system_prompt'] + '\n\n' + clean[0]['content']
            else:
                clean.insert(0, {'role': 'system', 'content': settings['system_prompt']})
        if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or not 1 <= max_tokens <= 4096:
            raise ValueError("max_tokens must be between 1 and 4096.")
        if not isinstance(temperature, (int, float)) or not 0 <= temperature <= 2:
            raise ValueError("temperature must be between 0 and 2.")
        if not self.lock.acquire(blocking=False):
            raise ValueError("The local model is busy. Try again when the current operation finishes.")
        try:
            if self.model is None:
                raise ValueError("No local model is loaded. Open Local models and load a model first.")
            if self.backend is not None:
                return self.backend.prepare(clean, max_tokens, temperature, settings['top_p'], settings['top_k'])
            if getattr(self.tokenizer, 'chat_template', None):
                inputs = self.tokenizer.apply_chat_template(clean, add_generation_prompt=True, return_tensors='pt', return_dict=True)
            else:
                # Explicit generic text format, not a guessed model-specific chat template.
                prompt = '\n\n'.join(message['role'].capitalize() + ': ' + message['content'] for message in clean) + '\n\nAssistant:'
                inputs = self.tokenizer(prompt, return_tensors='pt', add_special_tokens=True)
            # Generic fast tokenizers can emit segment IDs that a causal LM never accepts.
            forward = getattr(self.model, 'forward', None)
            if 'token_type_ids' in inputs and callable(forward):
                try:
                    if 'token_type_ids' not in inspect.signature(forward).parameters:
                        inputs.pop('token_type_ids')
                except (ValueError, TypeError):
                    pass
            inputs = inputs.to(self.model.device)
            context = self.state.get('contextWindow')
            if not context:
                raise ValueError('This model does not advertise a usable context limit in its config/tokenizer. Add a verified limit to the repository config before using it.')
            max_tokens = min(max_tokens, max(1, context // 4))
            prompt_tokens = inputs['input_ids'].shape[-1]
            budget = context - max_tokens
            if prompt_tokens > budget:
                inputs = {key: tensor[..., -budget:] for key, tensor in inputs.items()}
            self.update(lastGeneration={'promptTokens': min(prompt_tokens, budget), 'omittedPromptTokens': max(0, prompt_tokens - budget), 'maxTokens': max_tokens})
            return inputs, max_tokens, temperature, settings['top_p'], settings['top_k']
        except Exception:
            self.lock.release()
            raise

    def generate(self, prepared, cancelled: threading.Event, stats=None):
        """Yield text and release the model only after its generation thread exits."""
        if self.backend is not None:
            self.update(phase='generating')
            try:
                yield ''
                yield from self.backend.generate(prepared, cancelled)
            finally:
                cancelled.set()
                self.update(phase='ready')
                self.lock.release()
            return
        try:
            from transformers import TextIteratorStreamer, StoppingCriteria, StoppingCriteriaList
        except Exception:
            self.lock.release()
            raise

        class Cancelled(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):
                return cancelled.is_set()

        class CountingStreamer(TextIteratorStreamer):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.output_tokens = 0

            def put(self, value):
                if not self.next_tokens_are_prompt:
                    self.output_tokens += int(value.numel())
                super().put(value)

        stats = stats if stats is not None else {}
        inputs, max_tokens, temperature, top_p, top_k = prepared
        streamer = CountingStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=1)
        errors = []

        def run():
            try:
                import torch
                with torch.inference_mode():
                    options = dict(inputs, max_new_tokens=max_tokens, streamer=streamer, do_sample=temperature > 0,
                                   stopping_criteria=StoppingCriteriaList([Cancelled()]),
                                   pad_token_id=self.tokenizer.pad_token_id if self.tokenizer.pad_token_id is not None else self.tokenizer.eos_token_id)
                    if temperature > 0:
                        options["temperature"] = temperature
                        options['top_p'] = top_p
                        options['top_k'] = top_k
                    self.model.generate(**options)
            except Exception as error:
                errors.append(error)
                streamer.end()

        started = time.perf_counter()
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.update(phase="generating")
        deadline = time.monotonic() + 600
        try:
            # The HTTP handler primes the generator before writing response headers.
            yield ""
            while True:
                try:
                    yield next(streamer)
                except StopIteration:
                    break
                except queue.Empty:
                    if time.monotonic() > deadline:
                        raise TimeoutError("Generation exceeded ten minutes. Try fewer output tokens or a smaller model.")
                    if not thread.is_alive():
                        break
            thread.join()
            if errors:
                raise errors[0]
        finally:
            cancelled.set()
            thread.join()
            elapsed = time.perf_counter() - started
            stats.update(promptTokens=int(inputs['input_ids'].shape[-1]), outputTokens=streamer.output_tokens,
                         elapsedSeconds=elapsed, tokensPerSecond=streamer.output_tokens / elapsed if elapsed > 0 else None)
            self.update(phase='ready', lastGeneration={**(self.state.get('lastGeneration') or {}), **stats})
            self.lock.release()


def make_handler(runtime: ModelRuntime, token: str):
    """Bind one authenticated HTTP handler to a runtime instance."""
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def respond(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            if not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.respond(401, {"error": {"message": "Unauthorized worker request."}})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            parsed = urlsplit(self.path)
            if parsed.path == "/status":
                if parse_qs(parsed.query).get('refresh') == ['1']:
                    with runtime.library_lock:
                        runtime.library_cache_time = 0
                self.respond(200, runtime.snapshot())
            elif self.path == "/v1/models":
                self.respond(200, {"object": "list", "data": [{"id": "local-model", "object": "model", "owned_by": "local"}]})
            else:
                self.respond(404, {"error": {"message": "Unknown endpoint."}})

        def do_POST(self):
            if not self.authorized():
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 2 * 1024 * 1024:
                    raise ValueError("Request must contain JSON smaller than 2 MB.")
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError("Request must be a JSON object.")
                if self.path == '/settings':
                    self.respond(200, runtime.configure(body))
                elif self.path == '/name':
                    self.respond(200, runtime.rename(body))
                elif self.path == "/load":
                    runtime.load(body.get("id"), body.get("trust", False), body.get("device", "auto"))
                    self.respond(202, runtime.snapshot())
                elif self.path == "/unload":
                    runtime.unload()
                    self.respond(200, runtime.snapshot())
                elif self.path == "/v1/chat/completions":
                    prepared = runtime.prepare(body)
                    self.completion(body, prepared)
                else:
                    self.respond(404, {"error": {"message": "Unknown endpoint."}})
            except (ValueError, TypeError) as error:
                self.respond(400, {"error": {"message": str(error)}})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self.respond(500, {"error": {"message": str(error)}})

        def completion(self, body, prepared):
            cancelled = threading.Event()
            ident = 'chatcmpl-' + uuid.uuid4().hex
            stats = {'requestId': ident}
            stream = runtime.generate(prepared, cancelled, stats)
            base = {"id": ident, "created": int(time.time()), "model": "local-model"}
            next(stream)
            if not body.get("stream", False):
                try:
                    content = "".join(stream)
                    usage = {'prompt_tokens': stats['promptTokens'], 'completion_tokens': stats['outputTokens'], 'total_tokens': stats['promptTokens'] + stats['outputTokens']} if 'outputTokens' in stats else None
                    self.respond(200, {**base, 'object': 'chat.completion', **({'usage': usage} if usage else {}), 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}]})
                finally:
                    stream.close()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            def send(delta, finish=None, usage=None):
                chunk = {**base, 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}], **({'usage': usage} if usage else {})}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.flush()

            try:
                send({"role": "assistant", "content": ""})
                for text in stream:
                    if text:
                        send({"content": text})
                usage = {'prompt_tokens': stats['promptTokens'], 'completion_tokens': stats['outputTokens'], 'total_tokens': stats['promptTokens'] + stats['outputTokens']} if 'outputTokens' in stats else None
                send({}, 'stop', usage)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                cancelled.set()
            except Exception as error:
                self.wfile.write(("data: " + json.dumps({"error": {"message": str(error)}}) + "\n\n").encode())
                self.wfile.flush()
            finally:
                cancelled.set()
                stream.close()

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument('--settings')
    args = parser.parse_args()
    runtime = ModelRuntime(Path(args.root), Path(args.settings) if args.settings else Path(__file__).resolve().parent.parent / '.platform-home/local-settings.json')
    token = os.environ["AGENT_PLATFORM_WORKER_TOKEN"]
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(runtime, token))
    print(json.dumps({"port": server.server_address[1]}), flush=True)
    server.serve_forever()
