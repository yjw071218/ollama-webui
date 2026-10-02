import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferenceHook } from './vram.js';
import { localChatModels } from '../integrations/risuai/local-model.js';
import { cliInterceptor, cliTagEntries, parseCliModel } from './cliModels.js';
import { readRequestBody } from './requestBody.js';

const DIST = fileURLToPath(new URL('../integrations/risuai/upstream/dist/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
export function createRisuRoutes({ dist = DIST, env = {} } = {}) {
  const ollama = String(env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const infer = inferenceHook({ ...env, LLM_BACKEND: 'ollama' });
  // Claude, GPT and Gemini through the signed-in CLIs. See server/cliModels.js.
  const cli = cliInterceptor(env);
  return [{ path: '/risuai', handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Works with Connect's stripped URL and the production dispatch's full URL.
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/risuai(?=\/|$)/, ''); }
    catch { res.writeHead(400); res.end('Invalid path'); return; }
    if (pathname.startsWith('/ollama/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (pathname === '/ollama/api/tags' && req.method === 'GET') {
        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const viaCli = cliTagEntries(env).catch(() => []);
        fetch(ollama + '/api/tags', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
          .then(async upstream => {
            if (!upstream.ok) throw new Error('Ollama 모델 목록을 불러오지 못했습니다.');
            const data = await upstream.json();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ models: localChatModels([...(data.models || []), ...await viaCli]) }));
          }).catch(async () => {
            if (res.destroyed || res.writableEnded) return;
            // Ollama down is not the end of roleplay when a CLI can answer.
            const models = await viaCli;
            if (models.length) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ models }));
              return;
            }
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Ollama 로컬 서버에 연결할 수 없습니다.' }));
          });
        return;
      }
      if (pathname === '/ollama/api/chat' && req.method === 'POST') {
        // Reuse resource admission, streaming and cancellation, while explicitly
        // choosing Ollama even when the main chat uses llama.cpp.
        return readRequestBody(req).then(raw => {
          const body = JSON.parse(raw.toString('utf8'));
          if (!body || !Array.isArray(body.messages)) throw new Error('Invalid messages');
          // Treat roleplay input as supplied assistant history without changing
          // the saved conversation or the speaker displayed in RisuAI.
          // Not for a CLI model: there a transcript ending on [Assistant] means
          // "continue that message", so the reply would carry on the reader's
          // own line instead of answering it (see toPrompt in cliModels.js).
          if (!parseCliModel(body.model)) {
            body.messages = body.messages.map(message => message?.role === 'user'
              ? { ...message, role: 'assistant' } : message);
          }
          req.rawBody = Buffer.from(JSON.stringify(body));
          req.headers['content-length'] = String(req.rawBody.length);
          req.url = '/api/chat';
          return cli(req, res, () => infer(req, res, () => {}));
        }).catch(error => {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        });
      }
      res.writeHead(404); res.end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (pathname === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      const installed = fs.existsSync(path.join(dist, 'version.json')) && fs.existsSync(path.join(dist, 'index.html'));
      res.end(JSON.stringify({ installed }));
      return;
    }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) { res.writeHead(403); res.end(); return; }
    const target = path.resolve(dist, '.' + (pathname || '/'), pathname === '/' || !pathname ? 'index.html' : '');
    const relative = path.relative(dist, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
    let stat;
    try { stat = fs.statSync(target); } catch { /* explicit 404, never the host SPA */ }
    if (!stat?.isFile()) { res.writeHead(404); res.end('RisuAI resource missing. Run npm run risu:setup.'); return; }
    res.setHeader('Content-Type', MIME[path.extname(target)] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache');
    if (path.extname(target) === '.html') res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(target);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } }];
}
