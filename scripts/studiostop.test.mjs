// Queueing once, and stopping for real.
//
// Both of these failed in a way that only showed up on a GPU. One press put two
// prompts in ComfyUI's queue with the same seed, and pressing stop killed the
// running one — whereupon ComfyUI immediately started the other, so the fans
// stayed up, a picture kept being drawn, and from the outside the cancel had
// simply done nothing.
//
// Neither is visible from the browser: the queue is ComfyUI's, and the only
// evidence is which HTTP calls were made and in what order. So that is what is
// checked here, against a ComfyUI made of paper.
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const S = await import(pathToFileURL(path.join(ROOT, 'server/studio.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const routes = S.createStudioRoutes({});
const handlerFor = (p) => routes.find(r => r.path === p).handler;

/** A request with a JSON body, and a response that remembers what it was told. */
const call = async (p, body) => {
  const req = Readable.from([JSON.stringify(body)]);
  req.url = p;
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  let payload = null;
  let status = 200;
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) { payload = JSON.parse(text); status = this.statusCode; },
  };
  await handlerFor(p)(req, res);
  return { payload, status };
};

/**
 * A ComfyUI of paper.
 *
 * `queue` is what /queue answers with, and it is a function so a test can have
 * the queue change between one look and the next — which is the whole point of
 * the wait: `/interrupt` returns before the sampler has noticed it.
 */
const realFetch = globalThis.fetch;
const GIB = 1024 ** 3;
const fakeComfy = ({ queues = [{ running: [], pending: [] }], prompts = [], freesToRelease = 1 } = {}) => {
  const calls = [];
  let look = 0;
  // What the card holds, and how many `/free` calls it takes to let go --
  // because the first one after an interrupt really does nothing.
  let held = 6 * GIB;
  let frees = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path_ = String(url).replace('http://127.0.0.1:8188', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: path_, method: options.method || 'GET', body });
    const json = (value) => ({ ok: true, status: 200, json: async () => value, headers: new Map() });
    if (path_ === '/queue' && (options.method || 'GET') === 'GET') {
      const at = queues[Math.min(look++, queues.length - 1)];
      return json({
        queue_running: at.running.map(id => [0, id, {}, {}, []]),
        queue_pending: at.pending.map((id, n) => [n + 1, id, {}, {}, []]),
      });
    }
    if (path_ === '/prompt') { prompts.push(body); return json({ prompt_id: `p-${prompts.length}` }); }
    if (path_ === '/free') {
      frees += 1;
      if (frees >= freesToRelease) held = 1 * GIB;
      return json({});
    }
    if (path_ === '/system_stats') {
      return json({ devices: [{ vram_total: 16 * GIB, vram_free: 16 * GIB - held }] });
    }
    if (path_.startsWith('/object_info')) return json({});
    return json({});
  };
  return { calls, prompts };
};
const paths = (calls, method = 'POST') => calls.filter(c => c.method === method).map(c => c.path);

/* --------------------------------------------------------- stopping one */

{
  // Waiting its turn. Interrupting here would kill the job in front of it and
  // leave this one to start straight afterwards -- the exact opposite of stop.
  const { calls } = fakeComfy({ queues: [
    { running: ['other'], pending: ['mine'] },
    { running: ['other'], pending: [] },
  ] });
  const { payload } = await call('/studio/cancel', { id: 'mine' });
  eq('a queued job is taken out of the queue',
    calls.filter(c => c.path === '/queue' && c.method === 'POST').map(c => c.body), [{ delete: ['mine'] }]);
  check('and nothing running is interrupted', !paths(calls).includes('/interrupt'));
  check('it reports that it stopped', payload.stopped === true);
  check('the models stay loaded while another job is running', !paths(calls).includes('/free'),
    JSON.stringify(paths(calls)));
  eq('and it says what is left', payload.remaining, 1);
}

{
  // Running. This is the only case where interrupting is the right thing.
  const { calls } = fakeComfy({ queues: [
    { running: ['mine'], pending: [] },
    { running: [], pending: [] },
  ] });
  const { payload } = await call('/studio/cancel', { id: 'mine' });
  check('a running job is interrupted', paths(calls).includes('/interrupt'));
  check('and not deleted from a queue it is not in',
    !calls.some(c => c.path === '/queue' && c.method === 'POST'));
  check('with nothing left, the models come out of VRAM', paths(calls).includes('/free'));
  eq('unloading is what was asked for',
    calls.find(c => c.path === '/free')?.body, { unload_models: true, free_memory: true });
  check('and it says so', payload.freed === true && payload.remaining === 0);
}

{
  /* The wait. `/interrupt` returns when the flag is set, not when the sampler
     has read it, so a cancel that looked once would report failure on a job it
     had just stopped. */
  const { calls } = fakeComfy({ queues: [
    { running: ['mine'], pending: [] },
    { running: ['mine'], pending: [] },
    { running: ['mine'], pending: [] },
    { running: [], pending: [] },
  ] });
  const { payload } = await call('/studio/cancel', { id: 'mine' });
  check('it waits for the queue to agree rather than reporting straight away',
    payload.stopped === true && calls.filter(c => c.path === '/queue' && c.method === 'GET').length >= 4);
}

{
  // Gone already: finished between the press and the request.
  const { calls } = fakeComfy({ queues: [{ running: [], pending: [] }] });
  const { payload } = await call('/studio/cancel', { id: 'mine' });
  check('stopping a job that has already finished interrupts nothing',
    !paths(calls).includes('/interrupt'), JSON.stringify(paths(calls)));
  check('and is not an error', payload.success === true && payload.stopped === true);
}

/* --------------------------------------------------------- stopping all */

