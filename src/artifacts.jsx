import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import hljs from 'highlight.js/lib/common';
import { copyText } from './clipboard.js';
import { Play, RefreshCcw, Copy, Check, Trash2, TriangleAlert, Pencil, RotateCcw, TextWrap, Square } from 'lucide-react';

/* =========================================================================
   Fence parsing
   ========================================================================= */

// Reasoning is not part of the answer, so code the model wrote while
// thinking must never become an artifact.
export const stripThinking = (text) => (text || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');

const OPEN_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/;
const CLOSE_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

const LANG_ALIASES = {
  js: 'javascript',
  node: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  react: 'jsx',
  htm: 'html',
  py: 'python',
  py3: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
};

export const normalizeLanguage = (raw) => {
  const lang = (raw || '').trim().toLowerCase();
  return LANG_ALIASES[lang] || lang;
};

/**
 * Line-based fence scanner. Handles ``` and ~~~, four-or-more markers,
 * an absent language, and info strings like ```js title="demo".
 * The old single regex required a language and could not see a closing
 * fence, so unlabelled blocks were skipped and open blocks swallowed the
 * rest of the message.
 */
export const extractCodeBlocks = (text) => {
  const lines = stripThinking(text).split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const open = OPEN_FENCE.exec(lines[i]);
    if (!open) { i++; continue; }

    const marker = open[1];
    const info = open[2] || '';
    const body = [];
    let closed = false;
    i++;

    while (i < lines.length) {
      const close = CLOSE_FENCE.exec(lines[i]);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
        closed = true;
        i++;
        break;
      }
      body.push(lines[i]);
      i++;
    }

    blocks.push({
      language: normalizeLanguage(info.trim().split(/\s+/)[0]),
      meta: info.trim().split(/\s+/).slice(1).join(' '),
      content: body.join('\n').replace(/\s+$/, ''),
      closed,
    });
  }

  return blocks;
};

/* =========================================================================
   Capability classification
   ========================================================================= */

const PREVIEWABLE = new Set(['html', 'css', 'javascript', 'jsx', 'typescript', 'tsx', 'svg']);
const NEEDS_TRANSPILE = new Set(['jsx', 'tsx', 'typescript']);

export const isPreviewable = (language) => PREVIEWABLE.has(language);
export const isPythonish = (language) => language === 'python';
export const canRun = (language) => isPythonish(language) || isPreviewable(language);

export const EXTENSION_FOR = {
  html: 'html', css: 'css', javascript: 'js', jsx: 'jsx', typescript: 'ts', tsx: 'tsx',
  python: 'py', json: 'json', markdown: 'md', bash: 'sh', sql: 'sql', java: 'java',
  c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', rust: 'rs', yaml: 'yaml', svg: 'svg',
  php: 'php', ruby: 'rb', kotlin: 'kt', swift: 'swift', xml: 'xml', toml: 'toml',
};

/* =========================================================================
   Preview document assembly
   ========================================================================= */

// Forwards console output and uncaught errors to the parent window so the
// Console tab can show what the preview actually did.
const CONSOLE_BRIDGE = `<script>(function(){
  var seen;
  function fmt(v){
    try{
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
      if (typeof v === 'function') return v.toString().split('\\n')[0];
      if (typeof v === 'undefined') return 'undefined';
      seen = new WeakSet();
      return JSON.stringify(v, function(k, val){
        if (typeof val === 'object' && val !== null){
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
        return val;
      }, 2);
    }catch(e){ return String(v); }
  }
  function send(level, args){
    try { parent.postMessage({ __artifactConsole: true, level: level, text: args.map(fmt).join(' ') }, '*'); } catch(e){}
  }
  ['log','info','warn','error','debug'].forEach(function(level){
    var original = console[level] ? console[level].bind(console) : function(){};
    console[level] = function(){ send(level, [].slice.call(arguments)); original.apply(null, arguments); };
  });
  window.addEventListener('error', function(e){
    send('error', [e.message + (e.filename ? '  (' + e.filename.split('/').pop() + ':' + e.lineno + ':' + e.colno + ')' : '')]);
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason;
    send('error', ['Unhandled promise rejection: ' + ((r && (r.stack || r.message)) || r)]);
  });
  window.addEventListener('DOMContentLoaded', function(){
    try { parent.postMessage({ __artifactConsole: true, level: 'system', text: 'ready' }, '*'); } catch(e){}
  });
})();</script>`;

