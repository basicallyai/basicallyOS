# basically OS

A local-first AI workspace with your own models, private conversations, ordinary Markdown notes, authorized project folders and agent-managed memory. OpenRouter is the default setup option; custom compatible endpoints and local models are first-class alternatives. **No model IDs are preselected and no catalog is bundled.**

The runtime uses only Pi Agent Core + Pi AI npm packages—not a repository checkout or coding-agent CLI. Icons are from [Lucide](https://lucide.dev), served locally.

## Run from source

Requires **Node.js 24+**. Python is optional and unnecessary for API connections.

```sh
npm ci --ignore-scripts
npm start
# Optional:
npm start -- --no-open --port 3081
```

Open the authenticated local URL printed in the terminal. Keep the terminal open. The server binds only to `127.0.0.1`. The launcher attempts Firefox; the printed link works in other modern browsers too.

## npm and npx

Build and try the actual package locally, without publishing:

```sh
npm run package:npm
npm install --global ./releases/basicallyai-bos-3.2.1.tgz
basically-os --no-open
```

Or run the tarball through npx:

```sh
npx --yes --package ./releases/basicallyai-bos-3.2.1.tgz basically-os --no-open
```

The configured npm package is **`@basicallyai/bos`**; its executable remains **`basically-os`**. After owner-authorized registry publication, the registry commands will be `npm install --global @basicallyai/bos` and `npx @basicallyai/bos`. **This source push does not publish the package to npm.** Use the local tarball commands above until registry publication has been separately verified.

```text
basically-os --help
basically-os --version
basically-os --port 3081 --no-open
basically-os --data-dir "path/to/private-data"
basically-os --workspace-dir "path/to/files" --models-dir "path/to/weights"
```

Installed/npm/npx runs use persistent user storage, never the installation or npx cache:

- Windows: `%LOCALAPPDATA%/basically-os`
- macOS: `~/Library/Application Support/basically-os`
- Linux: `$XDG_DATA_HOME/basically-os` or `~/.local/share/basically-os`

Source runs retain `.platform-home/`, `workspaces/` and `local-models/` in the project. `--data-dir` or `BASICALLY_HOME` overrides private storage and puts default workspaces/models under it. `BASICALLY_WORKSPACES` and `BASICALLY_MODELS` override those independently. `PORT` changes the port; `AGENT_PLATFORM_NO_OPEN=1` disables browser opening.

## Connect a model

On a fresh Chat surface, **Add your first model** offers OpenRouter with its endpoint filled in. You can instead choose **Start with Notes — no model required**; Notes never requires a connection or attached project. To connect AI:

1. Paste your OpenRouter key. A link opens its key-creation page.
2. Enter an exact model ID, or click **Browse model IDs** to fetch the endpoint's current list.
3. Click **Add model & continue**.

No model is chosen for you. Entering an ID automatically retrieves the configured endpoint's current model catalog and fills available limits, USD-per-million prices, modalities and capabilities. Requests are debounced and coalesced, cached for 15 minutes and can be explicitly refreshed. No generation request is made. Unknown IDs, errors and missing fields are disclosed; **Limits, capabilities & pricing** permits verified manual values and preserves manual overrides. No context/output defaults or unknown cache prices are invented. Set both verified token limits before sending. OpenAI's standard `/models` response supplies IDs, not context/pricing/reasoning metadata; missing information must be configured manually. Custom catalogs need explicit pricing units (`token` or `million_tokens`); OpenRouter's documented per-token rates are converted automatically.

For an OpenRouter model, **Exact upstream provider** optionally pins an exact provider name or endpoint tag with **fallback disabled**. Its live `/models/{author}/{slug}/endpoints` metadata supplies that endpoint’s token rates and limits. If a name matches multiple endpoints, use one of the exact tags reported in the error. Changing the pin clears old rates/limits before lookup; unavailable prices remain unknown, and verified manual values are still possible. Actual provider-reported charges take priority. New rates apply to future requests only; past ledger entries are not repriced. Other APIs use a separate connection to the chosen provider’s own endpoint.

For another endpoint, select **Custom endpoint**, enter its name/base URL and select **Chat Completions** or **Responses**. Local/anonymous connections can explicitly disable API-key authentication. Remote endpoints require HTTPS; HTTP is allowed only on loopback.

Add more connections under **Settings → Models & connections**. Existing connections/default selections are not replaced by the new onboarding default. Changing an endpoint requires re-entering or clearing its saved key, so a key is not silently forwarded elsewhere. “Key saved” means locally stored, not verified by a paid request. Other native API formats require a compatible gateway.

## Conversations and Markdown

- Dark-first, responsive interface, with optional light/system appearance.
- Search titles **and message contents**, with contextual snippets, highlighted matches, clear/reset and a keyboard shortcut.
- Per-chat options in the header and beside each sidebar row: rename, pin/unpin, instructions, export, archive and permanent deletion.
- Archived conversations can be restored under **Settings → Data**. Permanent deletion removes the transcript, revisions, usage ledger and private conversation upload workspace; attached project/vault files and shared memory are kept. Stop running responses before exporting, archiving or deleting.
- Notes, Canvas, the composer and Markdown settings use one locally bundled **Tiptap/ProseMirror WYSIWYG editor**. Edit the rendered document directly: headings, bold/italic/strike, lists, tables, quotes, links and highlighted code. Completed Markdown shortcuts transform naturally; incomplete syntax stays editable. There is no default source/preview split.
- The composer is deliberately compact: text begins near the top-left with restrained padding, short messages stay shallow, multiline input grows smoothly, and long messages scroll internally instead of stretching the page. Toolbar controls stay on one aligned row. Enter sends; Shift+Enter continues a list, exits an empty list item, starts a normal paragraph after a heading, or inserts a line break in ordinary prose. Ctrl/Cmd+B/I formats selected text, Ctrl/Cmd+K inserts a link while editing (starts a new chat outside an editor), and Ctrl/Cmd+/ focuses search. Selection, native undo/redo and rich/Markdown paste use ProseMirror, not DOM replacement tricks.
- Stop, copy, regenerate and per-conversation usage are built in. Regeneration retains abandoned responses and their costs.
- Attach up to 8 UTF-8 text/code files or PNG/JPEG/WebP/GIF images, 6 MB total. Images require a vision-enabled model. PDF/Office extraction is not included. The header file button previews uploaded/generated text files before downloading; the composer folder button chooses attached-project access.

One reusable GFM renderer handles user/assistant messages, thinking panels, Markdown tool results, note previews and Markdown editors: headings, tables, nested/task lists, quotes, strikethrough, fenced code, local syntax highlighting and wiki links. Locally served **KaTeX** renders inline `$…$` / `\(…\)` and display `$$…$$` / `\[…\]` equations **in model-generated content**. User-authored notes and prompts keep dollar signs literal, so ordinary prices and prose are never silently rewritten; a note typesets only the equations a model actually added. Completed streaming blocks retain their DOM; display equations show an incomplete/streaming indicator until their closing delimiter arrives. Raw HTML stays inert. Remote HTTPS images require an explicit per-image click; authorized local raster images can display inline. Ordinary chat code is read-only and has a language/line-count header plus raw-code Copy → Check feedback. Generated text files open in a matching safe preview with Copy and Download; downloading uses the inspected UTF-8 snapshot, not regenerated or subsequently changed contents. General preferences and per-chat instructions apply to the next user message. Context compaction and delegated subagents are not included.

### Thinking and activity

Provider-exposed reasoning/summary blocks stream into a minimal inline **Thinking** disclosure in the basically orange brand colour: the arrow follows the label, reasoning text is orange, and the thin orange rule appears only while expanded. There is no enclosing box and no “provider-exposed content” caption. The panel stays separate from the final answer, keeps the user's expanded/collapsed choice, and remains available in history. Supported compatible reasoning fields and Responses events are normalized by Pi. **Hidden reasoning is never invented, inferred from answer text or extracted from encrypted signatures.** Models/endpoints that expose no reasoning show only real activity: connecting, working, writing, using tools or waiting for approval. The collapsed model control shows the exact configured display name and active effort on one line, with no provider line, raw ID or pricing metadata. Clicking it opens a compact menu anchored above the composer, not a modal: simple model rows with display names, a checkmark for the current model, and optional search for larger lists. **Effort is a separate menu item and submenu**, showing only levels the current model actually supports (hidden entirely when it supports none); the submenu flips sides when needed to stay in the window. **Manage models** opens the existing full settings interface for connections, IDs, prices and limits. Per-model effort choices persist and are sent in the actual request. The selector closes on selection, Escape, focus loss or an outside click, with arrow/Home/End keyboard navigation. OpenRouter normalized reasoning and OpenAI Completions/Responses effort use their respective payload formats; arbitrary compatible endpoints receive no guessed reasoning parameters.

## Notes and attached projects

Open **Notes → New note**, enter a title and start immediately. Notes are ordinary `.md` files, but the extension is never shown or required: the explorer, tabs, breadcrumbs, links and rename dialog use titles only, and entering `.md` is normalised away. **My Notes** is created automatically at `<private-data>/notes/`, persists across restarts and supports nested folders, search, wiki links/backlinks, tabs and splits through the same resource service as projects. It cannot be detached. The app re-establishes this fixed app-owned directory on startup; symlink roots are rejected. Conversation access remains scoped, and AI changes default to review.

Additional projects/vaults are optional: **Attach local folder** opens the operating system’s native folder chooser. On Windows this is the standard modern file picker in folder-navigation mode: navigate into the target folder and click **Open**, or paste a deeply nested path (for example `C:\Projects\Client\2026\Research`) into its address bar or the filename field. On macOS and Linux it is the native folder dialog. The app authorizes the chosen folder immediately; no path typing is required for normal navigation. A manual path entry remains available under a secondary disclosure for desktop environments without a supported native chooser. Their files stay in place, outside the installation. Switch libraries from the explorer; adding a project never replaces My Notes. Notes and main Chat share providers, tools, memory and file history.

- File/folder explorer, create, rename/move, duplicate, delete, full-text search and `path:`, `type:`, `tag:` filters.
- Multiple tabs and up to four horizontal/vertical editor panes, draggable tabs, resizable splits and persisted layouts.
- One rendered, editable Markdown document by default, with compact formatting controls. Optional Markdown source and read-only code modes remain available; non-Markdown files keep source editing.
- Debounced revision-checked autosave, synchronized document content across panes, native editing undo/redo, recoverable browser drafts and explicit conflict resolution. File history provides durable revision protection beyond the current editor session.
- External changes are polled about every 2.5 seconds. Clean open files refresh; dirty files require a choice. Ordinary same-vault external renames can follow filesystem identity into the new tab path. External renames do not automatically rewrite other files.
- Heading navigation, outgoing links, contextual backlinks, wiki aliases and broken/ambiguous-link handling. App-managed moves rewrite uniquely resolved wiki links in the bounded text index and preview all affected files. Non-wiki links, ambiguous links and unindexed contents are not silently claimed to be maintained.
- **Import Notes** accepts single/multiple Markdown files, folders and drag-and-drop (200 files / 12 MB per batch, 2 MB each). Nested paths and original UTF-8 bytes are preserved, duplicates get a safe suffix, and successful imports are immediately indexed for AI retrieval. Per-file failures are reported without pretending the whole batch succeeded.
- Original UTF-8 text/BOMs and untouched line-ending sequences are preserved. Binary/non-UTF-8 files remain untouched and can be downloaded, not edited. No executable repository code is loaded by the renderer.

**Notes AI** hosts the existing conversation interface, not a separate chatbot. It receives bounded active-document/selection context and can search/read/edit authorized files through the same agent and approvals. Move it to the left or right sidebar, a full-width bottom panel, a draggable floating panel, or an even split with the editor. Placement, size and floating position are remembered; switching never resets the active note, the conversation or unsaved edits, and narrow windows keep the panel usable. Use the composer folder button to choose a conversation's scope. A file outside that scope needs an explicit scope expansion before sending. Project-scoped chats do not expose the unrestricted shell tool.

Use `[[Note]]`, `[[folder/Note#Heading|Label]]`, `[[Note#^block]]` or `[[workspaceId::path.md]]` in chat. References resolve only inside the conversation's selected notes/project libraries. A main-chat wiki reference with no folder scope first asks permission to use My Notes; additional project access is never inferred. Ambiguous names require a choice before sending. Excerpts are bounded and versioned; missing references/sections and exhausted budgets are disclosed. Code examples and escaped wiki text are not references. A normal Markdown link can also navigate an authorized relative resource. Note embeds remain navigable references; this is not a full transclusion/plugin implementation.

Notes shortcuts: Ctrl/Cmd+P or O opens the command/file palette; Ctrl/Cmd+Shift+P opens commands; Ctrl/Cmd+Shift+F focuses file search; Ctrl/Cmd+E toggles source/rich editing; Ctrl/Cmd+N creates a note; Ctrl/Cmd+S saves; Ctrl/Cmd+Z / Shift+Z / Y undo/redo. In a Markdown source editor, Ctrl/Cmd+B/I formats a selection and Ctrl/Cmd+K inserts a wiki link. Panel boundaries support dragging, arrow keys and double-click reset. Main sidebar, Notes information/AI panel, editor splits, conversation width and reasoning/tool output sizes persist. Collapsing restores the previous size; mobile uses an overlay sidebar/side panel. Motion respects reduced-motion preferences.

The workflow takes functional inspiration from Obsidian's official documentation, without its branding/assets or plugin runtime. See [architecture, research references, security boundaries and limits](platform/ARCHITECTURE.md).

## Canvas in conversations

Ask for “a Canvas explaining this architecture” or several documents at once. **Standalone Canvases are conversation artifacts, not Notes.** Each has a stable ID, title, independent content/revision/history and an original request association, persisted in the normal conversation JSON. A compact document switcher opens one at a time. They survive navigation, refresh and server restart; closing only dismisses the view. Unrelated new messages hide the document without deleting it, and manual dismissal is respected for the rest of an active response.

- Notes and Canvas use the **same WYSIWYG editor**, with optional source mode. Direct edits autosave against the current revision; pending edits are captured before navigation/external refresh, and dirty drafts produce explicit conflicts rather than silent overwrites. Editing pauses while AI is working.
- **Save to Notes** is available in the document header and through natural conversation requests. It creates a uniquely named Markdown note, registers/indexes it, and preserves the original Canvas ID and view. From then on, **the note is the single authoritative content source**: Canvas, Notes, AI edits, renames and external changes remain synchronized. Saving an already-linked Canvas is idempotent. Interrupted linking records a recoverable pending association to prevent duplicate retry copies.
- Normal chat can find/read/create/edit/rename/compare notes without opening the Notes surface. Find/open tools handle title/content references without `.md`; ambiguity and missing authorization are explicit. Additional folders are never silently granted.
- `create_canvas`, `list_canvases`, `open_canvas`, `edit_canvas` (revision-checked exact edits or full replacement) and `save_canvas_to_notes` are real Pi tools. Linked-note mutations retain reviewed diffs and folder policy checks. Canvas reads page at 24,000 characters for large documents.
- Standalone history retains up to 30 revisions / 8 MB and supports Restore; linked Notes use the existing file-history/undo journal. Simultaneous saves serialize and reject stale revisions.
- One shared Lucide **Copy → Check → Copy** control copies raw Markdown, code or complete file content as appropriate, with 1.7-second feedback, accessible failures and no success toast.

## Web research

Click the local Lucide **Globe** beside the composer to allow web access. When enabled it uses the same orange as Thinking text. **Permission is optional capability, not a demand:** the model may answer without browsing if search would not help. The permission persists per conversation, can be turned off, and imported conversations do not activate it.

Search uses an **already-installed browser**, with no search API key or browser download. Automatic selection prefers the OS default when it is a supported browser (Chrome, Firefox, Edge, Brave or Chromium), otherwise another installed supported browser. **Settings → Preferences → Web browsing settings** lets you choose the browser and search engine (Bing by default, or DuckDuckGo). Safari and unrecognized browsers are not automated. Queries and visited URLs leave the computer; no API search-provider charge is added.

The browser runs headlessly with a fresh temporary profile—never your existing tabs, cookies, logins, extensions or personal browser history. Pages are read-only text research with site scripts and subresources blocked, not unrestricted interactive browsing. Browser startup failures, inaccessible pages and search-engine verification challenges are explicit errors; there is no CAPTCHA bypass or invented-result fallback. Previously saved API-search credentials remain private/inert during migration and are not used by the normal installed-browser workflow.

The assistant can run sequential `web_search` and `open_webpage` calls, inspect actual snippets/pages/links and cite returned HTTPS URLs. Search results and extracted pages are inspectable in collapsed tool cards. There are no fabricated/offline fallback results. Missing keys, timeouts, rate limits and unsupported pages produce explicit errors. HTML extraction never executes page scripts; public HTTPS-only document requests are fulfilled through the validated, DNS-pinned transport per redirect, blocks private/reserved addresses, and bounds response size, redirects and extracted text. Retrieved content is untrusted reference data, not permission to change files, memory or tool policy.

## Persistent memory

**Settings → Memory** provides an agent-managed library plus the real `<private-data>/app/MEMORY.md` editor. Durable preferences, project facts, decisions and workflows have IDs, revisions, tags, optional project scope, expiration and a metadata-only change audit. The assistant is instructed to search before saving, update evolving facts, consolidate related entries and remove superseded information. Retrieval combines deterministic concept expansion, weighted term overlap, scope, category, recency and an inferred/uncertainty penalty, then injects only a bounded, de-duplicated set of relevant entries. It is local and needs no embeddings service or unbilled background model. Contradictory entries with the same title are refused unless they are explicitly superseded, and each entry records whether the user stated it or the model inferred it.

Choose **review** (default: approve each agent update), **automatic** (explicitly allow structured updates), or **off** (disable automatic retrieval and model memory tools). Any conversation can also opt out individually from its header menu; that removes retrieval and memory tools for that chat without changing stored memories. Inspect, filter, create, edit, consolidate or delete memories manually. Chat recall has **no age cutoff**: matching past user prompts receive a relevance score multiplied by a smooth recency weight, so old but highly relevant material can beat recent unrelated material. Retrieval uses the age of the individual prompt, not an unrelated later edit to the chat. Only sources within the destination’s authorized workspace scope participate; opted-out sources, historical imported project bindings, attachments, tool output and hidden reasoning are excluded. Secret-pattern and saved-key checks are heuristic, not a guarantee. Use **Memory used for the last response** in the conversation menu to inspect source titles, dates and weights. Saved facts remain indefinitely by default; optional explicit deletion policies live under a disclosure and still honor any per-entry expiry you chose. These policies are not chat-recall time limits. Updates preserve project scope unless explicitly changed. New agent memories in a single-project conversation default to that project; multiple-project runs must choose scope deliberately.

`MEMORY.md` remains ordinary plaintext, with Markdown preview, revision-checked save/reload and a 64 KB limit. Every model replacement of this complete file still requires one-time approval. Each new message refreshes current context: up to 8,000 characters of this file and 8,000 of relevant managed memories plus up to 4,000 characters of weighted history (at most six excerpts, at most two per source conversation). Tool-capable models can also use `search_chat_memory` for a targeted recall query and saved-memory tools for further facts. History recall currently uses **user-authored prompts**, not complete assistant responses or a generated summary. Native local inference receives the bounded context but currently cannot call these tools.

**Do not store secrets.** Memory is local plaintext and relevant context is sent to the selected model endpoint. It is fallible reference data, never authority over approvals. Removing/expiring a saved fact does not erase its original conversation: disable memory on that source chat or delete it to exclude its prompts from future recall. It also does not rewrite older model context, exports or browser drafts that may already contain the fact.

## Complete chat import/export

Use a chat's options for a single backup, or **Settings → Data** to export all conversations, including archives. Import is available there and beside the sidebar history heading.

The versioned JSON backup includes:

- Original transcript messages, system snapshots, tool calls/results and attachment metadata.
- Regenerated revisions, timestamps, model selections, pins and conversation instructions.
- Usage ledgers and interrupted-request markers.
- Workspace files (including binary uploads and generated files), and empty directories.
- Standalone Canvas documents and request associations. Note-linked Canvas associations remain historical on import: attached note content/grants are not imported or silently reauthorized.

Import validates the entire backup before writing, assigns fresh conversation IDs and preserves archived status and Chat/Notes surface. Historical folder/resource bindings are retained as metadata, **not imported authorization**: select/authorize folders again before continuing a project conversation. Existing chats are not overwritten. No imported tool call is executed, and imported system snapshots do not replace the app's current instructions when continuing a chat. Only basically OS version-1 JSON backups are restorable; Markdown exports are readable copies, not full backups. Other chat products' proprietary formats are not currently supported.

Limits per backup: 500 chats, 4,000 workspace entries, 40 MB of workspace files, 90 MB total export / 96 MB import. Oversized or nonportable files and symlinks fail explicitly, rather than being silently omitted. Export individual chats or move large workspace files out if necessary. The app reserves chats during export to prevent conflicting app mutations; external filesystem changes are not locked.

**Backups are not encrypted.** They may contain private transcripts and files. Connections, API keys, preferences, local model weights, memory libraries, attached vault/project files, filesystem grants and editor layouts are not part of a conversation backup; back those up separately if needed.

## Tools and permissions

The assistant chooses when tools are useful. There is no Chat/Work selector.

- Attached-resource tools reject traversal, excluded credential/metadata paths, symbolic/hard links and junctions. Attached root identity is checked; replacing a root requires reauthorization.
- Private conversation writes, shell commands and complete `MEMORY.md` replacements require **one-time approval**. Attached-project AI changes default to diff review; automatic changes are a separate explicit per-folder opt-in. Structured memory has its own review/automatic/off controls.
- Project edits are revision-checked, journaled and reversible through file history. Undo refuses intervening changes; multi-file operations are not a single atomic filesystem transaction. Ordinary editor typing is an explicit user edit and autosaves without an AI approval dialog.
- **Shell commands are not sandboxed.** Approved commands run with your account's permissions from the workspace and may access files/network outside it. They have a 60-second timeout. Read approvals carefully.
- A per-message request limit bounds automatic tool follow-ups. Every completed follow-up counts in the chat's usage.
- Responses continue if the browser tab disconnects. Reopening restores status/approvals. Closing the server cancels active runs.

## Costs, privacy and storage

Completed assistant responses show measured **tok/s** for API and native local models: actual output tokens divided by request-to-completion time, including prefill/network/buffering and provider-counted reasoning. This is not a decode-only hardware benchmark. Measurements and the configured model display name persist with the response, including backups and regenerated revisions. Missing usage/timing and interrupted responses show `— tok/s`, never invented numbers. Copy/Save to Notes keeps only response content, not the performance label.

Every completed model request counts, including tool follow-ups and regenerated replies. Valid provider-reported billing takes precedence; otherwise user-configured rates are used. Missing prices/usage are explicitly unavailable, never fabricated as free. Interrupted requests retain unknown-cost markers. In-flight usage is included when it settles. Local inference has no API charge; hardware/electricity costs are not estimated.

Private storage contains `app/connections.json` (including API keys), `app/settings.json`, `app/MEMORY.md`, `app/memories.json`, `app/workspaces.json`, `app/knowledge-layout.json`, `app/file-history/`, `app/web-search.json` and `app/chats/`. Native local tuning/names also use `<private-data>/local-settings.json` and `<private-data>/local-model-names.json`. Individual persisted files use atomic replacement. Owner-only file permissions are used where supported. **Keys are local JSON, not OS-vault-encrypted**; Windows privacy depends on directory ACLs. Do not share a used profile or authenticated launch URL.

Earlier preset settings are retired with a private `app/connections.pre-user-models.json` backup; explicit custom connections and conversations are retained. Earlier-format session files are untouched and not automatically converted. Old account grants are not used/imported.

The loopback server uses authenticated HttpOnly cookies, origin/Host checks and CSP. Requests go to your configured endpoint, not a product proxy.

## Local model files

Open **Settings → Local models** and choose a complete **Transformers/safetensors** model folder. Uploads stream to a hidden staging directory, show progress and can be cancelled; only a fully received upload is added to the library. Nothing is downloaded or automatically loaded. Existing model folders are never overwritten. **GGUF and MLX are not supported**; GGUF files and folders declaring an MLX manifest are rejected.

Limits: 64 GB and 2,048 files per upload; metadata files up to 128 MB each (`config.json` up to 2 MB). Complete repositories need config, tokenizer files and all weight shards. Python source is accepted as inert repository data (2 MB per `.py` file); other executable files are rejected. Include the Python modules declared by model/tokenizer `auto_map`. Missing modules are listed explicitly—no architecture implementation is guessed or downloaded. File/header validation is not a guarantee that the installed inference backend can load a particular architecture; the library reports backend/format problems.

A Python worker starts only when checking the library or using a local model selection. Native inference currently supports text without tools; compatible local API servers can separately enable tools/vision when supported. No weights are preloaded.

- **Custom code:** the load UI defaults **Trust model repository Python code** on, forwarding `trust_remote_code=True` to both tokenizer and model loading. Detected custom code requires confirmation; you can uncheck trust. Model Python is **not sandboxed** and can use your account’s filesystem/network permissions. Import/inspection never executes it. Standard loading stays local/offline; no missing files or extra model-specific Python packages are automatically fetched.
- **No chat template:** models load and use a generic role-labelled text prompt when no native template exists. A base model is not thereby guaranteed to behave like an instruction-tuned model.
- **Context:** verified model/tokenizer limits replace the old fixed 32k assumption. The runtime caps context at 32,768 and output at the lesser of tuning, 4,096 and one quarter of context; oversized prompts retain their newest tokens. Omitted prompt-token counts are disclosed per response. Older instructions/history/memory can be omitted; unknown limits require verified repository config.
- **Names:** use **Rename** beside a local model. Its display name persists separately from its unchanged folder and ID, and appears in the selector and new response headers.

From source with Python 3.12:

```sh
python platform/setup_models.py transformers
```

Restart after setup. Installed users get private-runtime setup commands in the library rather than writing into the npm cache. See [`local-models/README.md`](local-models/README.md).

## License

[Apache-2.0](LICENSE). Bundled third-party editor code, fonts and other assets retain their respective licenses, included alongside those assets or through their npm packages.

## Development checks

```sh
npm run build
npm test
npm run test:browser
npm run test:package
python -m unittest discover -s platform -p 'test_*.py'
```

Browser checks use installed Edge on Windows or Playwright Chromium elsewhere (`npx playwright install --with-deps chromium` on Linux). Package checks install and run a real tarball, then test offline npx execution from a path containing spaces. Tests use loopback mocks, not cloud credentials/paid calls. Synthetic model uploads test file handling, not trained-model quality or architecture compatibility. `npm run test:local` additionally builds temporary random GPT-2 weights and runs actual CPU inference through Pi and the Python worker, with no chat template, trust=true, real usage/tok/s, small-context disclosure and naming persistence. It requires a working local Python runtime (`.venv` or `AGENT_PLATFORM_PYTHON`) and downloads nothing. `PLATFORM_INFERENCE_TEST=1` enables the Python suite’s real CPU tests with and without templates; it is skipped otherwise.

The browser UI lives in `platform/web/`. The ten browser workflows cover local-code trust/confirmation, local naming and response tok/s alongside per-model provider pins and pricing-reset races, attachment-popup spacing, composer heading hierarchy and logo proportions, alongside the original assistant, model selection/effort and composer density, attached projects/Notes AI, no-attachment notes, equations/GFM/highlighting, streaming DOM stability, automatic/unknown metadata, model-specific reasoning payloads, tool Markdown, panel drag/keyboard/reset/persistence, movable Notes AI placement, Canvas editing/copy, reduced motion and mobile. Node tests additionally restart the server and verify managed-note persistence. See [`DISTRIBUTION.md`](DISTRIBUTION.md) for portable releases and publication boundaries.