{
  const { calls } = fakeComfy({ queues: [
    { running: ['one'], pending: ['two', 'three'] },
    { running: [], pending: [] },
  ] });
  const { payload } = await call('/studio/cancel', { all: true });
  const posts = paths(calls);
  /* The order is the whole fix: interrupt first and ComfyUI hands the GPU
     straight to the next prompt in the queue. */
  eq('the queue is cleared before the running job is stopped',
    posts.slice(0, 2), ['/queue', '/interrupt']);
  eq('cleared, not picked over', calls.find(c => c.path === '/queue' && c.method === 'POST').body, { clear: true });
  check('and then the models are unloaded', posts.includes('/free'));
  check('with nothing left behind', payload.remaining === 0 && payload.stopped === true);
}

{
  // Asked not to unload -- for a caller that means to queue something else.
  const { calls } = fakeComfy({ queues: [{ running: ['one'], pending: [] }, { running: [], pending: [] }] });
  await call('/studio/cancel', { all: true, unload: false });
  check('unloading can be declined', !paths(calls).includes('/free'));
}

/* ------------------------------------------------------ letting go of it

   The prompt leaves the running list the moment it is interrupted, but the
   worker is still unwinding it — and on its way out it registers the model it
   was using as the loaded one again. A `/free` that lands in that window
   answers cheerfully and frees nothing. Measured on this machine: VRAM sat at
   6.21GB through ten seconds of checking, and fell to 1.33GB the instant a
   second `/free` was sent. */

{
  const { calls } = fakeComfy({
    queues: [{ running: ['mine'], pending: [] }, { running: [], pending: [] }],
    freesToRelease: 2,
  });
  const { payload } = await call('/studio/cancel', { id: 'mine' });
  const frees = paths(calls).filter(p => p === '/free').length;
  check('a free that did not free is asked again', frees >= 2, `${frees} attempts`);
  check('and the GPU is asked what it actually holds',
    calls.some(c => c.path === '/system_stats'));
  check('it reports the models as unloaded', payload.freed === true);
}

{
  // When it lets go the first time, it is not asked twice.
  const { calls } = fakeComfy({
    queues: [{ running: ['mine'], pending: [] }, { running: [], pending: [] }],
    freesToRelease: 1,
  });
  await call('/studio/cancel', { id: 'mine' });
  eq('once is enough when once worked', paths(calls).filter(p => p === '/free').length, 1);
}

{
  /* Nothing was interrupted -- a job that was only ever waiting, or one that
     had already finished -- so there is no teardown to race and no reason to
     measure. */
  const { calls } = fakeComfy({
    queues: [{ running: [], pending: ['mine'] }, { running: [], pending: [] }],
    freesToRelease: 9,
  });
  await call('/studio/cancel', { id: 'mine' });
  eq('with nothing interrupted, it is asked once', paths(calls).filter(p => p === '/free').length, 1);
  check('and the GPU is not measured for nothing', !calls.some(c => c.path === '/system_stats'));
}

/* ------------------------------------------------------- queueing once */

{
  /* A browser re-sends a POST by itself when the connection it reused had
     already been closed, and it does that after the server has read the first
     one. One press, two pictures, two minutes of GPU each. */
  const body = {
    model: 'krea2-turbo', prompt: '1girl, library', size: '1024x1360', steps: 8, cfg: 1,
    requestId: 'press-1',
  };
  const { prompts, calls } = fakeComfy();
  const first = await call('/studio/generate', body);
  const second = await call('/studio/generate', body);
  eq('the same request queues one prompt, not two', prompts.length, 1);
  eq('and the repeat is told about the job that exists', second.payload.id, first.payload.id);
  eq('with the same seed, so the card does not change under it', second.payload.seed, first.payload.seed);
  check('the repeat is named as one', second.payload.repeated === true);
  eq('only one graph was posted', paths(calls).filter(p => p === '/prompt').length, 1);

  // A second press is a second picture, and must not be mistaken for a retry.
  const third = await call('/studio/generate', { ...body, requestId: 'press-2' });
  eq('a genuinely new request queues again', prompts.length, 2);
  check('and gets its own id', third.payload.id !== first.payload.id);
  check('and its own seed', third.payload.seed !== first.payload.seed);
}

globalThis.fetch = realFetch;

/* ------------------------------------------------------------ the wiring */

const fs = await import('node:fs');
const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
check('the button will not fire twice while the first is going out',
  /if \(submitting\.current\) return;/.test(panel) && /disabled=\{!canGenerate \|\| queueing\}/.test(panel));
check('every submission names itself', /requestId: `\$\{pendingId\}/.test(panel));
check('and there is a way to stop everything at once', /askToStop\(\{ all: true \}\)/.test(panel));

/* The other half of the app draws pictures too, and its Stop used to stop only
   the watching: the prompt stayed in ComfyUI's queue and the GPU carried on for
   another two minutes on a picture nobody would see. */
const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
check('a conversation that stops drawing tells ComfyUI so',
  /const stopDrawing = \(id\) => \{[\s\S]{0,300}'\/studio\/cancel'/.test(app));
// The film, and every picture job through the one watcher they now share.
check('for the picture and the film alike',
  /if \(!output\) stopDrawing\(queued\.id\);/.test(app) && /if \(!finished\) stopDrawing\(id\);/.test(app));
check('and not with the signal that was just aborted',
  !/stopDrawing[\s\S]{0,400}signal/.test(app.slice(app.indexOf('const stopDrawing'), app.indexOf('const stopDrawing') + 400)));
check('offered while anything is still running', /\{busy && \([\s\S]{0,200}stopEverything/.test(panel));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8');
eq('every language names "studio.stopAll"', i18n.split("'studio.stopAll':").length - 1, 12);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
