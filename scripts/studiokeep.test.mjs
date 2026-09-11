// Four things that were losing work, and one that was hiding a feature.
//
// Every one of them looked like the app doing nothing: a click on a chat that
// left the Studio on top of it, a generation that vanished when you looked
// away, a prompt written on a phone that never reached the desktop, and a
// request for a picture answered with a paragraph about the picture. None of
// them threw, and none of them were visible from the code alone — which is why
// each check below is written against the specific thing that was wrong.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');

/* ============================================ opening a chat leaves the Studio

   The Studio is laid over the conversation rather than replacing it, which is
   what keeps a half-written message and a streaming reply intact. The cost was
   that choosing a chat changed what was underneath and left the Studio on top,
   so the click appeared to do nothing at all. */

check('there is one way to open a chat', /const openChat = \(id\) => \{/.test(app));
check('and it leaves the Studio', /const openChat[\s\S]{0,300}setSidebarPlace\('home'\)/.test(app));

// All four places a person can choose a chat from.
check('the chat list uses it', /if \(selectMode\)[\s\S]{0,300}openChat\(s\.id\)/.test(app));
check('so does a new chat', /openChat\(newSession\.id\)/.test(app));
check('so does the command palette', /action: \(\) => openChat\(s\.id\)/.test(app));
check('and so does the "still generating over there" button',
  /openChat\(generatingSessionId\)/.test(app));

/* The send queue switches chats in the background when it retries a message.
   Being thrown out of the Studio mid-prompt by a retry is worse than the bug
   this fixes, so that one path deliberately does not use the helper. */
check('but a background retry does not move the reader',
  /setSendQueue\(noteAttempt[\s\S]{0,400}setCurrentSessionId\(session\.id\)/.test(app));

/* ================================ a generation survives looking away

   Unmounting the panel took the gallery with it: ComfyUI kept making the
   picture, but the card tracking it was gone, its poller was cleared and its
   progress stream was closed. */

check('the panel is hidden rather than removed',
  /\{studioOpened && \([\s\S]{0,400}hidden=\{sidebarPlace !== 'studio'\}/.test(app));
/* Still lazy: an install whose owner never makes a picture should never mount
   the panel and never ask ComfyUI anything. */
check('and is not mounted until the Studio is opened',
  /const \[studioOpened, setStudioOpened\] = useState\(false\)/.test(app));
check('by any of the ways in', (app.match(/setStudioOpened\(true\)/g) || []).length >= 3);

/* ---- and across a reload ---- */

check('a running job is written down, not only a finished one',
  /job\.state === 'done' \|\| isPending\(job\)/.test(panel));
// A `pending-` id names nothing in ComfyUI: it is the local placeholder from
// before the queue accepted the job.
check('but not one ComfyUI has never seen',
  /!String\(job\.id\)\.startsWith\('pending-'\)/.test(panel));
check('a restored job is marked as restored', /restored: true/.test(panel));
check('and is picked up again on load', /if \(pollers\.current\.has\(id\)\) continue;\s*poll\(id\)/.test(panel));

/* `unknown` means ComfyUI has never heard of this prompt. For a job queued a
   moment ago that is a race the next poll settles; for one restored from a
   previous page load it is the answer — and without telling them apart the
   card polls a dead id for ever, showing "generating" for a picture nobody is
   making. */
check('a restored job that ComfyUI has forgotten gives up',
  /data\.state === 'unknown' && job\.restored[\s\S]{0,120}state: 'failed'/.test(panel));
check('rather than polling a dead id for ever', /if \(lost \|\| data\.state === 'done'/.test(panel));

// A job still "running" since yesterday is a job that is lying.
check('and a stale one is not restored at all', /RESUME_WINDOW_MS/.test(panel));

/* ============================================ the same prompts on both devices

   Written on a phone, they stayed on that phone: `studioSettings` and
   `studioHistory` were in localStorage and nothing collected them. */

const sync = fs.readFileSync(path.join(ROOT, 'src/syncEngine.js'), 'utf8');
check('the saved form is a synced record', /studio: `studioSettings:\$\{scope\}`/.test(sync));
check('and so is the gallery', /studioJobs: `studioHistory:\$\{scope\}`/.test(sync));
/* Listed once because the collect and apply sides have to agree — a kind added
   to one and forgotten in the other uploads and never comes back down. */
check('both are in the list both sides read',
  /WHOLE_LISTS = \[[^\]]*'studio', 'studioJobs'\]/.test(sync));

const settings = fs.readFileSync(path.join(ROOT, 'src/studioSettings.js'), 'utf8');
/* Unstamped, a record uploads as `updatedAt: 0` — older than everything — and
   is immediately replaced by whatever the account already had. That is exactly
   how the user profile behaved before it was stamped. */
check('a write is timestamped', /stampSetting\(scope, storeKey\(scope\)\)/.test(settings));
check('and so is the gallery\'s', /stampSetting\(scope, key\)/.test(panel));

const store = fs.readFileSync(path.join(ROOT, 'src/settingsStore.js'), 'utf8');
/* Both carry their own `:scope` suffix and are synced as records of their own,
   so the settings sweep must not also pick them up as bare settings. */
check('neither is swept up as a plain setting',
  /'studioSettings', 'studioHistory'/.test(store));

/* ====================================== asking for a picture gets a picture

   Drawing was behind the same switch as fetching web pages and reading files,
   and the tag-path instructions — the ones a model without structured tool
   calls reads — never mentioned it at all. Asked to draw, such a model did the
   only thing it had been told it could do and wrote the picture out in prose. */

const tools = fs.readFileSync(path.join(ROOT, 'src/tools.js'), 'utf8');
check('drawing is named as needing no permission',
  /DRAWING_TOOLS = new Set\(\[\s*'generate_image', 'generate_video', 'remove_background', 'upscale_image', 'extend_image',\s*\]\)/.test(tools));
check('and the schemas can be narrowed to it', /export const schemasFor/.test(tools));

const T = await import(pathToFileURL(path.join(ROOT, 'src/tools.js')).href);
const drawingOnly = T.schemasFor({ web: false }).map(t => t.function.name);
/* Drawing, and the three things done to a picture already drawn -- none of
   them reaches the network or the disk. */
eq('with the switch off, the picture tools are offered', drawingOnly.length, 5);
check('and they are the drawing ones', drawingOnly.every(n => T.DRAWING_TOOLS.has(n)), drawingOnly.join(','));
check('with it on, everything is', T.schemasFor({ web: true }).length === T.TOOL_SCHEMAS.length);
// Nothing that reaches the network or the disk may come through without it.
check('and no web or file tool leaks through',
  !drawingOnly.some(n => ['web_search', 'fetch_url', 'read_file', 'write_file', 'list_dir'].includes(n)));

check('a model that can call tools is always given them',
  /const useNativeTools = modelSupportsTools\(activeModel\);/.test(app));
check('and is sent only what is armed', /tools: schemasFor\(\{ web: mcpEnabled,/.test(app));

/* The bug itself: the tag syntax was documented for web, filesystem and
   environment tools and not for these two. */
check('the tag path is told how to draw', /TOOL_GENERATE_IMAGE style="photo\|anime"/.test(app));
check('and told that describing it is not an answer',
  /Do not describe the picture in words instead/.test(app));
check('which it is told even with the switch off',
  /if \(!mcpEnabled && !useNativeTools[\s\S]{0,400}\$\{drawPrompt\}/.test(app));

/* And the executor has to be able to run them. The registry was built inside
   `if (mcpEnabled)`, so with the switch off the tag matched nothing even if
   the model wrote one. */
check('the registry exists whatever the switch says',
  !/if \(mcpEnabled\) \{\s*const TOOLS = \[/.test(app));
check('and is filtered rather than skipped',
  /TOOLS\.filter\(tool => \(mcpEnabled \|\| DRAWING_TAGS\.has\(tool\.name\)\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
