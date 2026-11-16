/** Stream local model files to a private staging folder; publish only a fully received upload. */
import Busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, readFile } from 'node:fs/promises';
import { dirname, join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { portablePath } from './exchange.mjs';

const MAX_BYTES = 64 * 1024 ** 3;
const extensions = new Set(['.safetensors', '.json', '.model', '.txt', '.tiktoken', '.jinja', '.jinja2', '.md', '.yaml', '.yml', '.py']);
export async function receiveModel(request, root) {
  if (!/^multipart\/form-data(?:;|$)/i.test(request.headers['content-type'] || '')) throw new Error('Send model files as multipart form data.');
  await mkdir(root, { recursive: true });
  const suffix = randomUUID().slice(0, 8), stage = join(root, '.upload-' + suffix);
  await mkdir(stage, { mode: 0o700 });
  let error, bytes = 0, count = 0;
  const tasks = [], seen = new Set();
  try {
    const parser = Busboy({ headers: request.headers, preservePath: true, defParamCharset: 'utf8', limits: { files: 2048, fields: 0, parts: 2048, fileSize: MAX_BYTES, headerPairs: 100 } });
    const fail = message => { error ||= new Error(message); };
    parser.on('filesLimit', () => fail('Upload at most 2,048 files.'));
    parser.on('fieldsLimit', () => fail('Only file fields are accepted.'));
    parser.on('partsLimit', () => fail('Too many upload parts.'));
    parser.on('file', (_field, file, info) => {
      count++;
      let path;
      try {
        path = portablePath(info.filename);
        if (extname(path).toLowerCase() === '.gguf') throw new Error('GGUF models are no longer supported. Choose a complete Transformers/safetensors model folder.');
        if (!extensions.has(extname(path).toLowerCase()) && !['LICENSE', 'NOTICE', '.gitattributes', '.gitignore'].includes(basename(path))) throw new Error('Unsupported model file: ' + path + '. Only model data, documentation and Python source are accepted; other executable files are rejected.');
        if (seen.has(path.toLowerCase())) throw new Error('Duplicate file: ' + path);
        seen.add(path.toLowerCase());
      } catch (issue) { error ||= issue; file.resume(); return; }
      file.on('limit', () => fail('A model file exceeds 64 GB.'));
      const task = (async () => {
        const destination = join(stage, path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        let fileBytes = 0;
        const weight = extname(path).toLowerCase() === '.safetensors';
        const meter = new Transform({ transform(chunk, _encoding, next) {
          bytes += chunk.length; fileBytes += chunk.length;
          if (!weight && fileBytes > (basename(path) === 'config.json' || extname(path).toLowerCase() === '.py' ? 2 : 128) * 1024 * 1024) { next(new Error('Model metadata is limited to 128 MB per file (2 MB for config.json and Python source).')); return; }
          if (bytes > MAX_BYTES) next(new Error('Model uploads are limited to 64 GB total.'));
          else next(null, chunk);
        } });
        await pipeline(file, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
        if (file.truncated) fail('A model file exceeds 64 GB.');
      })().catch(issue => { error ||= issue; parser.destroy(issue); });
      tasks.push(task);
    });
    try { await pipeline(request, parser); } catch (issue) { error ||= issue; }
    await Promise.all(tasks);
    if (error) throw error;
    if (!count) throw new Error('Choose model files or a model folder.');
    // A dropped repository folder becomes one library entry, not an extra nested directory.
    let source = stage, rows = await readdir(stage, { withFileTypes: true }), label = 'model';
    if (rows.length === 1 && rows[0].isDirectory()) { source = join(stage, rows[0].name); label = rows[0].name; rows = await readdir(source, { withFileTypes: true }); }
    if (rows.some(row => row.isFile() && /\.gguf$/i.test(row.name))) throw new Error('GGUF models are no longer supported. Choose a complete Transformers/safetensors model folder.');
    if (!rows.some(row => row.isFile() && row.name === 'config.json') || !rows.some(row => row.isFile() && /\.safetensors$/i.test(row.name))) throw new Error('Choose a complete Transformers/safetensors model folder including config.json, tokenizer files and every weight shard. GGUF and MLX models are not supported.');
    if (!rows.some(row => ['tokenizer.json', 'tokenizer.model', 'vocab.json', 'vocab.txt'].includes(row.name))) throw new Error('Tokenizer files are missing. Choose the complete model folder.');
    const config = JSON.parse(await readFile(join(source, 'config.json'), 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config.json must contain a JSON object.');
    const manifest = rows.find(row => row.name === 'basically-model.json');
    if (manifest) {
      const metadata = JSON.parse(await readFile(join(source, 'basically-model.json'), 'utf8'));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || (metadata.format && metadata.format !== 'transformers')) throw new Error('Only Transformers/safetensors models are supported. GGUF and MLX are no longer supported.');
    }
    if (rows.some(row => row.name === 'model.safetensors.index.json')) {
      const index = JSON.parse(await readFile(join(source, 'model.safetensors.index.json'), 'utf8'));
      if (!index.weight_map || typeof index.weight_map !== 'object' || Array.isArray(index.weight_map)) throw new Error('Invalid weight shard index.');
      for (const shard of new Set(Object.values(index.weight_map))) {
        portablePath(shard);
        if (shard.includes('/') || !rows.some(row => row.isFile() && row.name === shard)) throw new Error('Missing weight shard: ' + shard);
      }
    }
    const id = (label.replace(/[^\p{L}\p{N}._-]/gu, '-').replace(/^\.+/, '').slice(0, 80) || 'model') + '-' + suffix;
    await rename(source, join(root, id));
    return { id, files: count, bytes };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
