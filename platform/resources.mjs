/** Authorized local folders, shared text index, resource resolution and revision-checked reversible edits. */
import { realpath, lstat, readdir, readFile, mkdir, rm, rmdir, stat, chmod } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, dirname, basename, extname, posix } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import { atomicJson, atomicText, readJson } from './store.mjs';
import { wikiLinks, sectionExcerpt, maskMarkdownCode } from './web/wiki.js';

const LIMIT = 2 * 1024 * 1024, INDEX_BYTES = 32 * 1024 * 1024, ENTRY_LIMIT = 20000;
const excluded = new Set(['.git', '.svn', '.hg', '.obsidian', 'node_modules', '__pycache__', '.venv', '.platform-home', '.ssh', '.aws', '.azure', '.gnupg']);
const hash = data => createHash('sha256').update(data).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'); };
const conflict = message => Object.assign(new Error(message), { status: 409 });
export function resourcePath(value, root = false) {
  if (root && (value === '.' || value === '')) return '';
  if (typeof value !== 'string' || !value || value.length > 1200 || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || excluded.has(part.toLowerCase()) || /(?:\.(?:pem|key|p12|pfx|kdbx)$|^(?:credentials\.json|secrets\.json|id_rsa|id_ed25519)$)/i.test(part) || /^\.env(?:\.|$)/i.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part))) throw new Error('Use a relative authorized file path. Links, traversal, credentials and excluded directories are not accessible.');
  return value;
}
function decode(data) { if (data.includes(0)) throw new Error('Binary file: use its original application or download it.'); try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new Error('Only valid UTF-8 text is editable; the original file has not been changed.'); } }
function metadata(content) {
  const tags = [...content.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(match => match[1]);
  const front = content.match(/^---\r?\n([\s\S]{0,10000}?)\r?\n---/), properties = {};
  if (front) for (const line of front[1].split('\n')) { const match = line.match(/^([\w-]+):\s*(.+)$/); if (match) properties[match[1]] = match[2].slice(0, 500); }
  if (properties.tags) tags.push(...properties.tags.replace(/[\[\]"']/g, '').split(/[,\s]+/).filter(Boolean));
  return { tags: [...new Set(tags)].slice(0, 100), properties, headings: [...maskMarkdownCode(content).replace(/^\uFEFF/, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => match[1]).slice(0, 200) };
}
export class Resources {
  constructor(store, publish = () => {}) { this.store = store; this.publish = publish; this.queue = Promise.resolve(); this.index = new Map(); this.resolutions = new Map(); this.version = 0; this.closed = false; }
  async initialize() {
    this.file = join(this.store.directory, 'workspaces.json'); this.layoutFile = join(this.store.directory, 'knowledge-layout.json');
    this.config = await readJson(this.file, { version: 1, workspaces: [] });
    // First-party notes use the same revision checks, index and tools as optional projects.
    const notesPath = join(this.store.home, 'notes');
    await mkdir(notesPath, { recursive: true, mode: 0o700 });
    if ((await lstat(notesPath)).isSymbolicLink()) throw new Error('The managed notes directory must not be a symbolic link.');
    const notesRoot = await realpath(notesPath), identity = await stat(notesRoot, { bigint: true });
    if (!this.config.workspaces.some(row => row.managed === 'notes')) {
      const notes = { id: randomUUID(), name: 'My Notes', root: notesRoot, identity: `${identity.dev}:${identity.ino}`, managed: 'notes', vault: true, approval: 'always', context: '', attachedAt: Date.now() };
      this.config = { ...this.config, workspaces: [notes, ...this.config.workspaces] }; await atomicJson(this.file, this.config);
    } else {
      const notes = this.config.workspaces.find(row => row.managed === 'notes');
      // Only the fixed app-owned path is re-established on restart, never an arbitrary project grant.
      if (notes.root !== notesRoot || notes.identity !== `${identity.dev}:${identity.ino}`) {
        this.config = { ...this.config, workspaces: this.config.workspaces.map(row => row.id === notes.id ? { ...row, root: notesRoot, identity: `${identity.dev}:${identity.ino}` } : row) }; await atomicJson(this.file, this.config);
      }
    }
    this.historyDirectory = join(this.store.directory, 'file-history'); await mkdir(this.historyDirectory, { recursive: true, mode: 0o700 });
    this.layout = await readJson(this.layoutFile, { version: 1, activeWorkspace: null, orientation: 'horizontal', panes: [{ id: 'primary', tabs: [], active: null }], explorer: true, context: 'links' });
    await this.recover();
    this.timer = setInterval(() => this.sync().catch(() => {}), 2500); this.timer.unref();
  }
  exclusive(action) { if (this.closed) return Promise.reject(new Error('The workspace service is shutting down.')); const task = this.queue.then(action); this.queue = task.catch(() => {}); return task; }
  list() { return this.config.workspaces.map(row => ({ ...row })); }
  get(id, scope) { const row = this.config.workspaces.find(item => item.id === id); if (!row || scope && !scope.includes(id)) throw new Error('This folder is not authorized for this conversation. Attach it explicitly or choose an authorized workspace.'); return row; }
  async attach(body) {
    if (body.confirm !== true || typeof body.path !== 'string' || !isAbsolute(body.path)) throw new Error('Explicitly confirm an absolute local folder path to grant access.');
    const root = await realpath(body.path), identity = await stat(root, { bigint: true }); if (!identity.isDirectory() || dirname(root) === root || excluded.has(basename(root).toLowerCase())) throw new Error('Choose an existing project or notes folder, not a private metadata directory.');
    if (inside(this.store.directory, root)) throw new Error('The private application-data directory cannot be attached. Choose a project or notes folder instead.');
    return this.exclusive(async () => {
      if (this.config.workspaces.filter(row => !row.managed).length >= 32) throw new Error('At most 32 additional attached folders are supported.');
      if (this.config.workspaces.some(row => row.root.toLocaleLowerCase() === root.toLocaleLowerCase())) throw new Error('That folder is already attached. Use it from either Chat or Notes.');
      const row = { id: randomUUID(), name: String(body.name || basename(root)).trim().slice(0, 80) || basename(root), root, identity: `${identity.dev}:${identity.ino}`, vault: body.vault !== false, approval: 'always', context: '', attachedAt: Date.now() };
      const next = { ...this.config, workspaces: [...this.config.workspaces, row] }; await atomicJson(this.file, next); this.config = next; this.notify('attached', { workspaceId: row.id }); return row;
    });
  }
  async configure(id, body) {
    return this.exclusive(async () => {
      const row = this.get(id), next = { ...row };
      if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new Error('Use a folder label of 1–80 characters.'); next.name = body.name.trim(); }
      if (body.approval !== undefined) { if (!['always', 'automatic'].includes(body.approval) || body.approval === 'automatic' && body.confirm !== true) throw new Error('Explicitly confirm automatic AI edits.'); next.approval = body.approval; }
      if (body.context !== undefined) { if (typeof body.context !== 'string' || body.context.length > 10000) throw new Error('Project context is limited to 10,000 characters.'); next.context = body.context; }
      const config = { ...this.config, workspaces: this.config.workspaces.map(item => item.id === id ? next : item) }; await atomicJson(this.file, config); this.config = config; this.notify('configured', { workspaceId: id }); return next;
    });
  }
  async detach(id) { return this.exclusive(async () => { if (this.get(id).managed === 'notes') throw new Error('My Notes is managed by the app and cannot be detached. You can organize or delete its individual notes.'); const next = { ...this.config, workspaces: this.config.workspaces.filter(row => row.id !== id) }; await atomicJson(this.file, next); this.config = next; this.index.delete(id); this.notify('detached', { workspaceId: id }); }); }
  notify(action, data = {}) { this.version++; this.publish(null, 'resources', { action, version: this.version, ...data }); }
  async path(ref, write = false, scope) {
    const row = this.get(ref?.workspaceId, scope), path = resourcePath(ref.path ?? '', true), base = await realpath(row.root);
    const identity = await stat(base, { bigint: true });
    if (base !== row.root || row.identity !== `${identity.dev}:${identity.ino}`) throw new Error('The attached folder changed identity. Detach it and authorize it again.');
    let current = base;
    for (const part of path.split('/').filter(Boolean)) {
      current = join(current, part);
      try { const info = await lstat(current); if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new Error('Symbolic links, hard-linked files and junctions are not followed. Attach ordinary files in their own folder.'); }
      catch (error) { if (write && error.code === 'ENOENT') continue; throw error; }
    }
    if (!inside(base, current) || inside(this.store.directory, current)) throw new Error('Path is outside the authorized folder.'); return current;
  }
  async tree(id, folder = '') {
    const directory = await this.path({ workspaceId: id, path: folder });
    const rows = await readdir(directory, { withFileTypes: true });
    return { files: rows.filter(row => { try { resourcePath((folder ? folder + '/' : '') + row.name); return !row.isSymbolicLink(); } catch { return false; } }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 2000).map(row => ({ workspaceId: id, name: row.name, path: (folder ? folder + '/' : '') + row.name, directory: row.isDirectory() })), truncated: rows.length > 2000 };
  }
  async snapshot(ref, scope) {
    const file = await this.path(ref, true, scope);
    try { const info = await lstat(file); if (info.isSymbolicLink()) throw new Error('Links are not editable.'); if (info.isDirectory()) return { directory: true, ...(process.platform === 'win32' ? {} : { mode: info.mode & 0o777 }) }; if (!info.isFile() || info.size > LIMIT) throw new Error('Editable files are limited to 2 MB.'); return { data: (await readFile(file)).toString('base64'), ...(process.platform === 'win32' ? {} : { mode: info.mode & 0o777 }) }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  revision(value) { return value === null ? null : value.directory ? 'directory' : hash(Buffer.from(value.data, 'base64')); }
  async read(ref, scope) { const value = await this.snapshot(ref, scope); if (!value || value.directory) throw new Error('Text file not found.'); const content = decode(Buffer.from(value.data, 'base64')); return { ...ref, content, revision: this.revision(value), ...metadata(content), ...(this.notes?.metadata(ref) || {}) }; }
  async sync(force = false, workspaceIds) {
    if (this.closed) return;
    if (this.syncing) { await this.syncing; if (!force && this.list().every(row => this.index.has(row.id))) return; }
    if (!force && Date.now() - (this.lastScan || 0) < 1500 && this.list().every(row => this.index.has(row.id))) return;
    this.syncing = (async () => {
      const changes = [], moves = [];
      for (const workspace of this.list().filter(row => !workspaceIds || workspaceIds.includes(row.id))) {
        const previous = this.index.get(workspace.id), entries = new Map(); let bytes = 0, limited = false, error = null;
        async function walk(service, folder = '') {
          let rows; try { const tree = await service.tree(workspace.id, folder); rows = tree.files; if (tree.truncated) limited = true; } catch (issue) { limited = true; if (!folder) error = issue.message; return; }
          for (const row of rows) {
            if (entries.size >= ENTRY_LIMIT) { limited = true; break; }
            try {
              const info = await lstat(join(workspace.root, row.path), { bigint: true }); if (info.isSymbolicLink() || info.isFile() && info.nlink > 1n) { limited = true; continue; } const signature = `${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
              let entry = previous?.entries.get(row.path);
              if (!entry || entry.signature !== signature) {
                entry = { ...row, signature, size: Number(info.size), identity: `${info.dev}:${info.ino}`, modifiedAt: Number(info.mtimeMs), content: '', tags: [], properties: {}, headings: [] };
                if (!row.directory && info.size <= 512 * 1024 && bytes + Number(info.size) <= INDEX_BYTES) { try { entry.content = decode(await readFile(await service.path(row))); entry.textIndexed = true; Object.assign(entry, metadata(entry.content)); } catch { entry.binary = true; } }
              }
              if (!row.directory && !entry.textIndexed && !entry.binary && info.size <= 512 * 1024 && bytes + Number(info.size) <= INDEX_BYTES) { entry = { ...entry }; try { entry.content = decode(await readFile(await service.path(row))); entry.textIndexed = true; Object.assign(entry, metadata(entry.content)); } catch { entry.binary = true; } }
              if (!row.directory && info.size > 512 * 1024) limited = true;
              if (bytes + Buffer.byteLength(entry.content || '') > INDEX_BYTES) { entry = { ...entry, content: '', textIndexed: false }; limited = true; }
              bytes += Buffer.byteLength(entry.content || ''); entries.set(row.path, entry);
              if (row.directory) await walk(service, row.path);
            } catch { limited = true; /* Concurrently removed or inaccessible entries are absent from this index generation. */ }
          }
        }
        await walk(this);
        if (!this.config.workspaces.some(row => row.id === workspace.id)) { this.index.delete(workspace.id); continue; }
        const fingerprint = [...entries.values()].map(row => row.path + ':' + row.signature).join('\n') + ':' + error;
        this.index.set(workspace.id, { entries, fingerprint, limited, error, scannedAt: Date.now() });
        if (previous && fingerprint !== previous.fingerprint) {
          changes.push(workspace.id);
          const missing = new Map(); for (const row of previous.entries.values()) if (!entries.has(row.path) && row.identity) missing.set(row.identity, [...(missing.get(row.identity) || []), row]);
          for (const row of entries.values()) if (!previous.entries.has(row.path)) { const old = missing.get(row.identity); if (old?.length === 1) moves.push({ before: { workspaceId: workspace.id, path: old[0].path }, after: { workspaceId: workspace.id, path: row.path } }); }
        }
      }
      if (!workspaceIds) this.lastScan = Date.now();
      if (changes.length) this.notify('external', { workspaceIds: changes, moves });
    })();
    try { await this.syncing; } finally { this.syncing = null; }
  }
  entries(scope = this.list().map(row => row.id)) { return scope.flatMap(id => { this.get(id); return [...(this.index.get(id)?.entries.values() || [])]; }); }
  async search({ query = '', workspaceIds, folder = '', type = '', tag = '', limit = 100 } = {}) {
    await this.sync(); const scope = workspaceIds ?? this.list().map(row => row.id); scope.forEach(id => this.get(id));
    const tokens = String(query).slice(0, 500).match(/"[^"]+"|\S+/g) || [], filters = { folder, type, tag }, terms = [];
    for (let token of tokens) { const match = token.match(/^(path|type|tag):(.+)$/); if (match) filters[match[1] === 'path' ? 'folder' : match[1]] = match[2].replace(/^"|"$/g, ''); else terms.push(token.replace(/^"|"$/g, '').toLocaleLowerCase()); }
    const rows = this.entries(scope).filter(row => !row.directory && (!filters.folder || row.path.toLocaleLowerCase().includes(filters.folder.toLocaleLowerCase())) && (!filters.type || extname(row.path).slice(1).toLowerCase() === filters.type.replace(/^\./, '').toLowerCase()) && (!filters.tag || row.tags.some(tag => tag.toLowerCase() === filters.tag.replace(/^#/, '').toLowerCase())))
      .map(row => { const haystack = (row.path + '\n' + row.content + '\n' + JSON.stringify(row.properties)).toLocaleLowerCase(); if (!terms.every(term => term.startsWith('-') ? !haystack.includes(term.slice(1)) : haystack.includes(term))) return null; const at = Math.max(0, ...terms.filter(term => !term.startsWith('-')).map(term => row.content.toLocaleLowerCase().indexOf(term))); const before = row.content.slice(0, at).split('\n').length; return { workspaceId: row.workspaceId, path: row.path, name: row.name, tags: row.tags, modifiedAt: row.modifiedAt, line: before, snippet: row.content.slice(Math.max(0, at - 55), at + 180).replace(/\s+/g, ' '), indexed: !!row.content, score: terms.reduce((score, term) => score + (row.path.toLowerCase().includes(term) ? 3 : 0), 0) }; }).filter(Boolean).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { results: rows.slice(0, Math.min(300, Math.max(1, limit))), total: rows.length, limited: scope.some(id => this.index.get(id)?.limited), errors: scope.map(id => ({ workspaceId: id, error: this.index.get(id)?.error })).filter(row => row.error) };
  }
  resolutionIndex(scope, entries) {
    const key = [...scope].sort().join(','), cached = this.resolutions.get(key); if (cached?.version === this.version) return cached;
    const lookup = { version: this.version, paths: new Map(), names: new Map(), local: new Map() };
    for (const row of entries || this.entries(scope)) if (!row.directory) { const path = row.path.toLocaleLowerCase(), name = row.name.toLocaleLowerCase(); lookup.paths.set(path, [...(lookup.paths.get(path) || []), row]); lookup.names.set(name, [...(lookup.names.get(name) || []), row]); lookup.local.set(row.workspaceId + '::' + path, [...(lookup.local.get(row.workspaceId + '::' + path) || []), row]); }
    if (this.resolutions.size >= 16) this.resolutions.delete(this.resolutions.keys().next().value); this.resolutions.set(key, lookup); return lookup;
  }
  resolveLink(target, base, scope = this.list().map(row => row.id), entries) {
    const lookup = this.resolutionIndex(scope, entries);
    const parsed = wikiLinks('[[' + target + ']]')[0]; if (!parsed) throw new Error('Invalid wiki reference.');
    let path = parsed.path, specified;
    if (path.includes('::')) { const split = path.indexOf('::'), qualifier = path.slice(0, split); specified = scope.filter(id => { const row = this.get(id); return id === qualifier || row.name.toLocaleLowerCase() === qualifier.toLocaleLowerCase(); }); path = path.slice(split + 2); }
    const allowed = specified || scope, normalized = path.replace(/^\.\//, ''), candidates = [];
    if (!path && base?.path && allowed.includes(base.workspaceId)) candidates.push(...(lookup.local.get(base.workspaceId + '::' + base.path.toLocaleLowerCase()) || []));
    else {
      const exactNames = [normalized, normalized + '.md'].map(value => value.toLocaleLowerCase());
      const relativeNames = base && !specified ? exactNames.map(value => posix.normalize(posix.join(posix.dirname(base.path), value))) : [];
      let matches = relativeNames.flatMap(name => lookup.local.get(base.workspaceId + '::' + name) || []).filter(row => allowed.includes(row.workspaceId));
      if (!matches.length) matches = exactNames.flatMap(name => lookup.paths.get(name) || []).filter(row => allowed.includes(row.workspaceId));
      if (!matches.length && !normalized.includes('/')) matches = exactNames.flatMap(name => lookup.names.get(name) || []).filter(row => allowed.includes(row.workspaceId));
      candidates.push(...matches);
    }
    const matches = candidates.filter(Boolean).map(row => ({ workspaceId: row.workspaceId, path: row.path, heading: parsed.heading, name: this.get(row.workspaceId).name + ' / ' + row.path }));
    return { target, status: matches.length === 1 ? 'resolved' : matches.length ? 'ambiguous' : 'missing', matches };
  }
  async resolve(target, base, scope) { await this.sync(); return this.resolveLink(target, base, scope); }
  async references(text, base, scope, choices = {}) {
    await this.sync(); const refs = [], excerpts = []; let remaining = 24000;
    for (const link of wikiLinks(text).slice(0, 20)) {
      const resolution = this.resolveLink(link.target, base, scope), choice = choices[link.target];
      let ref = resolution.matches.length === 1 ? resolution.matches[0] : resolution.matches.find(row => row.workspaceId === choice?.workspaceId && row.path === choice?.path);
      if (resolution.status === 'ambiguous' && !ref) throw conflict('Ambiguous reference [[' + link.target + ']]. Choose a file before sending.');
      if (!ref) { refs.push({ target: link.target, missing: true }); excerpts.push('Unresolved reference [[' + link.target + ']]: no matching file in this conversation’s authorized folders. Do not assume its contents.'); continue; }
      let file; try { file = await this.read(ref, scope); } catch { refs.push({ target: link.target, ...ref, unavailable: true }); excerpts.push('Reference [[' + ref.workspaceId + '::' + ref.path + ']] could not be read as bounded UTF-8 text. Do not invent its contents.'); continue; }
      const excerpt = sectionExcerpt(file.content, ref.heading, Math.min(6000, remaining)); remaining -= excerpt.text.length;
      refs.push({ target: link.target, ...ref, line: excerpt.line, missingSection: excerpt.missingSection });
      excerpts.push(`Resource [[${ref.workspaceId}::${ref.path}${ref.heading ? '#' + ref.heading : ''}]], starting line ${excerpt.line}, revision ${file.revision}${excerpt.missingSection ? ' (requested section missing; no section excerpt available)' : ''}${excerpt.truncated ? ' (excerpt; use read_resource for more)' : ''}:\n${excerpt.text}`);
      if (remaining <= 0) break;
    }
    if (wikiLinks(text).length > refs.length) excerpts.push('Reference budget reached (20 links / 24,000 excerpt characters). Additional references were not read; use resource tools for targeted retrieval.');
    return { refs, text: excerpts.join('\n\n') };
  }
  async links(ref, scope) {
    await this.sync(); const source = await this.read(ref, scope), outgoing = wikiLinks(source.content).map(link => ({ ...this.resolveLink(link.target, ref, scope), context: source.content.slice(Math.max(0, link.start - 60), link.end + 90) })), incoming = [];
    for (const row of this.entries(scope)) if (!row.directory && row.content && !(row.workspaceId === ref.workspaceId && row.path === ref.path)) for (const link of wikiLinks(row.content)) {
      const found = this.resolveLink(link.target, row, scope); if (found.matches.length === 1 && found.matches[0].workspaceId === ref.workspaceId && found.matches[0].path === ref.path) incoming.push({ workspaceId: row.workspaceId, path: row.path, line: row.content.slice(0, link.start).split('\n').length, context: row.content.slice(Math.max(0, link.start - 60), link.end + 100) });
    }
    return { outgoing, incoming, headings: source.headings };
  }
  async plan(body, scope = this.list().map(row => row.id)) {
    const ref = { workspaceId: body.workspaceId, path: resourcePath(body.path) }, before = await this.snapshot(ref, scope), changes = [];
    const add = async (target, after) => { const prior = await this.snapshot(target, scope); if (after && process.platform !== 'win32') after = { ...after, mode: after.mode ?? prior?.mode ?? (after.directory ? 0o700 : 0o600) }; if (!same(prior, after)) changes.push({ ref: target, before: prior, after }); };
    if (!['write', 'edit', 'delete', 'move', 'mkdir', 'duplicate'].includes(body.action)) throw new Error('Unknown file operation.');
    if (!['mkdir'].includes(body.action) && body.revision !== this.revision(before)) throw conflict('File changed since it was read. Reload and review the current version before saving.');
    if (body.action === 'edit') {
      if (!before?.data || typeof body.find !== 'string' || !body.find || typeof body.replace !== 'string') throw new Error('Read the file and supply a non-empty exact find string and replacement.');
      const content = decode(Buffer.from(before.data, 'base64')), at = content.indexOf(body.find);
      if (at < 0 || content.indexOf(body.find, at + body.find.length) >= 0) throw new Error('The find string must match exactly once. Read a more specific context before editing.');
      body = { ...body, action: 'write', content: content.slice(0, at) + body.replace + content.slice(at + body.find.length) };
    }
    if (body.action === 'write') { if (typeof body.content !== 'string' || body.content.includes('\0') || Buffer.byteLength(body.content) > LIMIT) throw new Error('Use UTF-8 text up to 2 MB.'); if (before?.directory) throw new Error('Cannot replace a folder with a file.'); if (before) decode(Buffer.from(before.data, 'base64')); await add(ref, { data: Buffer.from(body.content).toString('base64') }); }
    if (body.action === 'mkdir') { if (before) throw new Error('That path already exists.'); await add(ref, { directory: true }); }
    if (['delete', 'move', 'duplicate'].includes(body.action)) {
      if (!before) throw new Error('File or folder not found.');
      const targets = [{ ref, value: before }];
      if (before.directory) {
        await this.sync(true); const rows = this.entries([ref.workspaceId]).filter(row => row.path.startsWith(ref.path + '/'));
        if (rows.length > 300) throw new Error('Folder operations are limited to 300 entries; use your file manager for larger moves.');
        for (const row of rows) targets.push({ ref: { workspaceId: row.workspaceId, path: row.path }, value: await this.snapshot(row, scope) });
      }
      let destination;
      if (body.action !== 'delete') { destination = { workspaceId: body.destinationWorkspaceId || ref.workspaceId, path: resourcePath(body.destination) }; this.get(destination.workspaceId, scope); if (destination.workspaceId === ref.workspaceId && (destination.path === ref.path || destination.path.startsWith(ref.path + '/'))) throw new Error('Choose a different destination outside this folder.'); }
      const moves = [];
      for (const target of targets) {
        if (destination) { const dest = { workspaceId: destination.workspaceId, path: destination.path + target.ref.path.slice(ref.path.length) }; if (await this.snapshot(dest, scope)) throw new Error('Destination already exists: ' + dest.path); await add(dest, target.value); moves.push({ before: target.ref, after: dest }); }
        if (body.action !== 'duplicate') await add(target.ref, null);
      }
      if (body.action === 'move') {
        await this.sync(true); const entries = this.entries(scope);
        for (const row of entries.filter(row => row.content && !row.directory)) {
          let content = row.content; const replacements = [];
          for (const link of wikiLinks(content)) {
            const match = this.resolveLink(link.target, row, scope, entries); if (match.matches.length !== 1) continue;
            const move = moves.find(item => item.before.workspaceId === match.matches[0].workspaceId && item.before.path === match.matches[0].path);
            const movedSource = moves.some(item => item.before.workspaceId === row.workspaceId && item.before.path === row.path);
            const destination = move?.after || (movedSource ? match.matches[0] : null);
            if (destination) replacements.push({ ...link, next: (link.embedded ? '!' : '') + '[[' + destination.workspaceId + '::' + destination.path + (link.heading ? '#' + link.heading : '') + (link.alias ? '|' + link.alias : '') + ']]' });
          }
          for (const replacement of replacements.reverse()) content = content.slice(0, replacement.start) + replacement.next + content.slice(replacement.end);
          if (content !== row.content) {
            const moved = moves.find(item => item.before.workspaceId === row.workspaceId && item.before.path === row.path), target = moved?.after || { workspaceId: row.workspaceId, path: row.path };
            const existing = changes.find(item => item.ref.workspaceId === target.workspaceId && item.ref.path === target.path);
            if (existing) existing.after = { ...existing.after, data: Buffer.from(content).toString('base64') }; else await add(target, { data: Buffer.from(content).toString('base64') });
          }
        }
      }
      body = { ...body, moves: body.action === 'move' ? moves : [] };
    }
    for (const change of [...changes]) if (change.after) {
      let parent = posix.dirname(change.ref.path);
      while (parent !== '.') {
        const target = { workspaceId: change.ref.workspaceId, path: parent };
        if (!changes.some(row => row.ref.workspaceId === target.workspaceId && row.ref.path === parent) && !await this.snapshot(target, scope)) changes.push({ ref: target, before: null, after: { directory: true } });
        parent = posix.dirname(parent);
      }
    }
    if (changes.reduce((sum, row) => sum + (row.before?.data?.length || 0) + (row.after?.data?.length || 0), 0) > 24 * 1024 * 1024) throw new Error('Reversible operations are limited to 18 MB of snapshots. Use your file manager for larger changes.');
    return { id: randomUUID(), action: body.action, changes, warnings: body.action === 'move' ? ['Only uniquely resolved wiki links in the bounded text index are updated; missing/ambiguous links, non-wiki links and unindexed contents are unchanged.', ...((scope || this.list().map(row => row.id)).some(id => this.index.get(id)?.limited) ? ['Some authorized contents are outside the search index limits. Review links manually in those files.'] : [])] : [], moves: body.moves || [], createdAt: Date.now(), roots: Object.fromEntries([...new Set(changes.map(row => row.ref.workspaceId))].map(id => [id, this.get(id, scope).root])) };
  }
  preview(plan) {
    return { id: plan.id, action: plan.action, warnings: plan.warnings || [], changes: plan.changes.map(row => {
      let diff; try { diff = createTwoFilesPatch(row.ref.path, row.ref.path, row.before?.data ? decode(Buffer.from(row.before.data, 'base64')) : '', row.after?.data ? decode(Buffer.from(row.after.data, 'base64')) : '', '', '', { context: 3, timeout: 150 }) || 'Diff computation exceeded its time budget. Review full tool arguments or source before approval.'; } catch { diff = 'Binary file or folder operation.'; }
      const truncated = diff.length > 100000 || diff.startsWith('Diff computation');
      return { ...row.ref, workspaceName: this.get(row.ref.workspaceId).name, beforeRevision: this.revision(row.before), afterRevision: this.revision(row.after), truncated, diff: diff.slice(0, 100000) + (truncated ? '\n… Preview limited. Review full arguments/source before applying this operation.\n' : '') };
    }) };
  }
  async assertVersion(row, key) { const current = await this.snapshot(row.ref); if (key === 'after' ? !same(current, row.before) : !same(current, row.before) && !same(current, row.after)) throw conflict('A file changed during the operation. External edits were not overwritten.'); return current; }
  async applyRows(rows, key) {
    for (const row of rows.filter(row => row[key] === null).sort((a, b) => b.ref.path.length - a.ref.path.length)) { const current = await this.assertVersion(row, key); if (key === 'before' && same(current, row.before)) continue; const file = await this.path(row.ref, true); const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); if (info?.isDirectory()) await rmdir(file); else await rm(file, { force: true }); }
    for (const row of rows.filter(row => row[key] !== null).sort((a, b) => a.ref.path.length - b.ref.path.length)) { const current = await this.assertVersion(row, key); if (key === 'before' && same(current, row.before)) continue; const file = await this.path(row.ref, true); await mkdir(dirname(file), { recursive: true, mode: 0o700 }); if (row[key].directory) { await mkdir(file, { recursive: true, mode: row[key].mode ?? 0o700 }); if (process.platform !== 'win32' && row[key].mode !== undefined) await chmod(file, row[key].mode); } else { await this.path(row.ref, true); await this.assertVersion(row, key); await atomicText(file, Buffer.from(row[key].data, 'base64')); if (process.platform !== 'win32' && row[key].mode !== undefined) await chmod(file, row[key].mode); } }
  }
  async commit(plan, source = 'user') {
    return this.exclusive(async () => {
      for (const [id, root] of Object.entries(plan.roots)) if (this.get(id).root !== root) throw new Error('Workspace authorization changed.');
      for (const row of plan.changes) if (!same(await this.snapshot(row.ref), row.before)) throw conflict('A file changed after review. No changes applied; reload and review again.');
      const record = { ...plan, source, status: 'preparing' }; const file = join(this.historyDirectory, plan.id + '.json'); await atomicJson(file, record);
      try { await this.applyRows(plan.changes, 'after'); record.status = 'applied'; await atomicJson(file, record); }
      catch (error) { try { for (const row of plan.changes) { const current = await this.snapshot(row.ref); if (!same(current, row.before) && !same(current, row.after)) throw conflict('External edit during rollback.'); } await this.applyRows(plan.changes, 'before'); record.status = 'rolled-back'; } catch { record.status = 'recovery-required'; } await atomicJson(file, record); throw error; }
      await this.pruneHistory(); await this.sync(true, Object.keys(plan.roots));
      const notes = await this.notes?.track(plan, source).catch(() => []) || [];
      this.notify('mutation', { operationId: plan.id, moves: plan.moves, notes, source, refs: plan.changes.map(row => row.ref) });
      return { ...this.preview(plan), operationId: plan.id };
    });
  }
  async recover() {
    for (const name of (await readdir(this.historyDirectory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const record = await readJson(join(this.historyDirectory, name), null); if (!record || !['preparing', 'recovery-required'].includes(record.status)) continue;
      try {
        for (const [id, root] of Object.entries(record.roots)) if (this.get(id).root !== root) throw new Error('Authorization changed.');
        for (const row of record.changes) { const current = await this.snapshot(row.ref); if (!same(current, row.before) && !same(current, row.after)) throw new Error('External changes require manual recovery.'); }
        await this.applyRows(record.changes, 'before'); record.status = 'rolled-back';
      } catch { record.status = 'recovery-required'; }
      await atomicJson(join(this.historyDirectory, name), record);
    }
  }
  async pruneHistory() {
    const rows = await Promise.all((await readdir(this.historyDirectory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(async name => ({ name, info: await stat(join(this.historyDirectory, name)) })));
    rows.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs); let bytes = 0;
    for (const [index, row] of rows.entries()) { bytes += row.info.size; if (index >= 100 || bytes > 64 * 1024 * 1024) { const record = await readJson(join(this.historyDirectory, row.name), null); if (['applied', 'rolled-back'].includes(record?.status)) await rm(join(this.historyDirectory, row.name)); } }
  }
  async history() { const files = (await readdir(this.historyDirectory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)); const rows = await Promise.all(files.map(file => readJson(join(this.historyDirectory, file), null))); return rows.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(row => ({ id: row.id, action: row.action, source: row.source, status: row.status, createdAt: row.createdAt, refs: row.changes.map(item => item.ref) })); }
  async undo(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid operation.');
    const prior = await readJson(join(this.historyDirectory, id + '.json'), null); if (!prior || !['applied', 'preparing', 'recovery-required'].includes(prior.status)) throw new Error('No reversible operation found.');
    const changes = prior.changes.map(row => ({ ref: row.ref, before: row.after, after: row.before }));
    const plan = { id: randomUUID(), action: 'undo', createdAt: Date.now(), changes, roots: prior.roots, moves: prior.moves.map(row => ({ before: row.after, after: row.before })) };
    return this.commit(plan, 'user undo');
  }
  async saveLayout(value) { return this.exclusive(async () => {
    if (!value || value.version !== 1 || !['horizontal', 'vertical'].includes(value.orientation) || !['links', 'ai', 'none'].includes(value.context) || !Array.isArray(value.panes) || value.panes.length < 1 || value.panes.length > 4 || Buffer.byteLength(JSON.stringify(value)) > 100000) throw new Error('Invalid editor layout.');
    const ids = new Set(), validId = id => typeof id === 'string' && /^[a-z0-9-]{1,64}$/i.test(id) && !ids.has(id);
    for (const pane of value.panes) { if (!validId(pane.id) || !Array.isArray(pane.tabs) || pane.tabs.length > 40 || pane.weight !== undefined && (!Number.isFinite(pane.weight) || pane.weight <= 0 || pane.weight > 10)) throw new Error('Invalid pane.'); ids.add(pane.id); for (const tab of pane.tabs) { this.get(tab.workspaceId); resourcePath(tab.path); if (!validId(tab.id) || !['rich', 'source', 'rendered', 'split', 'code'].includes(tab.mode)) throw new Error('Invalid editor tab.'); ids.add(tab.id); } if (pane.active != null && !pane.tabs.some(tab => tab.id === pane.active)) throw new Error('Invalid active tab.'); }
    if (value.activePane != null && !value.panes.some(pane => pane.id === value.activePane)) throw new Error('Invalid active pane.'); if (value.activeWorkspace != null) this.get(value.activeWorkspace);
    if (value.expandedFolders !== undefined) { if (!value.expandedFolders || typeof value.expandedFolders !== 'object' || Array.isArray(value.expandedFolders)) throw new Error('Invalid explorer layout.'); value.expandedFolders = Object.fromEntries(Object.entries(value.expandedFolders).filter(([id]) => this.config.workspaces.some(row => row.id === id))); for (const paths of Object.values(value.expandedFolders)) { if (!Array.isArray(paths) || paths.length > 2000) throw new Error('Invalid expanded folders.'); paths.forEach(path => resourcePath(path, true)); } }
    if (value.notesAi !== undefined) {
      const ai = value.notesAi; if (!ai || typeof ai !== 'object' || !['right', 'left', 'bottom', 'floating', 'split'].includes(ai.placement) || ai.size !== undefined && (!Number.isFinite(ai.size) || ai.size < 240 || ai.size > 2400) || ai.x !== undefined && !Number.isFinite(ai.x) || ai.y !== undefined && !Number.isFinite(ai.y)) throw new Error('Invalid Notes AI placement.');
      value.notesAi = { placement: ai.placement, size: ai.size, x: ai.x, y: ai.y };
    }
    await atomicJson(this.layoutFile, value); this.layout = value; return value;
  }); }
  async close() { this.closed = true; clearInterval(this.timer); await this.syncing?.catch(() => {}); await this.queue; }
}
