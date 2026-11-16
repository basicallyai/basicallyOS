import { readFile, stat } from 'node:fs/promises';
import { extname, basename } from 'node:path';

export function resourceRoutes(resources, memories, { readBody, json }) {
  const notes = resources.notes;
  const plans = new Map();
  return async (request, response, url) => {
    const path = url.pathname, method = request.method, ref = { workspaceId: url.searchParams.get('workspaceId'), path: url.searchParams.get('path') || '' }; let match;
    if (path === '/api/workspaces' && method === 'GET') { json(response, { workspaces: resources.list(), version: resources.version }); return true; }
    if (path === '/api/workspaces' && method === 'POST') { json(response, await resources.attach(await readBody(request, 20000)), 201); return true; }
    if ((match = path.match(/^\/api\/workspaces\/([a-f0-9-]{36})$/))) {
      if (method === 'PATCH') { json(response, await resources.configure(match[1], await readBody(request, 50000))); return true; }
      if (method === 'DELETE') { await resources.detach(match[1]); json(response, { detached: true }); return true; }
    }
    if (path === '/api/resources/tree' && method === 'GET') { json(response, await resources.tree(ref.workspaceId, ref.path)); return true; }
    if (path === '/api/resources/file' && method === 'GET') { json(response, await resources.read(ref)); return true; }
    if (path === '/api/resources/asset' && method === 'GET') {
      const file = await resources.path(ref), info = await stat(file); if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('Assets must be regular files smaller than 20 MB.');
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }, mime = types[extname(file).toLowerCase()];
      response.writeHead(200, { 'Content-Type': mime || 'application/octet-stream', ...(mime ? {} : { 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(basename(file)) }) }); response.end(await readFile(file)); return true;
    }
    if (path === '/api/resources/search' && method === 'POST') { json(response, await resources.search(await readBody(request, 20000))); return true; }
    if (path === '/api/resources/resolve' && method === 'POST') {
      const body = await readBody(request, 200000); const scope = body.workspaceIds || resources.list().map(row => row.id); if (!Array.isArray(scope) || scope.length > 33 || !Array.isArray(body.targets) || body.targets.length > 100) throw new Error('Resolve at most 100 references in authorized workspaces.'); scope.forEach(id => resources.get(id));
      json(response, { links: await Promise.all(body.targets.map(target => resources.resolve(target, body.base, scope))) }); return true;
    }
    if (path === '/api/resources/links' && method === 'POST') { const body = await readBody(request, 20000); json(response, await resources.links(body.ref, body.workspaceIds)); return true; }
    if (path === '/api/resources/plan' && method === 'POST') {
      for (const [id, row] of plans) if (Date.now() - row.time > 300000) plans.delete(id);
      if (plans.size >= 10) throw new Error('Too many pending file reviews. Apply an existing review or wait five minutes for it to expire.');
      const plan = await resources.plan(await readBody(request)), bytes = plan.changes.reduce((sum, row) => sum + (row.before?.data?.length || 0) + (row.after?.data?.length || 0), 0); if ([...plans.values()].reduce((sum, row) => sum + row.bytes, bytes) > 64 * 1024 * 1024) throw new Error('Pending review snapshots exceed 64 MB. Apply an existing review or wait for expiry.'); plans.set(plan.id, { plan, bytes, time: Date.now() }); json(response, resources.preview(plan)); return true;
    }
    if (path === '/api/resources/apply' && method === 'POST') { const body = await readBody(request, 5000), row = plans.get(body.id); if (!row || Date.now() - row.time > 300000) throw new Error('Review expired. Prepare the operation again.'); plans.delete(body.id); json(response, await resources.commit(row.plan)); return true; }
    if (path === '/api/resources/save' && method === 'POST') { const body = await readBody(request); if (body.action && body.action !== 'write') throw new Error('Use the review flow for file operations.'); const result = await resources.commit(await resources.plan({ ...body, action: 'write' })); json(response, { ...result, file: await resources.read(body) }); return true; }
    if (path === '/api/resources/history' && method === 'GET') { json(response, { history: await resources.history() }); return true; }
    if (path === '/api/resources/undo' && method === 'POST') { const body = await readBody(request, 5000); json(response, await resources.undo(body.id)); return true; }
    if (path === '/api/knowledge/layout' && method === 'GET') { json(response, resources.layout); return true; }
    if (path === '/api/knowledge/layout' && method === 'PUT') { json(response, await resources.saveLayout(await readBody(request, 100000))); return true; }
    if ((match = path.match(/^\/api\/notes\/([a-f0-9-]{36})$/)) && method === 'GET') { const file = await notes.byId(match[1]); json(response, { ...file, title: file.path.replace(/\.(md|markdown)$/i, '').split('/').pop(), noteId: match[1], generatedMath: notes.metadata({ workspaceId: file.workspaceId, path: file.path }).generatedMath || [] }); return true; }
    if (path === '/api/notes/search' && method === 'POST') { const body = await readBody(request, 20000), scope = body.workspaceIds; if (!Array.isArray(scope) || scope.length > 33) throw new Error('Choose authorized libraries to search.'); json(response, await notes.find(String(body.query || '').slice(0, 500), scope)); return true; }
    if (path === '/api/memories' && method === 'GET') { json(response, { entries: memories.list({ query: url.searchParams.get('q') || '', includeExpired: true }), mode: memories.mode(), audit: memories.data.audit.slice(-50).reverse().map(({ before, after, ...row }) => row) }); return true; }
    if (path === '/api/memories' && method === 'POST') { json(response, await memories.change(await readBody(request, 50000))); return true; }
    return false;
  };
}
