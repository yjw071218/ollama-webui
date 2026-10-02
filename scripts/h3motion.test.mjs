// A long clip, and a clip that loops.
//
// Both are built by rewriting the video workflow's graph, and neither can be
// checked by looking at the result: a seam that stutters, a chain that drifts
// and a graph that quietly hangs all look like "the model did that". So the
// graph itself is checked here -- against the real workflow file, converted by
// the real converter, with a recorded /object_info so it runs with ComfyUI shut.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const M = await load('server/h3Motion.js');
const W = await load('server/workflows.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* The graph, as the Studio would send it.
 *
 * `/object_info` is recorded rather than fetched: the conversion needs widget
 * order, which lives only there, and a test that only runs while ComfyUI is up
 * is a test nobody runs. */
const INFO_FILE = path.join(HERE, 'fixtures', 'object-info-minimax.json');
const info = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
const build = () => W.buildPrompt(W.WORKFLOWS['minimax-h3'], info).prompt;
const available = new Set([...Object.keys(info), M.HYBRID_NODE]);

/* Nothing may read its own output, however far around the loop. ComfyUI's
   answer to a cycle is to stop, having said nothing about why -- and the first
   version of the chain built one, by rewiring the joins it had just made. */
const cycles = (graph) => {
  const state = new Map();
  const walk = (id, trail) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...trail, id].join(' -> ');
    state.set(id, 'open');
    for (const value of Object.values(graph[id]?.inputs || {})) {
      if (!Array.isArray(value) || !graph[value[0]]) continue;
      const found = walk(String(value[0]), [...trail, id]);
      if (found) return found;
    }
    state.set(id, 'done');
    return null;
  };
  for (const id of Object.keys(graph)) {
    const found = walk(id, []);
    if (found) return found;
  }
  return null;
};

/** Every link in the graph points at a node that exists. */
const danglingLinks = (graph) => Object.entries(graph).flatMap(([id, node]) =>
  Object.entries(node.inputs || {})
    .filter(([, v]) => Array.isArray(v) && !graph[v[0]])
    .map(([name, v]) => `${id}.${name} -> ${v[0]}`));

/* Every required input of every node, present.
 *
 * ComfyUI refuses a whole prompt for one missing required input, and this is
 * where they go missing: the conditioning node is *converted* from the stock
 * one, so an input the hybrid node has and the stock one does not simply is not
 * there. `also_ref_first_frame` is exactly that -- declared with a default,
 * which makes it a widget in the editor and a required input over the API:
 *
 *   node_errors: {"1":{"errors":[{"type":"required_input_missing",
 *     "details":"also_ref_first_frame"}]}}
 *
 * Caught by submitting the graph, which is a good place to catch it and a slow
 * one to find out. Here instead. */
/* Only the nodes the saved video actually depends on -- which is the same rule
   ComfyUI validates by. This workflow carries a disconnected branch (an
   upscaler wired through Get/Set nodes that do not resolve over the API), and
   it has always been harmless because nothing asks it for anything. */
const feeding = (graph, outputId) => {
  const seen = new Set();
  const walk = (id) => {
    if (!graph[id] || seen.has(id)) return;
    seen.add(id);
    for (const value of Object.values(graph[id].inputs || {})) {
      if (Array.isArray(value)) walk(String(value[0]));
    }
  };
  walk(outputId);
  return seen;
};

const missingInputs = (graph) => {
  const saved = Object.keys(graph).find(id => graph[id].class_type === 'SaveVideo');
  const needed = feeding(graph, saved);
  return Object.entries(graph).filter(([id]) => needed.has(id)).flatMap(([id, node]) => {
  const schema = info[node.class_type]?.input?.required;
  if (!schema) return [];
  return Object.keys(schema)
    .filter(name => node.inputs[name] === undefined
      // Autogrow inputs arrive as `ref_images.ref_image_0`, one key per entry.
      && !Object.keys(node.inputs).some(k => k.startsWith(`${name}.`)))
    .map(name => `${id} (${node.class_type}).${name}`);
  });
};

