// What a walk through every screen at 1440 and 390 wide turned up.
//
// Each of these read correctly in the source and looked wrong on the screen:
// help text with a class nothing styled, a button with no height, a tab strip
// that wrapped, a notice on the send button. The checks hold the fixes in
// place; the screenshots are what found them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const app = read('src/App.jsx');
const css = read('src/extras.css');
const i18n = read('src/i18n.jsx');
const everywhere = (key) => (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length === 12;

/* ------------------------------------------------------------- settings */

// Used in the app, styled nowhere: rendered as body text, larger than its heading.
for (const cls of ['setting-help', 'settings-desc']) {
  const used = app.includes(`className="${cls}"`);
  check(`.${cls} is styled wherever it is used`, !used || new RegExp(`\\.${cls}[,\\s{]`).test(css));
}
check('a primary button on its own has a height', /\.pull-btn \{\s*min-height:/.test(css));
check('the settings tabs are one row on a desktop, and do not collapse to nothing',
  /@media \(min-width: 861px\) \{\s*\.settings-modal \{ max-width: \d+px; \}\s*\.settings-tabs \{[^}]*flex: 0 0 auto;[^}]*flex-wrap: nowrap;/.test(css));
check('  and the dialog keeps one height as tabs change', /\.settings-modal:has\(\.settings-tabs\) \{ height:/.test(css));
check('the data tab is one grid of like buttons', /className="settings-actions data-actions"/.test(app)
  && (app.match(/className="data-action( danger)?"/g) || []).length === 6);
check('  and deleting everything asks in the reader’s language, in the app’s own dialog',
  /confirmDialog\(t\('data\.confirmClearAll'\), \{ danger: true/.test(app) && !/window\.confirm\(/.test(app));
check('an import says whether it worked', /toast\(t\('data\.imported', \{ n: toAdd\.length \}\), 'success'\)/.test(app)
  && /toast\(t\('data\.importFailed'/.test(app));
check('the server-setup instructions are folded away',
  /<details className="settings-fold">\s*\n\s*<summary><span>\{t\('auth\.socialSetup'\)\}<\/span><\/summary>/.test(app));
check('memory kinds are words, not identifiers', /\{t\(`memory\.kind\.\$\{k\}`\)\}/.test(app));
check('a Windows path placeholder shows single backslashes', !/placeholder="C:\\\\\.\.\.\\\\sample\.wav"/.test(app));
for (const key of ['data.imported', 'data.importFailed', 'data.importNotChats', 'data.confirmClearAll',
  'memory.kind.profile', 'memory.kind.preference', 'memory.kind.project', 'memory.kind.fact',
  'studio.note.krea2-turbo', 'studio.note.anima-base', 'studio.note.minimax-h3']) {
  check(`${key} is translated everywhere`, everywhere(key));
}
check('no Korean string carries markdown asterisks into plain text', !/'backup\.help': '[^']*\*\*/.test(i18n));
check('the brainstorm starter is one language', !/'empty\.brainstorm': '아이디어 brainstorming'/.test(i18n));

/* -------------------------------------------------------------- sidebar */

check('the persona button sits beside "new chat"', /\.sidebar-header \{\s*display: flex;/.test(css));
check('the active place has no stray rail', /\.sidebar-places button\.is-on::before \{ content: none; \}/.test(css));
{
  const places = (app.match(/<div className="sidebar-places"[\s\S]*?\.map\(/) || [''])[0];
  const count = (places.match(/\['[a-z]+', /g) || []).length;
  const cols = [...css.matchAll(/\.sidebar-places \{[^}]*grid-template-columns: ([^;]+);/g)].pop()?.[1] || '';
  const colCount = /repeat\((\d+)/.test(cols) ? Number(cols.match(/repeat\((\d+)/)[1]) : cols.trim().split(/\s+/).length;
  check('every sidebar place fits on one row', count > 0 && colCount === count, `${count} places, ${colCount} columns`);
}
check('  and every place label is translated', !/\['risu', '상황극'\]/.test(app) && everywhere('risu.place'));
check('the running-commands pill clears the open sidebar on a desktop',
  /html:has\(\.claude-sidebar\.open\) \.commands-dock \{\s*left: calc\(var\(--sidebar-width/.test(css));
check('  and stays out of the drawer on a phone',
  /@media \(max-width: 860px\) \{\s*html:has\(\.claude-sidebar\.open\) \.commands-dock \{ display: none; \}/.test(css));
/* ------------------------------------------- second pass: every place */

{
  // A <label> sitting on top of an <input> is not attached to it: a screen
  // reader announced the temperature slider as "slider, 0.7". Every such pair
  // inside the settings dialog must point at its label.
  const start = app.indexOf('{/* Settings Overlay */}');
  const end = app.indexOf('<Transition open={showPalette}');
  const settings = start >= 0 && end > start ? app.slice(start, end) : '';
  const bare = settings.match(/<label>[^<]{1,140}<\/label>\s*<(input|select)\s/g) || [];
  check('every settings label is attached to the control under it', settings && bare.length === 0,
    bare.slice(0, 3).map(s => s.replace(/\s+/g, ' ').slice(0, 70)).join(' / '));
  const ids = [...app.matchAll(/id="(set-label-[\w-]+)"/g)].map(m => m[1]);
  check('  and no two labels share an id', ids.length > 20 && new Set(ids).size === ids.length, `${ids.length} ids`);
}
check('the send button has a name when it is only an arrow',
  /className=\{`send-btn [^`]*`\}[\s\S]{0,200}aria-label=\{t\('composer\.send'\)\}/.test(app));
check('a toast can be closed by name, and is announced',
  /className="toast-stack" role="status" aria-live="polite"/.test(app)
  && /className="toast-close"[\s\S]{0,120}aria-label=\{t\('common\.close'\)\}/.test(app));
check('  and its close button is big enough to hit', /\.toast \.toast-close \{[^}]*min-width: 28px;[^}]*min-height: 28px;/.test(css));
check('the running-commands pill rides above Studio\'s footer, only while Studio shows',
  /html:has\(\.studio-place:not\(\[hidden\]\) \.studio-footer\) \.commands-dock \{ bottom:/.test(css));
check('  and steps out of the way of the palette and settings',
  /html:has\(\.cmd-overlay\[data-state='open'\]\) \.commands-dock,\s*html:has\(\.settings-overlay\[data-state='open'\]\) \.commands-dock \{ visibility: hidden; \}/.test(css));
check('small controls get a thumb-sized hit area on touch',
  /@media \(pointer: coarse\), \(max-width: 640px\) \{[\s\S]*?\.composer-model-trigger::after,\s*\.studio-describe::after \{[\s\S]*?inset: -8px -4px;[\s\S]*?\.settings-modal input\[type='range'\] \{ min-height: 32px; \}/.test(css));
check('icon-only buttons in settings are named',
  /className="pull-btn" onClick=\{handleDownload\}[^>]*aria-label=\{t\('models\.pull'\)\}/.test(app)
  // One copy button left (the origin); the Kakao redirect one went with Kakao sign-in.
  && (app.match(/copyToClipboard\(registerableOrigin\);[^\n]*\n\s*aria-label=\{t\('common\.copy'\)\}/g) || []).length === 1);

/* ------------------------------------------- roleplay place */
{
  const risu = read('src/RisuPanel.jsx');
  const risuCss = read('src/risuai.css');
  const embed = read('src/risuEmbed.css');
  check('roleplay: the frame is dressed in the WebUI look when it loads',
    /onLoad=\{dress\}/.test(risu) && /style\.id = 'webui-embed'/.test(risu));
  check('  and RisuAI\'s English welcome-only panel is hidden',
    /\.setting-area:has\(> div > h1\.text-xl \+ span\.text-xs\.text-textcolor2\) \{ display: none !important; \}/.test(embed));
  check('  sync is a status in the toolbar, not a row of its own',
    /<div className="risu-toolbar">[\s\S]*className=\{`risu-sync risu-sync-\$\{sync\.state\}`\} role="status"[\s\S]*?<\/div>\s*\{\(modelError/.test(risu));
  check('  the loading cover lifts on load, not on the terms dialog',
    /\{!loaded && <div className="risu-loading"/.test(risu));
  check('  the first toolbar button is still the import (tests wait on it)',
    /<div className="risu-toolbar">(?:(?!<button)[\s\S])*<button className="risu-import"/.test(risu));
  check('  icon-only toolbar buttons keep a name',
    /aria-label="캐릭터 패널"/.test(risu) && /aria-label="설정 · 프리셋"/.test(risu));
  check('  the phone sync line never wraps (wrapping fed a resize loop)',
    !/\.risu-sync > span \{[^}]*white-space: normal/.test(risuCss));
}

/* ------------------------------------------- running-commands dock, third pass */
{
  const dockJs = read('src/AgentActivity.jsx');
  const live = read('server/liveCommands.js');
  check('dock: a command whose process died is dropped, not kept as "lost" for hours',
    // A pid-less entry is judged by the workbench that spooled it (`owner`).
    /entry\.status === 'running' && !alive\(entry\.pid(?: \|\| owner)?\)\) \{\s*fs\.rm\(file/.test(live));
  check('  the list never scrolls sideways',
    /\.commands-dock-list \{\s*grid-template-columns: minmax\(0, 1fr\);\s*overflow-x: hidden;/.test(css));
  check('  it stays out of the code panel and the sidebar',
    /html:has\(\.claude-app\.has-artifact\) \.commands-dock \{ --dock-right: calc\(var\(--artifact-width/.test(css)
    && /width: min\(560px, calc\(100vw - var\(--dock-left\) - var\(--dock-right\)\)\)/.test(css));
  check('  and rides above whatever bottom bar is under it',
    /\.input-container, \.input-footer, \.studio-place:not\(\[hidden\]\) \.studio-footer/.test(dockJs));
  check('the composer footer stays one line on a desktop, code panel or not',
    /@media \(min-width: 861px\) \{\s*\.input-footer \{ flex-wrap: nowrap; \}[\s\S]*?text-overflow: ellipsis;/.test(css));
}

check('code panel: the version picker shrinks instead of running under the buttons',
  /\.artifact-version-select \{\s*flex: 0 1 auto;\s*min-width: 0;/.test(css)
  && /\.artifact-header-actions \{ flex: 0 0 auto; \}/.test(css));
check('a change card\'s +/− counts never break across lines',
  /\.file-change-add,\s*\.file-change-del \{ flex: 0 0 auto; white-space: nowrap; \}/.test(css));

/* ------------------------------------------- fourth pass */
check('palette: no hard-coded English labels',
  !/'Pin this chat'|Web Fetch \(MCP\): turn|cycle auto\/on\/off|Density: switch to/.test(app));
check('  section headings are translated and each appears once',
  /sectionNames\[item\.section\]/.test(app) && /order\.flatMap\(section => groups\.get\(section\)\)/.test(app)
  && everywhere('palette.secActions') && everywhere('palette.secJump'));
check('  the running pill (spinner included) is gone while it is open',
  /html:has\(\.cmd-overlay\) \.commands-dock,\s*html:has\(\.settings-overlay\) \.commands-dock \{ display: none; \}/.test(css));
check('starter cards: icons match what they do',
  /labelKey: 'empty\.summarize', Icon: Globe/.test(app) && /labelKey: 'empty\.webApp', Icon: Monitor/.test(app));
check('toasts keep Korean words whole', /\.toast > span \{[^}]*word-break: keep-all;/.test(css));
check('the new-folder button is big enough to hit', /\.folder-add \{\s*min-width: 28px;\s*min-height: 28px;/.test(css));

check('a streaming answer shows live elapsed time and output tokens',
  /function LiveWorkStatus\(/.test(app) && /<LiveWorkStatus\s/.test(app) && /\.live-work-status \{/.test(css));
check('  under the answer, inside its column, not beside it',
  // The props now include a startedAt lookup, so the element runs longer.
  /<LiveWorkStatus[\s\S]{0,1200}?\/>\s*\)\}\s*<\/div>\s*\{\/\* An answer's time/.test(app));

check('the composer placeholder does not repeat the raw model tag',
  /placeholder=\{t\('composer\.placeholderShort'\)\}/.test(app) && !/t\('composer\.placeholder', \{ model:/.test(app));

/* ----------------------------------------------------------- the answer */

check('short Python stays in the answer', /if \(previewable \|\| isLong\) \{/.test(app) && !/previewable \|\| runnable \|\| isLong/.test(app));
check('  and the card’s labels are translated',
  /t\('attach\.lines', \{ count: lineCount \}\)/.test(app) && /\{t\('artifact\.run'\)\}/.test(app));

/* --------------------------------------------------------------- notices */

check('on a desktop, notices start above the composer', /\.toast-stack \{ bottom: calc\(var\(--composer-h, 0px\) \+ 0\.75rem\); \}/.test(css)
  && /ref=\{measureComposer\}/.test(app));
check('on a phone, an open dialog or drawer sends them to the bottom',
  /html:has\(\.settings-overlay\[data-state='open'\]\) \.toast-stack,\s*\n\s*html:has\(\.claude-sidebar\.open\) \.toast-stack \{\s*top: auto;/.test(css));

/* ------------------------------------------------------------------ studio */

check('the studio shows the model notes in the reader’s language', /\{noteFor\(model\)\}/.test(read('src/StudioPanel.jsx')));

// The "running" pill listed every command of the last three minutes, finished
// and failed ones included, under a heading that says "running".
{
  const dock = read('src/AgentActivity.jsx').split('export const CommandsDock')[1] || '';
  check('the running pill lists only running commands', /\{running\.map\(c => <LiveCommand/.test(dock) && !/\{commands\.filter\([^)]*\)\.map\(c => <LiveCommand/.test(dock));
  check('... and closes when the last one ends', /else if \(open && hadRunning\.current\)[^\n]*setOpen\(false\)/.test(dock));
}

// An answer being written on another device looked finished on this one: no
// typing dots, no caret, no clock or token count. The answering row now asks
// whether an answer is arriving in this chat from anywhere.
{
  const app = read('src/App.jsx');
  check('one flag for "an answer is arriving here", local or followed',
    /const answerLiveHere = isThisChatGenerating \|\| \(!isGenerating && !!remoteAnswer\);/.test(app));
  check('... the streaming row, the clock and the CLI clock use it',
    /const streamingNow = answerLiveHere && /.test(app)
    && /msg\.role === 'assistant' && answerLiveHere && i \+ group\.length - 1 >= messages\.length - 1 && \(\s*<LiveWorkStatus/.test(app)
    && /live=\{lastGroup && answerLiveHere\}/.test(app));
  check('... a followed answer is timed from when the server started it',
    /if \(!isThisChatGenerating\) return remoteAnswer\?\.startedAt;/.test(app)
    && /Date\.now\(\) - Math\.max\(0, serverNow - began\)/.test(app)
    && /now: Date\.now\(\)/.test(read('server/api.js')));
  check('... and is never laid over the previous answer',
    /index < asked\)[\s\S]{0,500}askedCount\(stored\) > \(followed\.asked \?\? Infinity\)\) return stored;[\s\S]{0,120}followedOnly: true/.test(app));
  check('the next stream of a turn is looked for at once', /if \(!stopped\) setTimeout\(\(\) => \{ look\(\); \}, 250\);/.test(app));

  // The message box: its height follows its text and its width, not only typing.
  check('the box is refitted whenever its text changes', /useLayoutEffect\(\(\) => \{ fitComposer\(\); \}, \[input, fitComposer\]\);/.test(app));
  check('... and whenever its width does', /ref=\{composerRef\}/.test(app) && /const composerRef = useCallback\(\(box\) => \{[\s\S]{0,600}new ResizeObserver/.test(app));

  // Opening the code panel kept the scroll offset and lost the place.
  check('the place in the conversation is noted as the reader scrolls', /queueViewAnchor\(\);/.test(app));
  check('... and put back when the width changes', /ref=\{scrollAreaNodeRef\}/.test(app)
    && /const scrollAreaNodeRef = useCallback\(\(area\) => \{[\s\S]{0,700}keepViewAnchor\(\)/.test(app));
}

// Layer order: the command pill sat above the image viewer, and the reply
// bubbles over the opened in-chat search.
{
  const z = (n) => Number((read('src/index.css').match(new RegExp(`--z-${n}:\\s*(\\d+)`)) || [])[1]);
  check('the command pill is under dialogs and the image viewer', z('dock') < z('modal') && z('dock') > z('panel'));
  const extras = read('src/extras.css');
  check('the header stacks above the conversation', /\.main-header \{ position: relative; z-index: var\(--z-sticky\); \}/.test(extras));
  check('... and the opened search floats above it', /\.header-search\.is-open \{\s*position: absolute;[\s\S]{0,200}z-index: var\(--z-dropdown\)/.test(extras));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