const BASE_STYLE = `<style>
  html { color-scheme: light; }
  body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #fff; color: #111; }
</style>`;

const CDN = {
  babel: 'https://cdn.jsdelivr.net/npm/@babel/standalone@7.24.7/babel.min.js',
  react: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  reactDom: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
};

// A <script src> that reports its own failure instead of leaving a blank frame.
const remoteScript = (src, label) =>
  `<script src="${src}" onerror="console.error('Could not load ${label} from the CDN — the preview needs a network connection for ${label}.')"></script>`;

const looksLikeFullDocument = (html) => /<html[\s>]/i.test(html) || /<!doctype/i.test(html);

const injectIntoDocument = (html, headExtra, bodyExtra) => {
  let out = html;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>\n${headExtra}\n`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n${headExtra}\n</head>\n`);
  } else {
    out = `${headExtra}\n${out}`;
  }

  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${bodyExtra}\n</body>`);
  } else {
    out = `${out}\n${bodyExtra}`;
  }
  return out;
};

/**
 * Builds the srcDoc for the preview iframe.
 * `script` is transpiled in-browser by Babel when it is JSX or TypeScript —
 * previously that source was handed to the iframe as raw HTML, so every
 * jsx/tsx/typescript artifact previewed as a blank page.
 */
export const buildPreviewDocument = ({ html = '', css = '', script = '', scriptLanguage = 'javascript', svg = '' }) => {
  const needsTranspile = NEEDS_TRANSPILE.has(scriptLanguage);
  const needsReact = scriptLanguage === 'jsx' || scriptLanguage === 'tsx' ||
    /\bReact\b|\bReactDOM\b|\buseState\b|\buseEffect\b/.test(script);

  const presets = scriptLanguage === 'tsx'
    ? 'react,typescript'
    : scriptLanguage === 'typescript'
      ? 'typescript'
      : 'react';

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    CONSOLE_BRIDGE,
    BASE_STYLE,
    needsReact ? remoteScript(CDN.react, 'React') : '',
    needsReact ? remoteScript(CDN.reactDom, 'ReactDOM') : '',
    needsTranspile ? remoteScript(CDN.babel, 'Babel') : '',
    css ? `<style>\n${css}\n</style>` : '',
  ].filter(Boolean).join('\n');

  const scriptTag = script
    ? needsTranspile
      // data-type=module keeps top-level await and imports from breaking parsing
      ? `<script type="text/babel" data-presets="${presets}" data-type="module">\n${script}\n</script>`
      : `<script>\n${script}\n</script>`
    : '';

  if (svg) {
    return `<!doctype html><html><head>${head}</head><body>${svg}${scriptTag}</body></html>`;
  }

  if (html && looksLikeFullDocument(html)) {
    return injectIntoDocument(html, head, scriptTag);
  }

  // React needs a mount point even when the model did not provide markup.
  const bodyHtml = html || (needsReact ? '<div id="root"></div>' : '');

  return `<!doctype html>