/* ============================================================== the plan

   Five to fifteen seconds is the range H3 was trained on; its own tooltip says
   so. Everything longer is segments. */

eq('a short clip is one pass', M.segmentPlan(5).count, 1);
eq('  and so is one at the top of the range', M.segmentPlan(10).count, 1);
eq('a minute is six ten-second segments', M.segmentPlan(60), { count: 6, seconds: 10, total: 60 });
/* Equal segments: they share one length node, and a two-second tail after four
   ten-second ones is a change of pace anybody can see at the join. */
eq('twenty-five seconds is three equal ones, not two and a stub',
  M.segmentPlan(25), { count: 3, seconds: 8.33, total: 25 });
eq('a segment length is held to what the model can do', M.segmentPlan(60, 40).count, 4);
eq('  at both ends', M.segmentPlan(60, 1).count, 12);

/* ================================================================ a loop */

{
  const graph = build();
  const out = M.applyH3Loop(graph, { available });
  check('a loop applies', out.applied, JSON.stringify(out));

  const { cond, decode } = M.findH3Nodes(graph);
  const node = graph[cond];
  eq('  through the hybrid node', node.class_type, M.HYBRID_NODE);
  check('  pinned at both ends', !!node.inputs.first_frame && !!node.inputs.last_frame);
  eq('  to the same picture', node.inputs.first_frame, node.inputs.last_frame);

  /* Both pins have to be the same *pixels*. The node stretches the first frame
     to size and centre-crops the last, so a picture a few pixels off the clip's
     aspect is pinned to two slightly different images -- a flinch at the seam
     that is very hard to see and impossible to un-see. */
  const scale = graph[node.inputs.first_frame[0]];
  eq('  scaled to the clip first', scale.class_type, 'ImageScale');
  eq('  cropped rather than stretched', scale.inputs.crop, 'center');
  eq('  to the size being rendered', [scale.inputs.width, scale.inputs.height],
    [node.inputs.width, node.inputs.height]);

  /* Frame 0 and the last frame are the same picture by construction, so a
     player looping the file shows it twice -- one stutter per lap. */
  const trim = Object.values(graph).find(n => n.class_type === 'ImageFromBatch' && n.inputs.batch_index === 1);
  check('the repeated frame is dropped', !!trim);
  eq('  from the decoded clip', trim.inputs.image, [decode, 0]);
  check('  and what used to read the decode now reads the trim',
    Object.entries(graph).some(([id, n]) => id !== Object.keys(graph).find(k => graph[k] === trim)
      && Object.values(n.inputs || {}).some(v => Array.isArray(v) && graph[v[0]] === trim)));

  check('the graph has no cycle in it', cycles(graph) === null, String(cycles(graph)));
  eq('and no link points at nothing', danglingLinks(graph), []);
  eq('and every node has what it requires', missingInputs(graph), []);
}

/* A loop is pinned to a picture; without one there is nothing to pin. Reported
   before the GPU is spent rather than after. */
{
  const graph = build();
  const { cond } = M.findH3Nodes(graph);
  delete graph[cond].inputs['ref_images.ref_image_0'];
  eq('a loop with no picture says so', M.applyH3Loop(graph, { available }).reason, 'noReference');
}

eq('and so does one without the node pack installed',
  M.applyH3Loop(build(), { available: new Set(['VAEDecode']) }).missing, [M.HYBRID_NODE]);

/* =============================================================== a chain */

