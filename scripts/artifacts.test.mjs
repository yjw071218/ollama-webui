// Bundles artifacts.jsx with rolldown (already a Vite dependency) so the pure
// helpers can be exercised in Node, then runs the assertions.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

// Emit inside the project so bare imports still resolve when Node loads it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.artifacts-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/artifacts.jsx'),
  external: ['react', 'react/jsx-runtime', 'highlight.js/lib/common', 'lucide-react'],
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const {
  extractCodeBlocks, buildPreviewDocument, normalizeLanguage, isPreviewable, isPythonish,
  computeViewport, VIEWPORT_PRESETS,
} = await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- parsing
const withThinking = `<think>
Let me sketch it first.
\`\`\`python
# scratch idea, should NOT become an artifact
print("draft")
\`\`\`
</think>

Here is the real answer.

\`\`\`python
print("final")
\`\`\``;
const b1 = extractCodeBlocks(withThinking);
check('thinking code is excluded', b1.length === 1 && b1[0].content.includes('final'), JSON.stringify(b1));

const b2 = extractCodeBlocks("Text\n\n```\nplain fenced text\n```\n");
check('unlabelled fence is captured', b2.length === 1 && b2[0].language === '' && b2[0].content === 'plain fenced text', JSON.stringify(b2));

const b3 = extractCodeBlocks("````markdown\nA doc containing:\n```js\nlet x = 1;\n```\ndone\n````");
check('4-backtick fence keeps its inner fence', b3.length === 1 && b3[0].content.includes('```js'), JSON.stringify(b3.map(b => b.content)));

const b4 = extractCodeBlocks("~~~js\nconsole.log(1);\n~~~");
check('tilde fence parsed', b4.length === 1 && b4[0].language === 'javascript', JSON.stringify(b4));

const b5 = extractCodeBlocks('```js title="demo.js"\nconst a = 1;\n```');
check('info string does not break the language', b5[0].language === 'javascript' && b5[0].meta === 'title="demo.js"', JSON.stringify(b5));

const b6 = extractCodeBlocks("```html\n<h1>hi</h1>\n");
check('unterminated fence is flagged, not dropped', b6.length === 1 && b6[0].closed === false, JSON.stringify(b6));
check('terminated fence is flagged closed', extractCodeBlocks("```html\n<h1>hi</h1>\n```")[0].closed === true);

const multi = "```html\n<div id=\"app\"></div>\n```\ntext\n```css\n#app{color:red}\n```\ntext\n```js\nconsole.log('go')\n```";
const b7 = extractCodeBlocks(multi);
check('three sibling fences parsed in order', b7.length === 3 && b7.map(b => b.language).join(',') === 'html,css,javascript', JSON.stringify(b7.map(b => b.language)));

check('language aliases', normalizeLanguage('JS') === 'javascript' && normalizeLanguage('py') === 'python' && normalizeLanguage('React') === 'jsx');
check('classification', isPreviewable('jsx') && isPreviewable('html') && isPythonish('python') && !isPreviewable('python'));

// ------------------------------------------------------- preview assembly
const jsxDoc = buildPreviewDocument({
  script: 'const App = () => <h1>Hello</h1>;\nReactDOM.createRoot(document.getElementById("root")).render(<App />);',
  scriptLanguage: 'jsx',
});
check('jsx preview loads React', jsxDoc.includes('react.production.min.js') && jsxDoc.includes('react-dom'));
check('jsx preview loads Babel', jsxDoc.includes('babel.min.js'));
check('jsx preview uses text/babel', jsxDoc.includes('type="text/babel"') && jsxDoc.includes('data-presets="react"'));
check('jsx preview provides a mount point', jsxDoc.includes('id="root"'));

