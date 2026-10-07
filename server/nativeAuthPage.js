/**
 * The look of the app's sign-in pages served from the server
 * (/api/auth/native/page and the Google callback): one centred card with the
 * app's mark, a title, a line of explanation and a status that says how it is
 * going. Plain HTML with inline style -- these pages open in a bare browser
 * tab or a Custom Tab, not inside the app, so nothing of the app's stylesheet
 * is there.
 *
 * `body` goes inside the card after the text; `script` is the page's own and
 * must stay the first <script> (scripts/native-*.test.mjs run it by that).
 * The status element is `#status`; a page marks its state with
 * `data-state="working|ok|error"` and the colours follow.
 */

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f5f0;--card:#fff;--text:#1f1e1d;--muted:#6b6a68;--line:#e5e3dc;--accent:#c96442;--ok:#2e7d32;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#1a1916;--card:#262521;--text:#ecebe6;--muted:#a3a19b;--line:#3a3833;--accent:#d97757;--ok:#66bb6a;--err:#f97066}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
  word-break:keep-all;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:18px;
  padding:32px 28px 26px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.06)}
.mark{width:52px;height:52px;margin:0 auto 18px;color:var(--accent)}
h1{margin:0 0 8px;font-size:1.25rem;font-weight:650;letter-spacing:-.01em}
.lead{margin:0 0 22px;color:var(--muted);font-size:.93rem}
#button{display:flex;justify-content:center;min-height:44px;margin:0 0 16px}
#status{margin:0;min-height:1.4em;font-size:.84rem;color:var(--muted);overflow-wrap:anywhere}
#status[data-state=working]::before{content:"";display:inline-block;width:12px;height:12px;margin:0 8px -1px 0;
  border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
#status[data-state=ok]{color:var(--ok);font-weight:600;font-size:.95rem}
#status[data-state=error]{color:var(--err);font-weight:600;font-size:.9rem}
.foot{margin:22px 0 0;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.78rem}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#status[data-state=working]::before{animation:none}}
`;

// The app's mark (src/Logo.jsx), so the page is recognisably the app's.
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round">
<path d="M15 4.54A11.5 11.5 0 1 1 6.58 9.4" stroke-width="2.6"/><path d="M15.44 9.62A6.4 6.4 0 0 1 20.53 20.53" stroke-width="2.8"/></g>
<circle cx="16" cy="16" r="2.3" fill="currentColor"/></svg>`;

/* What a page script calls to say how it is going: the text, and the state
   for the colour. Guarded, because the tests run these scripts against a
   bare object standing in for the element. */
export const STATUS_HELPER = `var say = (text, state) => { const el = document.getElementById('status'); el.textContent = text; if (el.setAttribute) el.setAttribute('data-state', state || ''); };`;

export function authPage({ title, lead = '', body = '', status = '', state = '', script = '', after = '' }) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Ollama WebUI</title><style>${STYLE}</style></head>
<body><main class="card">${MARK}<h1>${escapeHtml(title)}</h1>${lead ? `<p class="lead">${escapeHtml(lead)}</p>` : ''}
${body}<p id="status" role="status" aria-live="polite"${state ? ` data-state="${state}"` : ''}>${escapeHtml(status)}</p>
<p class="foot">Ollama WebUI 앱에서 시작한 로그인일 때만 계속하세요.</p></main>
<script>${script}</script>${after}</body></html>`;
}
