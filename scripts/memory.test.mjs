// Covers the pure parts of cross-chat memory and the HTML exporter.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const bundleOne = async (entry, out) => {
  const bundle = await rolldown({
    input: path.resolve(HERE, entry),
    external: ['localforage'],
    platform: 'neutral',
  });
  const file = path.resolve(HERE, out);
  await bundle.write({ file, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(file).href);
};

const memory = await bundleOne('../src/memory.js', '../node_modules/.memory-test-bundle.mjs');
const html = await bundleOne('../src/htmlExport.js', '../node_modules/.html-test-bundle.mjs');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ------------------------------------------------------------------- memory
const { isDuplicate, newMemory, formatMemories, MEMORY_KINDS, EXTRACTION_SCHEMA } = memory;

const existing = [
  newMemory('The user prefers replies in Korean', 'preference'),
  newMemory('The user is building a local Ollama web UI', 'project'),
];

check('catches a reworded duplicate', isDuplicate('The user prefers Korean replies', existing));
check('catches an exact duplicate', isDuplicate('The user prefers replies in Korean', existing));
check('lets an unrelated fact through', !isDuplicate('The user lives in Seoul', existing));
check('lets a different project through', !isDuplicate('The user runs a bakery in Busan', existing));
check('rejects an empty candidate', isDuplicate('', existing));
check('rejects a candidate with no significant words', isDuplicate('a an of', existing));
check('an empty store accepts anything', !isDuplicate('The user likes tea', []));

const made = newMemory('  The user uses Windows 11  ', 'fact');
check('trims the text', made.text === 'The user uses Windows 11');
check('is enabled by default', made.enabled === true);
check('has a unique id', newMemory('a').id !== newMemory('a').id);
check('an unknown kind falls back', newMemory('x', 'nonsense').kind === 'fact');
check('a known kind is kept', newMemory('x', 'preference').kind === 'preference');

const formatted = formatMemories([
  newMemory('The user prefers Korean', 'preference'),
  newMemory('The user runs Ollama locally', 'project'),
  { ...newMemory('Disabled fact', 'fact'), enabled: false },
]);
check('groups by kind', formatted.includes('preference:') && formatted.includes('project:'));
check('lists the enabled facts', formatted.includes('The user prefers Korean'));
check('leaves out disabled facts', !formatted.includes('Disabled fact'));
check('tells the model not to recite them', /do not recite/i.test(formatted));
check('an empty set produces nothing', formatMemories([]) === '');
check('an all-disabled set produces nothing',
  formatMemories([{ ...newMemory('x'), enabled: false }]) === '');

check('the schema requires an array of memories',
  EXTRACTION_SCHEMA.properties.memories.type === 'array'
  && EXTRACTION_SCHEMA.required.includes('memories'));
check('the schema constrains kind to the known set',
  JSON.stringify(EXTRACTION_SCHEMA.properties.memories.items.properties.kind.enum) === JSON.stringify(MEMORY_KINDS));

// -------------------------------------------------------------- html export
const { renderMarkdown, sessionToHtml } = html;

check('renders a heading', renderMarkdown('## Title').includes('<h3>Title</h3>'));
check('renders bold', renderMarkdown('a **b** c').includes('<strong>b</strong>'));
check('renders inline code', renderMarkdown('use `npm test`').includes('<code>npm test</code>'));
check('renders a bullet list', renderMarkdown('- one\n- two').includes('<li>one</li>'));
check('renders a numbered list', renderMarkdown('1. one\n2. two').includes('<ol>'));
check('renders a link', renderMarkdown('[docs](https://example.com)').includes('href="https://example.com"'));
check('renders a fenced block', renderMarkdown('```js\nlet x = 1;\n```').includes('<pre class="code" data-lang="js">'));

// Escaping is the part that matters: an export must not smuggle markup out.
check('escapes html in prose', renderMarkdown('<script>alert(1)</script>').includes('&lt;script&gt;'));
check('emits no raw script tag', !renderMarkdown('<script>alert(1)</script>').includes('<script>'));
check('escapes html inside code', renderMarkdown('```\n<img onerror=x>\n```').includes('&lt;img'));
check('ignores a javascript: link',
  !renderMarkdown('[x](javascript:alert(1))').includes('href="javascript:'));

const session = {
  title: 'Ollama & <tags>',
  createdAt: Date.UTC(2026, 0, 2),
  lastModel: 'qwen3.8',
  messages: [
    { role: 'user', content: 'How do I keep a model loaded?', at: Date.UTC(2026, 0, 2) },
    { role: 'assistant', content: '<think>secret reasoning</think>Use **keep_alive**.\n\n```bash\nollama run x\n```' },
    { role: 'user', content: '<TOOL_RESULT>internal</TOOL_RESULT>' },
  ],
};
const doc = sessionToHtml(session);

check('is a complete document', doc.startsWith('<!doctype html>') && doc.includes('</html>'));
check('escapes the title', doc.includes('Ollama &amp; &lt;tags&gt;'));
check('includes both real turns', (doc.match(/class="turn /g) || []).length === 2);
check('drops the reasoning', !doc.includes('secret reasoning'));
check('drops the tool round-trip', !doc.includes('internal'));
check('renders the answer', doc.includes('<strong>keep_alive</strong>'));
check('carries the code block', doc.includes('ollama run x'));
check('has no external requests', !/<(script|link)\b/i.test(doc));
check('names the model', doc.includes('qwen3.8'));
check('handles an empty session', sessionToHtml({ title: 'Empty', messages: [] }).includes('0 messages'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