const tsDoc = buildPreviewDocument({ script: 'const n: number = 41 + 1;\nconsole.log(n);', scriptLanguage: 'typescript' });
check('typescript uses the typescript preset', tsDoc.includes('data-presets="typescript"') && tsDoc.includes('babel.min.js'));
check('typescript does not pull React needlessly', !tsDoc.includes('react.production.min.js'));

const plainJs = buildPreviewDocument({ script: 'console.log("hi")', scriptLanguage: 'javascript' });
check('plain js needs no CDN', !plainJs.includes('babel.min.js') && !plainJs.includes('unpkg.com'));
check('console bridge always present', plainJs.includes('__artifactConsole'));

const fullDoc = buildPreviewDocument({
  html: '<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>',
  css: 'p{color:red}',
  script: 'console.log(1)',
  scriptLanguage: 'javascript',
});
check('full document keeps its own structure', (fullDoc.match(/<html/gi) || []).length === 1, fullDoc.slice(0, 140));
check('css injected into the existing head', fullDoc.indexOf('p{color:red}') < fullDoc.indexOf('</head>'));
check('script injected before </body>', fullDoc.indexOf('console.log(1)') < fullDoc.indexOf('</body>'));
check('bridge injected into full document too', fullDoc.includes('__artifactConsole'));

const svgDoc = buildPreviewDocument({ svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' });
check('svg is embedded in a document', svgDoc.includes('<circle') && svgDoc.includes('<!doctype html>'));

const fragment = buildPreviewDocument({ html: '<div class="card">hi</div>', css: '.card{padding:8px}' });
check('html fragment is wrapped', fragment.includes('<!doctype html>') && fragment.includes('<div class="card">'));

const bridge = plainJs.match(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/);
check('console bridge is a complete script', !!bridge);
if (bridge) {
  const body = bridge[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  try { new Function(body); check('console bridge parses as JS', true); }
  catch (e) { check('console bridge parses as JS', false, e.message); }
}

// ------------------------------------------------------- viewport sizing
const phone = VIEWPORT_PRESETS.find(p => p.id === 'phone');
const desktop = VIEWPORT_PRESETS.find(p => p.id === 'desktop');
const responsive = VIEWPORT_PRESETS.find(p => p.id === 'fit');

const fitMode = computeViewport({ preset: responsive, stage: { width: 700, height: 500 }, landscape: false, zoomMode: 'fit' });
check('responsive fills the stage', fitMode.fit === true && fitMode.width === 700 && fitMode.height === 500 && fitMode.scale === 1);

const phoneRoomy = computeViewport({ preset: phone, stage: { width: 900, height: 1200 }, landscape: false, zoomMode: 'fit' });
check('a device that fits is not upscaled', phoneRoomy.scale === 1 && phoneRoomy.width === 390 && phoneRoomy.height === 844);

const desktopTight = computeViewport({ preset: desktop, stage: { width: 640, height: 900 }, landscape: false, zoomMode: 'fit' });
check('a wide device scales down to fit', Math.abs(desktopTight.scale - 640 / 1280) < 1e-9, String(desktopTight.scale));

const shortStage = computeViewport({ preset: desktop, stage: { width: 2000, height: 400 }, landscape: false, zoomMode: 'fit' });
check('height is the limiting axis when the stage is short', Math.abs(shortStage.scale - 400 / 800) < 1e-9, String(shortStage.scale));

const rotated = computeViewport({ preset: phone, stage: { width: 2000, height: 2000 }, landscape: true, zoomMode: 'fit' });
check('rotation swaps the axes', rotated.width === 844 && rotated.height === 390);

const fixedZoom = computeViewport({ preset: desktop, stage: { width: 300, height: 300 }, landscape: false, zoomMode: '0.5' });
check('an explicit zoom overrides fit', fixedZoom.scale === 0.5);

const unmeasured = computeViewport({ preset: desktop, stage: { width: 0, height: 0 }, landscape: false, zoomMode: 'fit' });
check('an unmeasured stage does not collapse the scale', unmeasured.scale === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);


