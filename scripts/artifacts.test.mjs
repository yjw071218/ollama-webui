// Bundles artifacts.jsx with rolldown (already a Vite dependency) so the pure
// helpers can be exercised in Node, then runs the assertions.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
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
  PACKAGE_FOR_IMPORT, findsBlockingLoop, FIND_MISSING_IMPORTS, PYODIDE_VERSION,
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

/* ------------------------------------------- where a fence is recognised */

// A block of code and a word inside a sentence are different things, and the
// app confused them for a whole major version of react-markdown.
//
// The renderer used to be mapped onto `code` and asked its own `inline` prop
// which of the two it was. react-markdown stopped passing `inline` in v9 --
// the string does not appear anywhere in v10's source -- so it was `undefined`
// on every call, `if (!inline)` was true on every call, and every scrap of
// inline code became a full bordered block with a language header and a copy
// button. "Use the `useState` hook" rendered as three separate pieces. It also
// nested a <div> and a <pre> inside a <p>, which is invalid HTML that browsers
// silently restructure.
//
// The fix is to stop asking. A fence is the only thing that parses to a <pre>,
// so the renderer is mapped there and inline code never reaches it. These
// checks are what keep it that way: none of them passes if someone maps it
// back onto `code`, or starts trusting `inline` again.
// Line endings are normalised because this repository checks out with
// `core.autocrlf=true`, so a source file's newlines depend on whether git
// last touched it. A pattern anchored on \n would then pass or fail for a
// reason that has nothing to do with the code it is checking.
const appSource = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

check('the code renderer is mapped onto pre, not code',
  /pre:\s*\(props\)\s*=>\s*<MarkdownCodeBlock/.test(appSource)
  && !/\bcode:\s*\(props\)\s*=>\s*<MarkdownCodeBlock/.test(appSource));

// Comments stripped first: the renderer's own comment explains this bug at
// length, and a check that its explanation counts as a recurrence is a check
// that punishes writing one down.
const renderer = appSource
  .slice(appSource.indexOf('const MarkdownCodeBlock'), appSource.indexOf('function App('))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
check('nothing in the renderer depends on an `inline` prop', !/\binline\b/.test(renderer),
  (renderer.match(/.*\binline\b.*/) || [''])[0].trim());

// And the premise the whole thing rests on, asserted against the installed
// copy rather than remembered: if a future version starts passing `inline`
// again, the reasoning above needs revisiting rather than silently rotting.
const markdownSource = fs.readFileSync(
  path.resolve(HERE, '../node_modules/react-markdown/lib/index.js'), 'utf8');
check('react-markdown still does not pass `inline`', !markdownSource.includes('inline'));

/* ------------------------------------------ installing what Python imports */

// The runner used to carry a hand-written list of twenty-two module names and
// install nothing outside it — so `import pygame` ran, failed on the import,
// and the Run button had said nothing about needing to install anything.
//
// Nothing is listed by hand now except the names that genuinely differ between
// the import and the package, so what is checked here is that the machinery
// stays that way: the version is pinned in one place, the import-to-package
// exceptions are right, and the Python that finds missing imports is real
// Python. The snippet itself is executed against a local interpreter by
// `scripts/pyimports.test.mjs`, which is where the parsing is proved.

check('the Pyodide version is pinned in one place', /^\d+\.\d+\.\d+$/.test(PYODIDE_VERSION || ''), PYODIDE_VERSION);

// pygame is the one that prompted all this. Pyodide builds the community fork,
// which installs as `pygame`, so code written against pygame needs no changes —
// but it has to be *asked for* under the name Pyodide publishes.
check('pygame maps to the fork Pyodide actually builds', PACKAGE_FOR_IMPORT.pygame === 'pygame-ce');
check('sklearn still maps to scikit-learn', PACKAGE_FOR_IMPORT.sklearn === 'scikit-learn');
check('PIL still maps to pillow', PACKAGE_FOR_IMPORT.PIL === 'pillow');
check('cv2 maps to opencv-python', PACKAGE_FOR_IMPORT.cv2 === 'opencv-python');

// Only exceptions belong in the map. An entry mapping a name to itself is a
// line that does nothing and invites the list to grow back into the catalogue
// it replaced.
const pointless = Object.entries(PACKAGE_FOR_IMPORT).filter(([k, v]) => k === v);
check('the map holds only the names that differ', pointless.length === 0, pointless.map(([k]) => k).join(', '));

check('the missing-import finder is a Python snippet, not a regex',
  FIND_MISSING_IMPORTS.includes('import ast')
  && FIND_MISSING_IMPORTS.includes('sys.stdlib_module_names')
  && FIND_MISSING_IMPORTS.includes('find_spec'));

/* ------------------------------------------------- loops that hang the tab */

// Python runs on the thread the page draws with, so `while True:` never gives
// it back — and the Stop button cannot help, because processing the click is
// what the loop is preventing. Flagged before running, not after hanging.
check('a bare game loop is flagged', findsBlockingLoop('while True:\n    tick()'));
// The shape that kept getting through, and the one models actually write:
// `running` is never set false in a browser, because the QUIT event comes from
// closing a window and there is no window to close. It is `while True:` wearing
// a variable, and it hangs the tab exactly as hard.
check('so is the pygame tutorial loop',
  findsBlockingLoop('running = True\nwhile running:\n    for e in pygame.event.get():\n        pass\n    clock.tick(60)'));
check('and a redraw loop with any condition',
  findsBlockingLoop('done = False\nwhile not done:\n    pygame.display.flip()\n    clock.tick(30)'));
check('and a sleep loop', findsBlockingLoop('while True:\n    time.sleep(1)'));
// A conditional loop that is not driving a screen finishes on its own, and
// flagging those would rewrite ordinary code for no reason.
check('a loop that consumes a list is left alone',
  !findsBlockingLoop('queue = [1, 2, 3]\nwhile queue:\n    queue.pop()'));
check('and a counting loop is left alone',
  !findsBlockingLoop('n = 10\nwhile n > 0:\n    n -= 1'));
check('so is `while 1:`', findsBlockingLoop('while 1:\n    tick()'));
check('and one inside a function', findsBlockingLoop('def go():\n    while True:\n        tick()'));

// The suggested fix must not itself be flagged, or the warning tells people to
// do something it then complains about.
check('an awaiting loop is fine',
  !findsBlockingLoop('async def main():\n    while True:\n        await asyncio.sleep(0)'));
check('a loop with a condition is fine', !findsBlockingLoop('while running:\n    tick()'));
check('code with no loop is fine', !findsBlockingLoop('print("hello")'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);