<html>
<head>
${head}
</head>
<body>
${bodyHtml}
${scriptTag}
</body>
</html>`;
};

/* =========================================================================
   Preview frame
   ========================================================================= */

export const PreviewFrame = ({ doc, onConsole, reloadKey = 0 }) => {
  const frameRef = useRef(null);

  useEffect(() => {
    const handler = (event) => {
      const frame = frameRef.current;
      // The frame is sandboxed without allow-same-origin, so its origin is
      // "null"; identify it by window reference instead.
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || !data.__artifactConsole) return;
      if (data.level === 'system') return;
      onConsole?.({ level: data.level, text: data.text, at: Date.now() });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onConsole]);

  return (
    <iframe
      key={reloadKey}
      ref={frameRef}
      title="Artifact preview"
      srcDoc={doc}
      sandbox="allow-scripts allow-modals allow-forms allow-popups"
      style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#fff' }}
    />
  );
};


/* =========================================================================
   Preview stage — device presets, zoom-to-fit, rotation
   ========================================================================= */

export const VIEWPORT_PRESETS = [
  { id: 'fit', label: 'Responsive', width: null, height: null },
  { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
  { id: 'laptop', label: 'Laptop', width: 1024, height: 700 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'phone', label: 'Phone', width: 390, height: 844 },
];

/**
 * Works out the device box and the scale needed to fit it into the stage.
 * `zoomMode` is either 'fit' or a numeric scale as a string.
 */
export const computeViewport = ({ preset, stage, landscape, zoomMode }) => {
  if (!preset || !preset.width) {
    return { width: stage.width, height: stage.height, scale: 1, fit: true };
  }
  const width = landscape ? preset.height : preset.width;
  const height = landscape ? preset.width : preset.height;

  let scale = 1;
  if (stage.width > 0 && stage.height > 0) {
    scale = zoomMode === 'fit'
      ? Math.min(1, stage.width / width, stage.height / height)
      : (Number(zoomMode) || 1);
  }
  return { width, height, scale, fit: false };
};

export const PreviewStage = ({ doc, onConsole, reloadKey, presetId, onPresetChange, landscape, onToggleOrientation, zoomMode, onZoomChange }) => {
  const stageRef = useRef(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  // The scale factor depends on how much room the panel actually gives us,
  // so measure the stage rather than guessing from the window.
  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) setStageSize({ width: box.width, height: box.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const preset = VIEWPORT_PRESETS.find(p => p.id === presetId) || VIEWPORT_PRESETS[0];
  const { width: deviceWidth, height: deviceHeight, scale, fit: isFit } =
    computeViewport({ preset, stage: stageSize, landscape, zoomMode });

  return (
    <div className="preview-wrap">
      <div className="preview-toolbar">
        <div className="preview-presets">
          {VIEWPORT_PRESETS.map(p => (
            <button
              key={p.id}
              className={`preview-preset ${p.id === preset.id ? 'active' : ''}`}
              onClick={() => onPresetChange(p.id)}
              title={p.width ? `${p.width} × ${p.height}` : 'Fill the panel'}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="preview-toolbar-right">
          {!isFit && (
            <>
              <span className="preview-dims">{Math.round(deviceWidth)} × {Math.round(deviceHeight)}</span>
              <button className="icon-btn" title="Rotate" onClick={onToggleOrientation}>
                <RotateCcw size={14} />
              </button>
              <select
                className="preview-zoom"
                value={zoomMode}
                onChange={e => onZoomChange(e.target.value)}
                title="Zoom"
              >
                <option value="fit">Fit ({Math.round(scale * 100)}%)</option>
                <option value="1">100%</option>
                <option value="0.75">75%</option>
                <option value="0.5">50%</option>
                <option value="0.25">25%</option>
              </select>
            </>
          )}
        </div>
      </div>

      <div className="preview-stage" ref={stageRef}>
        {/* transform: scale() does not shrink the layout box, so the stage
            would keep scrolling at any zoom below 100%. The sizer carries the
            scaled dimensions; the viewport inside keeps its real ones. */}
        <div
          className={isFit ? 'preview-sizer fill' : 'preview-sizer'}
          style={isFit ? undefined : {
            width: `${Math.ceil(deviceWidth * scale)}px`,
            height: `${Math.ceil(deviceHeight * scale)}px`,
          }}
        >
          <div
            className={`preview-viewport ${isFit ? 'fill' : 'device'}`}
            style={isFit ? undefined : {
              width: `${deviceWidth}px`,
              height: `${deviceHeight}px`,
              transform: `scale(${scale})`,
            }}
          >
            <PreviewFrame doc={doc} onConsole={onConsole} reloadKey={reloadKey} />
          </div>
        </div>
      </div>
    </div>
  );
};

/* =========================================================================
   Console pane
   ========================================================================= */

export const ConsolePane = ({ entries, onClear }) => (
  <div className="artifact-console">
    <div className="artifact-console-bar">
      <span>{entries.length} message{entries.length === 1 ? '' : 's'}</span>
      <button className="icon-btn" title="Clear console" onClick={onClear}><Trash2 size={13} /></button>
    </div>
    <div className="artifact-console-body">
      {entries.length === 0 && (
        <div className="artifact-console-empty">
          Nothing logged yet. <code>console.log</code>, uncaught errors and rejected promises from the
          preview show up here.
        </div>
      )}
      {entries.map((entry, i) => (
        <div key={i} className={`console-line console-${entry.level}`}>
          <span className="console-level">{entry.level}</span>
          <pre>{entry.text}</pre>
        </div>
      ))}
    </div>
  </div>
);

/* =========================================================================
   Python runner (Pyodide)
   ========================================================================= */

// Pinned, and in one place, because the runtime and the package catalogue are
// the same download: a version is a Python version *and* a set of pre-built
// packages. 0.25.0 was two years old and carried 260 of them; this one carries
// 356, and the difference includes pygame.
export const PYODIDE_VERSION = '314.0.6';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const loadPyodideScript = () => new Promise((resolve) => {
  if (window.loadPyodide) return resolve(window.loadPyodide);
  const existing = document.getElementById('pyodide-script');
  if (existing) {
    existing.addEventListener('load', () => resolve(window.loadPyodide || null), { once: true });
    existing.addEventListener('error', () => resolve(null), { once: true });
    return;
  }
  const script = document.createElement('script');
  script.id = 'pyodide-script';
  script.src = `${PYODIDE_BASE}pyodide.js`;
  script.onload = () => resolve(window.loadPyodide || null);
  script.onerror = () => resolve(null);
  document.body.appendChild(script);
});

/* ------------------------------------------------- getting the imports in
 *
 * This used to be a hand-written list of twenty-two module names. Pyodide
 * ships three hundred and fifty-six, and anything outside the list was simply
 * not installed -- the code ran anyway and failed on the import, which is how
 * `import pygame` produced a ModuleNotFoundError next to a Run button that had
 * said nothing about needing to install anything.
 *
 * Nothing is listed by hand now. Three sources answer the question in turn,
 * each of them authoritative about its own part:
 *
 *   1. `loadPackagesFromImports` is Pyodide's own -- it reads the code and
 *      loads whatever it has built for it. Three hundred and fifty-six
 *      packages, kept current by the people who build them.
 *   2. Python itself says what is still missing, via `importlib.util.find_spec`
 *      against `sys.stdlib_module_names`. No guessing about which names are
 *      standard library and no list of them here to fall out of date.
 *   3. `micropip` installs the rest from PyPI, which covers every pure-Python
 *      package there is.
 *
 * What is left over after all three is genuinely unavailable, and the runner
 * says so before running rather than after failing.
 */

// Import names that differ from the name the package is published under.
// Unavoidably a list, because the mapping is a fact about the packaging
// ecosystem rather than something either side can be asked for -- but only the
// exceptions, and only where the two genuinely differ.
export const PACKAGE_FOR_IMPORT = {
  sklearn: 'scikit-learn',
  PIL: 'pillow',
  bs4: 'beautifulsoup4',
  yaml: 'pyyaml',
  dateutil: 'python-dateutil',
  cv2: 'opencv-python',
  serial: 'pyserial',
  OpenGL: 'pyopengl',
  dotenv: 'python-dotenv',
  git: 'gitpython',
  // pygame-ce is the community fork, and the one Pyodide builds. It installs
  // as `pygame`, so code written against pygame needs no changes.
  pygame: 'pygame-ce',
};

// Reading the imports with Python's own parser rather than a regular
// expression: `import` inside a string, a comment or a docstring is not an
// import, and a regex over source cannot tell the difference. `ast` is in the
// standard library, so this costs nothing to load.
export const FIND_MISSING_IMPORTS = `
import ast, sys, importlib.util, json

