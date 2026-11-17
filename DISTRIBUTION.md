# Packaging and distribution

## npm package

Requires Node.js 24+. The package supplies the `basically-os` executable and a publish-file allowlist containing only the product server, browser assets, required Python helper source, and documentation. Dependencies are ordinary npm packages. No repository checkout, browser binary, personal browser profile, chat history, weights or workspaces are included. Installed-browser research uses pinned `puppeteer-core` (no automatic browser downloads); a supported OS-installed browser is needed only for the default local search method, and only when the model chooses to browse. The ordinary Chat/Notes workspace does not require browser automation. An optional Brave/Tavily API search method is configured in Settings; it may incur provider charges.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:browser
npm run test:package
npm run package:npm
```

The tarball appears as `releases/basicallyai-bos-3.2.1.tgz`. Try it without publishing:

```sh
npm install --global ./releases/basicallyai-bos-3.2.1.tgz
basically-os --help
basically-os --no-open
```

```sh
npx --yes --package ./releases/basicallyai-bos-3.2.1.tgz basically-os --no-open
```

The npm package checks actually install and run the tarball, including its prebundled Tiptap/ProseMirror editor and third-party licenses, Canvas/code/KaTeX/font assets and hoisted runtime dependencies. Build-only editor dependencies are not installed at runtime. They also verify empty model setup, authentication, persistent standalone notes, independent Canvas creation and Save to Notes, opt-in search setup, paths containing spaces, persistent user-data directories, and absence of private/development files. They do not publish anything or call paid models.

Publication is a separate owner-authorized operation: authenticate with npm, ensure the package name is owned/available and review `npm pack --dry-run`, then publish the reviewed tarball. The configured scoped package is `@basicallyai/bos`, with public npm access metadata; that setting does not change GitHub visibility or publish anything. Until registry publication is separately verified, do not advertise `npx @basicallyai/bos` as a working registry download of this build.

Installed/npm/npx executions use the OS user-data directory, not the installation or package cache. `--data-dir` overrides it; `--workspace-dir` and `--models-dir` can independently choose file locations. Source installations keep their existing project-local directories. Use `basically-os --help` for supported flags.

## Portable archive

Optional native portable archives bundle Node **24.13.0**, production npm dependencies, product sources/assets and their licenses. Python, inference libraries, model weights, Git and GPU drivers are not bundled. API use needs no system Node/Python or build step.

```sh
npm run package:desktop
python platform/verify_release.py
```

Build natively on Windows x64, macOS ARM64/x64 or Linux ARM64/x64. Packaging stages a fresh `npm ci --omit=dev --ignore-scripts` and downloads the target Node archive, verifying Node's published SHA-256 checksum. Outputs are under `releases/` with per-archive `.sha256` files. The verifier extracts into a path containing spaces, starts bundled Node and checks the authenticated product and assets. Windows builds are not code-signed.

Extract the full archive into a writable folder and open **Start basically OS**. It stores `.platform-home/`, `workspaces/` and `local-models/` alongside the app. Keep the console open. Open the printed authenticated local link if the browser does not open.

## First launch and upgrades

**OpenRouter is preselected for setup; no model IDs are preloaded.** First launch offers connection setup or Notes without a model. Entering a model ID automatically fetches available endpoint metadata with a bounded 15-minute cache; live catalog browsing and manual values remain available. Unknown context, pricing and reasoning settings are never invented. Custom endpoints and anonymous/local connections are supported through Chat Completions and Responses. Existing saved connections and defaults are not replaced. There is no bundled model catalog or account-login flow.

Back up private data before upgrading. Prior preset connections are removed from active settings and saved in a private migration backup; explicit custom connections and conversations remain. Earlier-format session files are preserved in their original location, not automatically converted.

Keys are stored in local JSON, not an OS credential vault. Keep private-directory permissions restricted to the owner. Never share a used profile or authenticated launch URL. Remote network binding is unsupported.

My Notes is automatically managed at `<private-data>/notes/`; it works without project attachment or AI setup. Additional folders are chosen through the operating system’s native folder picker, explicitly authorized as absolute paths, and remain ordinary files outside the installation. Their grants, editor layouts and reversible file journals are private application data, not shipped assets. Resource tools validate roots, scopes and paths. Model project changes default to one-time diff approval, with a separately confirmed per-folder automatic policy. Structured memory defaults to review, with explicit automatic/off controls; full MEMORY.md replacement and private conversation writes always require approval.

**Approved shell commands are not sandboxed** and run with the user's account permissions. Project-scoped conversations do not expose that tool. Revision checks and recovery journals are application protections, not an OS filesystem sandbox or a single atomic multi-file transaction.

Memory is plaintext in `app/MEMORY.md` and `app/memories.json`; bounded relevant context enters the selected model's request unless automatic memory is off. Removing memory does not rewrite old transcripts. Conversation backups contain Chat/Notes transcripts, revisions, usage and private upload workspace files, but exclude connections/keys, preferences, weights, memory libraries, managed notes and attached vault/project files, grants and layouts. Imports retain historical bindings without restoring authorization. Back up those separate files/profile deliberately. Treat exported JSON as private, unencrypted data. See README and `platform/ARCHITECTURE.md` for limits and boundaries.

Lucide (ISC), its license and the other dependency licenses are included through normal npm dependency packaging. The browser uses a small local sprite derived from the installed icon package; it never contacts an icon CDN. Syntax highlighting and KaTeX mathematical rendering, styles and fonts load locally from their pinned packages. There are no Markdown/math/font CDN requests. Shared Markdown/wiki rendering, resource/memory services and their authenticated routes are included in the npm/portable allowlists.

Do not redistribute a used installation. Build a fresh archive or tarball from source. Existing release artifacts do not automatically receive later source changes.
