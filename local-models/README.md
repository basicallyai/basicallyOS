# Local models

basically OS supports complete **Transformers/safetensors** model repositories. In
**Settings → Local models**, choose a model folder; upload progress and cancellation
are also available. Uploads stream to disk and are added only after receipt and
validation. Each import gets a new folder; existing models are never overwritten.
No weights are downloaded or auto-loaded.

Put each complete repository in its own folder:

```text
local-models/
  my-model/
    config.json
    model.safetensors
    tokenizer.json
    tokenizer_config.json
    special_tokens_map.json
    ...any other required tokenizer files...
```

Sharded safetensors are supported: include the index and every referenced shard.
Git LFS pointer files are not model weights; download the actual files.

**GGUF and MLX are not supported.** GGUF files are rejected during import. Model
folders that declare an MLX manifest (`basically-model.json` with
`"format": "mlx"`) are rejected. Existing GGUF files and MLX-declared folders in
the library are ignored or reported as unsupported rather than loaded.

Browser imports allow up to 64 GB / 2,048 files, with metadata up to 128 MB per
file (`config.json` and each `.py` source file up to 2 MB). Python source is accepted as inert model-repository data; other executable files are rejected. Include every Python module declared in the model/tokenizer `auto_map`. Missing modules are reported by name rather than downloaded or replaced with guessed implementations.
Model compatibility is checked by the library/backend after import. Local runtimes
and enough RAM/VRAM are still required; receiving files is not an inference test.

Open Local models in the sidebar, refresh the library, and load a model. Then
select Local model in the conversation's model picker. The same model serves all
conversations until you unload or replace it.

Use Setup Local Models beside the launcher to install the Transformers runtime,
then restart basically OS. It installs PyTorch, Transformers, accelerate and
safetensors into a private environment. Models without chat templates use an explicit
generic `System: … / User: … / Assistant:` text format; native templates are retained
when available. This makes base models usable, not necessarily instruction-following.

Vision/audio models and adapters without base weights are not supported by this
text-chat worker. A compatible external API server can be configured instead.

**Trust model repository Python code** is enabled by default in the loading UI and
passes `trust_remote_code=True` to both tokenizer and model loaders. Loading a detected
custom-code repository requires confirmation. Uncheck it to disallow that code.
Repository Python has your account's full permissions and is **not sandboxed**; only
load repositories you trust. Importing, naming, inspecting or refreshing never executes
model Python. Built-in Hugging Face loading uses local files only and offline mode;
arbitrary trusted Python can still perform its own network/filesystem operations.
Model-specific extra Python packages must be installed deliberately, not automatically.
RAM/VRAM must fit the model; CPU uses float32, and CUDA/MPS use automatic dtype.

Use **Rename** for a display name without moving files or changing the folder ID.
Names persist in `<private-data>/local-model-names.json`, outside the weight folders.
The loaded selector and new response headers use that name; old responses retain their
historical name.

The runtime takes the smallest usable context limit from the model/tokenizer, capped
at 32,768. It reserves at most one quarter for output (also bounded by tuning and the
4,096 runtime output cap) and retains the newest prompt tokens when the prompt will
not fit. Any omitted token count is disclosed below the response and in Local models.
This can omit older messages, instructions and memory; small models do not receive a
magically complete context. Unknown context limits require a verified config value.

Finished responses show measured output **tok/s**, using actual token counts and
request-to-completion time (including prefill/transport, not a decode-only benchmark).
No complete usage/timing means `— tok/s`, never an invented measurement.

Native local inference currently supports text without workspace tools. It receives
bounded shared memory with new user messages (subject to the model's disclosed
context budget), but cannot invoke memory editing tools. Use a tool-capable API model for workspace or memory actions;
no separate conversation mode is needed.