def _webui_missing(src):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        # Let the real run report the syntax error, with its line number.
        return []
    roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            # level > 0 is a relative import -- a sibling file, not a package.
            if node.level == 0 and node.module:
                roots.add(node.module.split('.')[0])
    missing = [
        name for name in sorted(roots)
        if name not in sys.stdlib_module_names
        and importlib.util.find_spec(name) is None
    ]
    return json.dumps(missing)
`;

/**
 * Install whatever the code imports, before running it.
 *
 * Three passes, and the order matters: Pyodide's own builds are faster and
 * better tested than anything from PyPI, so they are asked first; PyPI covers
 * the long tail; and anything still missing is reported by name, before the
 * run, instead of surfacing as a traceback at the first import.
 *
 * Nothing here throws on a package it cannot install. A script that imports
 * one optional thing inside a `try` should still run, and the model does write
 * those -- so a failure is a line of output and the run continues.
 */
const ensurePackages = async (pyodide, code, append) => {
  // 1. Pyodide's own catalogue, via its own reader of the code.
  try {
    await pyodide.loadPackagesFromImports(code, {
      messageCallback: () => {},
      errorCallback: () => {},
    });
  } catch (err) {
    // A package that fails to load is reported by the missing-import pass
    // below, which is a better message than whatever this threw.
  }

  // 2. Ask Python what is still not importable. `find_spec` against
  //    `sys.stdlib_module_names` means no list of standard-library names here,
  //    and no guessing about what step 1 already handled.
  let missing = [];
  try {
    pyodide.runPython(FIND_MISSING_IMPORTS);
    const findMissing = pyodide.globals.get('_webui_missing');
    const raw = findMissing(code);
    missing = JSON.parse(raw || '[]');
    // Proxies to Python objects are not garbage collected by the JS engine;
    // leaking one per run would keep the interpreter's copy alive too.
    findMissing.destroy?.();
  } catch (err) {
    return;   // Cannot tell; let the run report whatever actually breaks.
  }
  if (missing.length === 0) return;

  // 3. PyPI, for the pure-Python long tail.
  append('system', `Installing from PyPI: ${missing.join(', ')}…`);
  let micropip;
  try {
    await pyodide.loadPackage('micropip');
    micropip = pyodide.pyimport('micropip');
  } catch (err) {
    append('err', `Could not load the installer: ${err.message || err}`);
    return;
  }

  const failed = [];
  for (const name of missing) {
    const distribution = PACKAGE_FOR_IMPORT[name] || name;
    try {
      await micropip.install(distribution);
    } catch (err) {
      failed.push({ name, distribution, reason: String(err.message || err) });
    }
  }

  for (const { name, distribution, reason } of failed) {
    // The commonest cause by far, and the one worth explaining: the package
    // has compiled C in it. Nothing can install those at runtime -- they have
    // to be built for WebAssembly ahead of time, which is what Pyodide's own
    // catalogue is. Saying "no matching wheel" to someone whose game will not
    // start is technically true and no help at all.
    const isBinary = /wheel|binary|abi|platform|not found|no match/i.test(reason);
    append('err', isBinary
      ? `${name} is not available in the browser. ${distribution} has compiled parts, and only packages built for WebAssembly ahead of time can be installed here.`
      : `Could not install ${name}: ${reason}`);
  }
};

/**
 * A game loop that will lock the tab, spotted before it does.
 *
 * The page runs Python on the one thread it draws with, so `while True:` never
 * gives it back. There is no stop button that can help: the click cannot be
 * processed, because processing it is what the loop is preventing. The only
 * way out is reloading the page, which takes the conversation's scroll
 * position and the artifact panel with it.
 *
 * So the check happens before the code runs, and it is a warning rather than a
 * refusal -- a deliberate busy loop is a legitimate thing to write, and the
 * warning says what to change rather than standing in the way.
 *
 * Only the shape that actually hangs is flagged: a loop with an `await` in it
 * yields to the browser on every pass and is exactly the fix being suggested.
 */
export const findsBlockingLoop = (code) => {
  // `await` anywhere in the file clears it. Being precise about whether the
  // await is inside *this* loop would need a parser, and staying quiet about a
  // loop that does yield somewhere is the safe direction to be wrong in.
  if (/\bawait\b/.test(code)) return false;

  // `while True:` is the obvious shape and was the only one checked, which is
  // why this kept letting real games through. The loop a model actually writes
  // is the one from every pygame tutorial ever published:
  //
  //     running = True
  //     while running:
  //         for event in pygame.event.get():
  //             if event.type == pygame.QUIT:
  //                 running = False
  //         ...
  //         clock.tick(60)
  //
  // `running` is never set false in a browser, because the QUIT event comes
  // from closing a window and there is no window to close. So it is `while
  // True:` wearing a variable, and it hangs the tab exactly as hard.
  const anyWhile = /^[ \t]*while\b[^\n:]*:/m.test(code);
  if (!anyWhile) return false;

  const literallyForever = /^[ \t]*while\s+(True|1)\s*:/m.test(code);
  if (literallyForever) return true;

  // A conditional loop is only a hazard when it is driving something that
  // redraws. A `while queue:` that consumes a list finishes; a loop containing
  // a frame clock or an event pump does not, because what would end it never
  // arrives. These are the marks of a loop meant to run until a window closes.
  const drivesAFrameLoop = /\bclock\.tick\s*\(|\bpygame\.(display|event|time)\b|\bturtle\.(update|mainloop|done)\b|\btime\.sleep\s*\(/.test(code);
  return drivesAFrameLoop;
};

/* Whether this code wants to draw.
 *
 * SDL has to be handed a canvas before `pygame.display.set_mode()` is called.
 * Without one it does not raise -- it *hangs*, reaching into an undefined
 * context for `createImageData` and never returning, which takes the tab with
 * it. So the canvas is prepared in advance, from the source, rather than
 * created in response to the drawing that can no longer happen.
 *
 * A regex is enough here, unlike for installing: the cost of being wrong is an
 * empty canvas nobody draws on, or none where one was wanted and the run says
 * so. Neither is a hang.
 */
const GRAPHICS_MODULES = /^\s*(?:import|from)\s+(pygame|turtle)\b/m;

/* Making a desktop game loop survivable in a browser.
 *
 * A loop written for a desktop never returns, and here the thread it never
 * returns from is the one that draws the page. Refusing to run it is honest
 * but useless -- the code is fine, it is the environment that is different --
 * and explaining the fix asks somebody to edit code they did not write.
 *
 * The fix is always the same shape, so it is applied instead of described:
 * hand control back to the browser once per pass, and check whether Stop has
 * been pressed. Done with Python's own parser, because indentation is
 * significant, loops nest, and "append a line to the end of the loop body" is
 * not something a regular expression can locate.
 *
 * Two deliberate exemptions. A loop that already awaits is already
 * cooperative. And a loop inside a `def` is left alone: `await` there would
 * require the function to become `async def`, which changes how every caller
 * has to invoke it -- a rewrite with consequences beyond the loop.
 */
export const ASYNCIFY_SOURCE = `
import ast

def _webui_asyncify(src):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None

    touched = False

    class Yielder(ast.NodeTransformer):
        def visit_While(self, node):
            nonlocal touched
            self.generic_visit(node)
            if any(isinstance(n, ast.Await) for n in ast.walk(node)):
                return node
            touched = True
            node.body.extend(ast.parse(
                "await asyncio.sleep(0)\\n"
                "if _webui_should_stop(): break\\n"
            ).body)
            return node

        def visit_FunctionDef(self, node):
            return node

        def visit_AsyncFunctionDef(self, node):
            return node

    tree = Yielder().visit(tree)
    if not touched:
        return None
    ast.fix_missing_locations(tree)
    return "import asyncio\\n" + ast.unparse(tree)
`;

/**
 * Rewrite `code` so its loops yield, or return null if there is nothing to do.
 *
 * Runs inside Pyodide because that is where a Python parser is. Any failure
 * returns null and the caller falls back to refusing the run, which is the
 * behaviour this replaces rather than something worse than it.
 */
const asyncifyLoops = async (pyodide, code) => {
  try {
    pyodide.runPython(ASYNCIFY_SOURCE);
    const rewrite = pyodide.globals.get('_webui_asyncify');
    const out = rewrite(code);
    rewrite.destroy?.();
    return out || null;
  } catch (err) {
    return null;
  }
};

export const PythonRunner = ({ code, compact = false }) => {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | running | done | error
  const [elapsed, setElapsed] = useState(null);
  // Kept off screen until something is going to draw on it, so a script that
  // prints numbers does not grow an empty grey box underneath it.
  const [showCanvas, setShowCanvas] = useState(false);
  const canvasRef = useRef(null);
  const mountedRef = useRef(true);
  // Read by the rewritten loop through `_webui_should_stop`, once per pass.
  // A ref rather than state: the Python side asks for it synchronously, and it
  // must be the current value, not the one from the render that started the run.
  const stopRef = useRef(false);

  // Set on the way in as well as cleared on the way out. Only clearing it is
  // the obvious version and it is wrong under StrictMode, which mounts,
  // unmounts and remounts every component in development: the cleanup ran, the
  // flag went false, and nothing ever put it back — so `append` discarded
  // every line for the life of the component. Python ran, drew, and printed
  // into a void, with an empty output pane underneath saying nothing at all.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const append = useCallback((level, text) => {
    if (!mountedRef.current) return;
    setLines(prev => [...prev, { level, text }]);
  }, []);

  /**
   * `force` is what the "run it anyway" button passes.
   *
   * A loop that never yields is not a thing this can survive: Python holds the
   * one thread the page draws with, so the tab stops responding and even the
   * Stop button cannot be clicked -- processing that click is precisely what
   * the loop is preventing. The only way out is reloading the page, which
   * takes the artifact panel, the scroll position and any unsent draft with
   * it.
   *
   * A warning printed *next to* the run does not help, because by the time it
   * is on screen the tab is already gone. So the run does not start: the
   * warning takes the place of the output, with the fix in it and a button for
   * people who meant it.
   */
  const runCode = async (force = false) => {
    setElapsed(null);

    setLines([]);
    setStatus('loading');
    stopRef.current = false;
    const started = performance.now();

    try {
      if (!window.pyodideInstance) {
        append('system', 'Loading the Python runtime — the first run downloads it, later runs reuse it…');
        const bootstrap = await loadPyodideScript();
        if (!bootstrap) throw new Error('Could not load Pyodide. A network connection is required the first time.');
        window.pyodideInstance = await bootstrap({ indexURL: PYODIDE_BASE });
      }
      const pyodide = window.pyodideInstance;

      await ensurePackages(pyodide, code, append);

      // Stop, in a form Python can act on. There is no way to interrupt a
      // running Python from outside it here, so stopping is cooperative: the
      // rewritten loop asks, once per pass, whether it should break.
      pyodide.globals.set('_webui_should_stop', () => stopRef.current);

      let source = code;
      if (!force && findsBlockingLoop(code)) {
        const rewritten = await asyncifyLoops(pyodide, code);
        if (rewritten) {
          source = rewritten;
          append('system',
            'This loop would never hand the page back, so it was given a pause on each '
            + 'pass — the game runs, the browser stays responsive, and Stop works. '
            + 'Your code is unchanged; only what was run is.');
        } else {
          // Could not rewrite it, so running it would hang the tab. Say so
          // rather than doing it.
          setStatus('blocked');
          return;
        }
      }

      // Before the packages are used, and before anything can call set_mode.
      if (GRAPHICS_MODULES.test(code)) {
        setShowCanvas(true);
        // Two frames: one to put the canvas in the document, one for the
        // browser to lay it out. Registering an unlaid-out canvas hands SDL a
        // context with no dimensions.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (canvasRef.current && pyodide.canvas?.setCanvas2D) {
          pyodide.canvas.setCanvas2D(canvasRef.current);
        }
      }


      setStatus('running');
      // Let React paint the Stop button before handing the thread to Python.
      // Without this the run begins in the same task as the state update and
      // the button does not exist until the program has already finished.
      await new Promise(resolve => requestAnimationFrame(resolve));
      pyodide.setStdout({ batched: (msg) => append('out', msg) });
      pyodide.setStderr({ batched: (msg) => append('err', msg) });

      const result = await pyodide.runPythonAsync(source);
      if (result !== undefined && result !== null) append('out', String(result));

      if (mountedRef.current) {
        setElapsed(((performance.now() - started) / 1000).toFixed(2));
        setStatus('done');
      }
    } catch (err) {
      append('err', err.message || String(err));
      if (mountedRef.current) {
        setElapsed(((performance.now() - started) / 1000).toFixed(2));
        setStatus('error');
      }
    }
  };

  const busy = status === 'loading' || status === 'running';

  return (
    <div className={compact ? 'py-runner compact' : 'py-runner'}>
      <div className="py-runner-bar">
        <button className="btn pull-btn" onClick={() => runCode()} disabled={busy}>
          {busy ? <RefreshCcw size={13} className="spin" /> : <Play size={13} />}
          {status === 'loading' ? 'Loading…' : status === 'running' ? 'Running…' : 'Run Python'}
        </button>
        {/* Only while something is actually running, and only meaningful for
            a loop that was rewritten to check the flag — which is exactly the
            kind of program anyone needs to stop. */}
        {status === 'running' && (
          <button className="icon-btn" title="Stop" onClick={() => { stopRef.current = true; }}>
            <Square size={12} fill="currentColor" stroke="none" />
          </button>
        )}
        {lines.length > 0 && (
          <button className="icon-btn" title="Clear output" onClick={() => { setLines([]); setStatus('idle'); setElapsed(null); setShowCanvas(false); }}>
            <Trash2 size={13} />
          </button>
        )}
        {elapsed !== null && <span className="py-runner-meta">{status === 'error' ? 'failed' : 'finished'} in {elapsed}s</span>}
      </div>

      {status === 'blocked' && (
        <div className="py-blocked">
          <div className="py-blocked-head">
            <TriangleAlert size={14} />
            <strong>This would freeze the page</strong>
          </div>
          <p>
            The code has a <code>while True:</code> loop with no <code>await</code> in it.
            Python runs on the same single thread the page is drawn with, so a loop like
            that never hands control back — the tab stops responding, and the Stop button
            cannot help, because processing that click is exactly what the loop is
            preventing. The only way out would be reloading the page.
          </p>
          <p>The same game, written so the browser gets a turn between frames:</p>
          <pre>{[
            'import asyncio, pygame',
            '',
            'async def main():',
            '    while True:',
            '        # ... handle events, update, draw ...',
            '        pygame.display.flip()',
            '        await asyncio.sleep(0)   # let the browser breathe',
            '',
            'asyncio.ensure_future(main())',
          ].join('\n')}</pre>
          <div className="py-blocked-actions">
            <button className="btn pull-btn" onClick={() => runCode(true)}>Run it anyway</button>
            <span>Asking the model to “rewrite this as an async loop for the browser” usually fixes it in one go.</span>
          </div>
        </div>
      )}

      {showCanvas && (
        <div className="py-canvas-wrap">
          {/* `id="canvas"` as well as the ref: Emscripten's SDL looks the
              element up by that id when it has not been handed one, and a
              build that takes that path would otherwise find nothing. */}
          <canvas id="canvas" ref={canvasRef} className="py-canvas" width={320} height={240} />
        </div>
      )}

      {lines.length > 0 && (
        <div className="py-runner-output">
          {lines.map((line, i) => (
            <div key={i} className={`console-line console-${line.level === 'err' ? 'error' : line.level === 'system' ? 'system' : 'log'}`}>
              <pre>{line.text}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/* =========================================================================
   Code view — highlighted, with line numbers and an edit mode
   ========================================================================= */

export const CodeView = ({ code, language, editable = false, onChange, onReset, isEdited }) => {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(() => localStorage.getItem('codeWrap') === 'true');

  useEffect(() => { localStorage.setItem('codeWrap', String(wrap)); }, [wrap]);

  const highlighted = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch (e) {
      // Fall back to escaped plain text rather than dropping the view.
      return code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    }
  }, [code, language]);

  const lineCount = code.split('\n').length;

  const copy = async () => {
    // See src/clipboard.js: the modern API does not exist over plain HTTP,
    // which is every address but the one the server itself is opened on.
    if (!await copyText(code)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-view">
      <div className="code-view-bar">
        <span className="code-view-lang">{language || 'text'}</span>
        <span className="code-view-meta">{lineCount} lines</span>
        {isEdited && <span className="code-view-edited">edited</span>}
        <div style={{ flex: 1 }} />
        <button
          className={`icon-btn ${wrap ? 'toggled' : ''}`}
          title={wrap ? 'Disable word wrap' : 'Wrap long lines'}
          onClick={() => setWrap(v => !v)}
        >
          <TextWrap size={14} />
        </button>
        {editable && (
          <button className="icon-btn" title={editing ? 'Done editing' : 'Edit and re-run'} onClick={() => setEditing(v => !v)}>
            {editing ? <Check size={14} /> : <Pencil size={14} />}
          </button>
        )}
        {editable && isEdited && (
          <button className="icon-btn" title="Revert to the model's version" onClick={onReset}>
            <RotateCcw size={14} />
          </button>
        )}
        <button className="icon-btn" title="Copy code" onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      {editing ? (
        <textarea
          className="code-view-editor"
          value={code}
          spellCheck={false}
          onChange={e => onChange?.(e.target.value)}
        />
      ) : (
        <div className={`code-view-body ${wrap ? 'wrap' : ''}`}>
          <div className="code-view-gutter" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => <span key={i}>{i + 1}</span>)}
          </div>
          <pre className="code-view-pre"><code
            className={`hljs language-${language || 'plaintext'}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          /></pre>
        </div>
      )}
    </div>
  );
};

export const UnsupportedPreview = ({ language }) => (
  <div className="artifact-unsupported">
    <TriangleAlert size={22} />
    <p><strong>{language || 'This language'}</strong> cannot run in the browser.</p>
    <p>HTML, CSS, JavaScript, JSX, TypeScript and SVG render in the preview; Python runs via Pyodide.</p>
  </div>
);