{
  const graph = build();
  const out = M.applyH3Chain(graph, { segments: 3, prompts: ['one', 'two', 'three'], available });
  check('a chain applies', out.applied, JSON.stringify(out));
  eq('  with a segment per plan', out.segments, 3);

  const conds = Object.entries(graph).filter(([, n]) => n.class_type === M.HYBRID_NODE);
  eq('one conditioning node per segment', conds.length, 3);
  eq('  each with its own part of the timeline', conds.map(([, n]) => n.inputs.prompt), ['one', 'two', 'three']);

  /* The whole point: segment N starts on the last frame segment N-1 actually
     produced. Not the reference picture -- that would restart the shot -- and
     not nothing, which is what the stock nodes leave you with. */
  const opens = conds.slice(1).map(([, n]) => graph[n.inputs.first_frame[0]]);
  check('every segment after the first opens on a real frame',
    opens.every(n => n.class_type === 'ImageFromBatch' && n.inputs.batch_index === -1 && n.inputs.length === 1),
    JSON.stringify(opens.map(n => n.inputs)));
  check('  taken from the segment before it',
    opens.every(n => graph[n.inputs.image[0]].class_type === 'VAEDecode'));

  // And the character still comes from the reference, in every segment.
  check('every segment keeps the reference picture',
    conds.every(([, n]) => Array.isArray(n.inputs['ref_images.ref_image_0'])));

  /* Same seed, same prompt, near-identical opening frame: the same motion
     again. Each segment gets its own. */
  const noises = Object.values(graph).filter(n => n.class_type === 'RandomNoise');
  eq('a seed per segment', noises.length, 3);
  const offsets = Object.values(graph)
    .filter(n => n.class_type === 'ComfyMathExpression' && /^a \+ \d+$/.test(n.inputs.expression))
    .map(n => n.inputs.expression);
  eq('  offset from the one that was asked for', offsets, ['a + 1', 'a + 2']);

  const joins = Object.values(graph).filter(n => n.class_type === 'ImageBatch');
  eq('the segments are joined into one clip', joins.length, 2);
  const sound = Object.values(graph).filter(n => n.class_type === 'AudioConcat');
  eq('  and so is the sound', sound.length, 2);
  /* One frame is 1/24s and nobody hears it. Six segments is a quarter of a
     second of drift between what is said and the mouth saying it. */
  const trims = Object.values(graph).filter(n => n.class_type === 'TrimAudioDuration');
  eq('the sound is shortened by the frame that was dropped', trims.length, 2);
  check('  by exactly one frame', trims.every(n => Math.abs(n.inputs.start_index - 1 / 24) < 1e-9));

  check('the graph has no cycle in it', cycles(graph) === null, String(cycles(graph)));
  eq('and no link points at nothing', danglingLinks(graph), []);
  eq('and every node has what it requires', missingInputs(graph), []);

  // What was reading the first segment now reads the whole thing.
  check('the saved video is the joined one', out.rewired.video > 0 && out.rewired.audio > 0,
    JSON.stringify(out.rewired));
}

/* A long clip that also loops: the last segment closes back on the opening
   picture, which is a two-minute idle rather than a five-second one. */
{
  const graph = build();
  const out = M.applyH3Chain(graph, { segments: 2, loop: true, available });
  eq('a long loop is both', out.kind, 'chain+loop');
  const conds = Object.entries(graph).filter(([, n]) => n.class_type === M.HYBRID_NODE);
  check('the first segment opens on the picture',
    graph[conds[0][1].inputs.first_frame[0]].class_type === 'ImageScale');
  check('  and the last closes on the same one',
    JSON.stringify(conds[1][1].inputs.last_frame) === JSON.stringify(conds[0][1].inputs.first_frame));
  check('no cycle', cycles(graph) === null, String(cycles(graph)));
  eq('no dangling link', danglingLinks(graph), []);
  eq('every node has what it requires', missingInputs(graph), []);
}

/* ============================================================ the entry */

{
  const graph = build();
  const out = M.applyH3Motion(graph, { seconds: 30, segmentSeconds: 10, available });
  eq('thirty seconds is three segments', out.plan.count, 3);
  eq('  and it is a chain', out.kind, 'chain');
  eq('five seconds and no loop is nothing to do',
    M.applyH3Motion(build(), { seconds: 5, available }).reason, 'nothingToDo');
  eq('five seconds and a loop is a loop',
    M.applyH3Motion(build(), { seconds: 5, loop: true, available }).kind, 'loop');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
