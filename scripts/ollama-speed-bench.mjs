import fs from 'node:fs';

// Deliberately synthetic: never reads account chats or changes model weights.
const label = process.argv[2] || 'sample';
const model = process.argv[3] || 'gemma4:31b';
const base = process.env.OLLAMA_BENCH_URL || 'http://127.0.0.1:11434';
const result = await fetch(base + '/api/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, prompt: 'Write a detailed description of a quiet forest village at sunrise. Describe the houses, sounds, people and weather.',
    stream: false, think: false, keep_alive: '15m',
    options: { num_ctx: 32768, num_predict: 96, temperature: 0, seed: 42 } }),
  signal: AbortSignal.timeout(600000),
});
if (!result.ok) throw new Error(await result.text());
const data = await result.json();
if (data.error) throw new Error(data.error);
const report = { label, model, at: new Date().toISOString(), tokens: data.eval_count,
  tokensPerSecond: data.eval_count / (data.eval_duration / 1e9),
  promptTokens: data.prompt_eval_count, promptSeconds: data.prompt_eval_duration / 1e9,
  loadSeconds: data.load_duration / 1e9, totalSeconds: data.total_duration / 1e9,
  loaded: await (await fetch(base + '/api/ps')).json() };
fs.mkdirSync('logs', { recursive: true });
fs.appendFileSync('logs/ollama-speed-bench.jsonl', JSON.stringify(report) + '\n');
console.log(JSON.stringify(report, null, 2));
