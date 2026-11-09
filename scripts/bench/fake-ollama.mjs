// A stand-in Ollama for benches: answers any model, instantly, with a short
// streamed reply. Nothing leaves this machine and no real model runs.
//   node scripts/bench/fake-ollama.mjs <port>
import http from 'node:http';

const port = Number(process.argv[2] || 11500);
const MODEL = { name: 'bench:latest', model: 'bench:latest', modified_at: new Date().toISOString(), size: 1, digest: 'bench',
  details: { format: 'gguf', family: 'bench', parameter_size: '1B', quantization_level: 'Q4_0' } };
const json = (res, body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/version') return json(res, { version: '0.0.0-bench' });
  if (url.pathname === '/api/tags') return json(res, { models: [MODEL] });
  if (url.pathname === '/api/ps') return json(res, { models: [] });
  if (url.pathname === '/api/show') return json(res, { modelfile: '', parameters: '', template: '', details: MODEL.details, model_info: { 'general.context_length': 8192 }, capabilities: ['completion'] });
  if (url.pathname === '/api/embed' || url.pathname === '/api/embeddings') return json(res, { embeddings: [[0, 0, 0, 1]], embedding: [0, 0, 0, 1] });
  if (url.pathname === '/api/chat' || url.pathname === '/api/generate') {
    const body = await readBody(req);
    const model = body.model || MODEL.name;
    const words = ['Bench', ' reply', ' from', ' the', ' stand-in', ' model.'];
    if (body.stream === false) {
      const text = words.join('');
      return json(res, url.pathname === '/api/chat'
        ? { model, created_at: new Date().toISOString(), message: { role: 'assistant', content: text }, done: true, done_reason: 'stop', eval_count: 6, prompt_eval_count: 1 }
        : { model, created_at: new Date().toISOString(), response: text, done: true });
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const w of words) {
      res.write(JSON.stringify(url.pathname === '/api/chat'
        ? { model, created_at: new Date().toISOString(), message: { role: 'assistant', content: w }, done: false }
        : { model, created_at: new Date().toISOString(), response: w, done: false }) + '\n');
      await new Promise(r => setTimeout(r, 40));
    }
    res.end(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, response: '', done: true, done_reason: 'stop', eval_count: 6, prompt_eval_count: 1, eval_duration: 1e8 }) + '\n');
    return undefined;
  }
  json(res, { error: 'not in the bench stand-in' }, 404);
}).listen(port, '127.0.0.1', () => console.log(`fake ollama on ${port}`));
