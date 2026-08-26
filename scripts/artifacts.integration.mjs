// End-to-end check against a live Ollama model: generate a small page, run the
// real message through the artifact pipeline, and inspect what the preview
// iframe would receive. Requires `ollama serve` and the model below.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.artifacts-test-bundle.mjs');
const MODEL = process.argv[2] || 'qwen3.8:latest';

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/artifacts.jsx'),
  external: ['react', 'react/jsx-runtime', 'highlight.js/lib/common', 'lucide-react'],
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { extractCodeBlocks, buildPreviewDocument, isPreviewable } = await import(pathToFileURL(OUT).href);

console.log(`Asking ${MODEL} for a page...`);
const res = await fetch('http://localhost:11434/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    messages: [{
      role: 'user',
      content: 'Write a single self-contained HTML page with a button that counts clicks. '
        + 'Put the HTML, the CSS and the JavaScript in three separate fenced code blocks.',
    }],
    options: { temperature: 0.4, num_predict: 1200 },
  }),
});
if (!res.ok) { console.error('Ollama HTTP', res.status); process.exit(1); }

// Reassemble exactly the way App.jsx composes an assistant message.
let thinking = '';
let answer = '';
let buffer = '';
const reader = res.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.message?.thinking) thinking += parsed.message.thinking;
    if (parsed.message?.content) answer += parsed.message.content;
  }
}
const messageContent = (thinking ? `<think>\n${thinking}\n</think>\n\n` : '') + answer;
console.log(`thinking: ${thinking.length} chars, answer: ${answer.length} chars`);

const blocks = extractCodeBlocks(messageContent);
console.log('\nblocks found:', blocks.map(b => `${b.language || '(none)'}:${b.content.split('\n').length}L closed=${b.closed}`).join('  '));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

check('at least one block extracted', blocks.length > 0);
check('every block is terminated', blocks.every(b => b.closed));
check('no block came from the reasoning trace',
  !blocks.some(b => thinking.includes(b.content.slice(0, 60)) && b.content.length > 60));

const previewable = blocks.filter(b => isPreviewable(b.language));
check('at least one previewable block', previewable.length > 0, blocks.map(b => b.language).join(','));

const html = previewable.filter(b => b.language === 'html').pop()?.content || '';
const css = previewable.filter(b => b.language === 'css').pop()?.content || '';
const js = previewable.filter(b => b.language === 'javascript').pop()?.content || '';
const doc = buildPreviewDocument({ html, css, script: js, scriptLanguage: 'javascript' });

check('assembled document has a doctype or <html>', /<!doctype|<html/i.test(doc));
check('console bridge present', doc.includes('__artifactConsole'));
if (css) check('css reached the document', doc.includes(css.slice(0, 30)));
if (js) check('script reached the document', doc.includes(js.slice(0, 30)));
check('exactly one <html> element', (doc.match(/<html[\s>]/gi) || []).length <= 1);

console.log('\n--- assembled preview (first 700 chars) ---');
console.log(doc.slice(0, 700));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
