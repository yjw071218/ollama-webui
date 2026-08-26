import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import hljs from 'highlight.js/lib/common';
import { Play, RefreshCcw, Copy, Check, Trash2, TriangleAlert, Pencil, RotateCcw, TextWrap } from 'lucide-react';

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
  script.src = 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js';
  script.onload = () => resolve(window.loadPyodide || null);
  script.onerror = () => resolve(null);
  document.body.appendChild(script);
});

// Modules Pyodide can install on demand, keyed by the import name.
const KNOWN_PACKAGES = new Set([
  'numpy', 'pandas', 'scipy', 'matplotlib', 'sympy', 'scikit-learn', 'sklearn',
  'networkx', 'pillow', 'PIL', 'requests', 'beautifulsoup4', 'bs4', 'regex',
  'pytz', 'dateutil', 'attrs', 'pyyaml', 'yaml', 'lxml', 'statsmodels',
]);

const PACKAGE_FOR_IMPORT = { sklearn: 'scikit-learn', PIL: 'pillow', bs4: 'beautifulsoup4', yaml: 'pyyaml', dateutil: 'python-dateutil' };

const detectImports = (code) => {
  const found = new Set();
  const re = /^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    const root = (m[1] || m[2] || '').split('.')[0];
    if (root && KNOWN_PACKAGES.has(root)) found.add(PACKAGE_FOR_IMPORT[root] || root);
  }
  return [...found];
};

export const PythonRunner = ({ code, compact = false }) => {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | running | done | error
  const [elapsed, setElapsed] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const append = useCallback((level, text) => {
    if (!mountedRef.current) return;
    setLines(prev => [...prev, { level, text }]);
  }, []);

  const runCode = async () => {
    setLines([]);
    setElapsed(null);
    setStatus('loading');
    const started = performance.now();

    try {
      if (!window.pyodideInstance) {
        append('system', 'Loading the Python runtime (first run downloads ~10 MB)…');
        const bootstrap = await loadPyodideScript();
        if (!bootstrap) throw new Error('Could not load Pyodide. A network connection is required the first time.');
        window.pyodideInstance = await bootstrap({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/' });
      }
      const pyodide = window.pyodideInstance;

      const packages = detectImports(code);
      if (packages.length > 0) {
        append('system', `Installing: ${packages.join(', ')}…`);
        await pyodide.loadPackage(packages);
      }

      setStatus('running');
      pyodide.setStdout({ batched: (msg) => append('out', msg) });
      pyodide.setStderr({ batched: (msg) => append('err', msg) });

      const result = await pyodide.runPythonAsync(code);
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
        <button className="btn pull-btn" onClick={runCode} disabled={busy}>
          {busy ? <RefreshCcw size={13} className="spin" /> : <Play size={13} />}
          {status === 'loading' ? 'Loading…' : status === 'running' ? 'Running…' : 'Run Python'}
        </button>
        {lines.length > 0 && (
          <button className="icon-btn" title="Clear output" onClick={() => { setLines([]); setStatus('idle'); setElapsed(null); }}>
            <Trash2 size={13} />
          </button>
        )}
        {elapsed !== null && <span className="py-runner-meta">{status === 'error' ? 'failed' : 'finished'} in {elapsed}s</span>}
      </div>

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

  const copy = () => {
    navigator.clipboard.writeText(code);
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
