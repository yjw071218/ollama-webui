// A ComfyUI workflow, as ComfyUI's API wants it.
//
// Every bug in this conversion is a silent one. The graph queues, runs for forty
// seconds, and produces the wrong picture — or produces nothing and reports
// success. Nothing throws. So each rule below is a rule that was *found* by
// converting three real workflows and watching a live ComfyUI reject them, and
// each one is written here with the failure it caused.
//
// The fixtures are hand-made rather than the real workflows: `/object_info` is
// three megabytes of one machine's installed nodes, and a test that needs it is
// a test that only runs on that machine. The real ones are used for the parts
// that need no schema.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const G = await import(pathToFileURL(path.join(ROOT, 'server/comfyGraph.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deep = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* A minimal `/object_info`, carrying only what each rule needs. */
const INFO = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL', {}],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['simple', 'karras'], {}],
        positive: ['CONDITIONING', {}],
        latent_image: ['LATENT', {}],
        denoise: ['FLOAT', {}],
      },
    },
    output: ['LATENT'],
  },
  // A custom node with an undeclared seed control, like AnimaPiDDecode.
  Decoder: {
    input: { required: { latent: ['LATENT', {}], seed: ['INT', {}], tile: ['INT', {}] } },
    output: ['IMAGE'],
  },
  // Declares STRING inputs the node turns into plain sockets, like Efficient Loader.
  Loader: {
    input: { required: { ckpt: [['a.safetensors'], {}], seed: ['INT', {}], cfg: ['FLOAT', {}], positive: ['STRING', {}] } },
    output: ['MODEL'],
  },
  Maths: {
    input: {
      required: {
        expression: ['STRING', {}],
        values: ['COMFY_AUTOGROW_V3', { template: { names: ['a', 'b'] } }],
      },
    },
    output: ['INT'],
  },
  Upscale: {
    input: {
      required: {
        images: ['IMAGE', {}],
        resize_type: ['COMFY_DYNAMICCOMBO_V3', {
          options: [
            { key: 'by multiplier', inputs: { required: { scale: ['FLOAT', {}] } } },
            { key: 'exact', inputs: { required: { width: ['INT', {}], height: ['INT', {}] } } },
          ],
        }],
        quality: [['LOW', 'HIGH'], {}],
      },
    },
    output: ['IMAGE'],
  },
  Number: { input: { required: { value: ['INT', {}] } }, output: ['INT'] },
  Save: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } }, output: [] },
  Passthrough: { input: { required: { image: ['IMAGE', {}], flag: ['BOOLEAN', {}] } }, output: ['IMAGE'] },
};

/* ------------------------------------------------- which inputs are widgets */

check('a combo is a widget', G.isWidgetInput(['a', 'b']));
check('so are the four primitives',
  ['INT', 'FLOAT', 'STRING', 'BOOLEAN'].every(G.isWidgetInput));
check('a link type is not', !G.isWidgetInput('MODEL') && !G.isWidgetInput('LATENT'));

deep('inputs come out in declaration order, required before optional',
  G.declaredInputs({ input: { required: { a: ['INT', {}] }, optional: { b: ['INT', {}] } } }).map(i => i.name),
  ['a', 'b']);

/* --------------------------------------------------------- reading widgets

   The one place an off-by-one turns a working graph into a wrong one. */

deep('a declared control is skipped',
  G.readWidgets(INFO.KSampler, [42, 'randomize', 20, 7, 'euler', 'simple', 1]),
  { seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'simple', denoise: 1 });

// AnimaPiDDecode: an INT called `seed` that `/object_info` says nothing about,
// and the editor gives it a control anyway. Reading by the declaration alone
// put "randomize" into the next input, which ComfyUI rejected as
// "invalid literal for int()".
deep('an undeclared control is spotted by the keyword after it',
  G.readWidgets(INFO.Decoder, [7, 'randomize', 64]),
  { seed: 7, tile: 64 });
deep('and a node with no control is not mis-skipped',
  G.readWidgets(INFO.Decoder, [7, 64]),
  { seed: 7, tile: 64 });

// Efficient Loader: the control slot held `null` rather than a keyword, and
// `positive` is declared STRING but is a plain socket on the node — counting it
// shifted everything after it, so `cfg` came out null and `sampler_name` came
// out as a number.
deep('a null control slot is skipped when the widget is a seed',
  G.readWidgets(INFO.Loader, ['a.safetensors', -1, null, 7], [{ name: 'positive', isWidget: false }]),
  { ckpt: 'a.safetensors', seed: -1, cfg: 7 });
check('and a declared widget the node made a socket occupies no slot',
  G.readWidgets(INFO.Loader, ['a.safetensors', -1, null, 7], [{ name: 'positive', isWidget: false }]).positive === undefined);
// A *promoted* widget is still a widget and does still occupy its slot.
deep('but a promoted widget keeps its place',
  G.readWidgets(INFO.KSampler, [42, 'fixed', 20, 7, 'euler', 'simple', 1], [{ name: 'seed', isWidget: true }]),
  { seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'simple', denoise: 1 });

/* v3 dynamic inputs. A dynamic combo eats its key plus whatever that option
   needs — two values for one option and three for another — and an auto-grow
   input eats nothing at all, being sockets only. */
deep('a dynamic combo eats the option it names',
  G.readWidgets(INFO.Upscale, ['by multiplier', 2, 'HIGH']),
  { resize_type: 'by multiplier', 'resize_type.scale': 2, quality: 'HIGH' });
deep('and a different option eats a different number of values',
  G.readWidgets(INFO.Upscale, ['exact', 1920, 1080, 'LOW']),
  { resize_type: 'exact', 'resize_type.width': 1920, 'resize_type.height': 1080, quality: 'LOW' });
deep('an auto-grow input takes no widget slots',
  G.readWidgets(INFO.Maths, ['a + b']),
  { expression: 'a + b' });

/* ------------------------------------------------------------- both link forms */

deep('a tuple link reads', G.normaliseLink([1, 2, 0, 3, 1, 'IMAGE']),
  { id: 1, originId: 2, originSlot: 0, targetId: 3, targetSlot: 1, type: 'IMAGE' });
deep('and so does an object one',
  G.normaliseLink({ id: 1, origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 1, type: 'IMAGE' }),
  { id: 1, originId: 2, originSlot: 0, targetId: 3, targetSlot: 1, type: 'IMAGE' });

/* ------------------------------------------------------------ whole graphs */

const node = (id, type, extra = {}) => ({ id, type, mode: 0, ...extra });
const convert = (workflow) => G.toApiPrompt(workflow, INFO);

// The simplest possible graph, to fix the basics.
const basic = convert({
  nodes: [
    node(1, 'Number', { widgets_values: [5], outputs: [{ links: [10] }] }),
    node(2, 'Save', {
      widgets_values: ['out'],
      inputs: [{ name: 'images', link: 10 }],
    }),
    node(3, 'Note', {}),
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE']],
});
eq('notes are not nodes', Object.keys(basic.prompt).length, 2);
const saveNode = Object.values(basic.prompt).find(n => n.class_type === 'Save');
eq('a widget value lands under its name', saveNode.inputs.filename_prefix, 'out');
check('and a link lands as [node, slot]', Array.isArray(saveNode.inputs.images));

// Ids are renumbered, and the editor's id is kept so bindings can find it.
check('nodes are renumbered to plain integers',
  Object.keys(basic.prompt).every(id => /^\d+$/.test(id)), Object.keys(basic.prompt).join(','));
check('and each remembers which node it was',
  Object.values(basic.prompt).every(n => n._meta?.source !== undefined));

/* Muted and bypassed are different, and treating them the same is a graph that
   either runs a branch it should not or loses one it should keep. */
const muted = convert({
  nodes: [
    node(1, 'Number', { widgets_values: [5], outputs: [{ links: [10] }] }),
    node(2, 'Passthrough', { mode: 2, widgets_values: [true], inputs: [{ name: 'image', link: 10 }], outputs: [{ links: [11] }] }),
    node(3, 'Save', { widgets_values: ['out'], inputs: [{ name: 'images', link: 11 }] }),
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 2, 0, 3, 0, 'IMAGE']],
});
check('a muted node is gone', !Object.values(muted.prompt).some(n => n.class_type === 'Passthrough'));
check('and takes the wire through it with it',
  Object.values(muted.prompt).find(n => n.class_type === 'Save').inputs.images === undefined);

const bypassed = convert({
  nodes: [
    node(1, 'Number', { widgets_values: [5], outputs: [{ links: [10] }] }),
    node(2, 'Passthrough', { mode: 4, widgets_values: [true], inputs: [{ name: 'image', link: 10 }], outputs: [{ links: [11] }] }),
    node(3, 'Save', { widgets_values: ['out'], inputs: [{ name: 'images', link: 11 }] }),
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 2, 0, 3, 0, 'IMAGE']],
});
check('a bypassed node is gone too', !Object.values(bypassed.prompt).some(n => n.class_type === 'Passthrough'));
const bypassSave = Object.values(bypassed.prompt).find(n => n.class_type === 'Save');
const bypassSource = bypassed.prompt[bypassSave.inputs.images?.[0]];
check('but the wire passes straight through it',
  bypassSource?.class_type === 'Number', JSON.stringify(bypassSave.inputs));

/* ------------------------------------------------------------- subgraphs

   Two pseudo-nodes make the boundary: -10 is the inputs, -20 the outputs. */

const SUB = {
  id: 'sub-1',
  name: 'Doubler',
  inputs: [{ name: 'unused', type: 'INT' }, { name: 'value', type: 'INT' }],
  outputs: [{ name: 'OUT', type: 'IMAGE' }],
  nodes: [node(1, 'Passthrough', { widgets_values: [true], inputs: [{ name: 'image', link: 5 }], outputs: [{ links: [6] }] })],
  links: [
    { id: 5, origin_id: -10, origin_slot: 1, target_id: 1, target_slot: 0, type: 'IMAGE' },
    { id: 6, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
  ],
};

/* The instance exposes only *some* of the definition's inputs as sockets, and in
   its own order. Reading the instance's list at the definition's index is the
   bug that sent a RESSHIFT_MODEL into an input called `seed`. */
const nested = convert({
  definitions: { subgraphs: [SUB] },
  nodes: [
    node(1, 'Number', { widgets_values: [5], outputs: [{ links: [10] }] }),
    node(2, 'sub-1', { inputs: [{ name: 'value', link: 10 }], outputs: [{ links: [11] }] }),
    node(3, 'Save', { widgets_values: ['out'], inputs: [{ name: 'images', link: 11 }] }),
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 2, 0, 3, 0, 'IMAGE']],
});
check('a subgraph instance disappears',
  !Object.values(nested.prompt).some(n => n.class_type === 'sub-1'));
check('its contents come up into the parent',
  Object.values(nested.prompt).some(n => n.class_type === 'Passthrough'));
const inner = Object.entries(nested.prompt).find(([, n]) => n.class_type === 'Passthrough');
const outerSource = nested.prompt[inner[1].inputs.image?.[0]];
check('a wire in through the boundary reaches the outside node',
  outerSource?.class_type === 'Number', JSON.stringify(inner[1].inputs));
const nestedSave = Object.values(nested.prompt).find(n => n.class_type === 'Save');
eq('and a wire out through it reaches the inside node',
  nested.prompt[nestedSave.inputs.images?.[0]]?.class_type, 'Passthrough');
// Matched by name: the instance offers one socket where the definition declares
// two, so index 1 of the definition is index 0 of the instance.
check('boundary inputs are matched by name, not by position',
  outerSource?.class_type === 'Number');

// A subgraph inside a subgraph. The first attempt at this recursed until the
// stack ran out, because it resolved while walking instead of afterwards.
const OUTER = {
  id: 'sub-2',
  name: 'Wrapper',
  inputs: [{ name: 'value', type: 'INT' }],
  outputs: [{ name: 'OUT', type: 'IMAGE' }],
  nodes: [node(1, 'sub-1', { inputs: [{ name: 'value', link: 7 }], outputs: [{ links: [8] }] })],
  links: [
    { id: 7, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0, type: 'IMAGE' },
    { id: 8, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
  ],
};
const deepNest = convert({
  definitions: { subgraphs: [SUB, OUTER] },
  nodes: [
    node(1, 'Number', { widgets_values: [5], outputs: [{ links: [10] }] }),
    node(2, 'sub-2', { inputs: [{ name: 'value', link: 10 }], outputs: [{ links: [11] }] }),
    node(3, 'Save', { widgets_values: ['out'], inputs: [{ name: 'images', link: 11 }] }),
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 2, 0, 3, 0, 'IMAGE']],
});
check('a subgraph inside a subgraph flattens without recursing for ever',
  Object.values(deepNest.prompt).some(n => n.class_type === 'Passthrough'));
const deepSave = Object.values(deepNest.prompt).find(n => n.class_type === 'Save');
eq('and the wire still crosses both boundaries',
  deepNest.prompt[deepSave.inputs.images?.[0]]?.class_type, 'Passthrough');

/* --------------------------------------------------- the editor's own nodes */

const routed = convert({
  nodes: [
    node(1, 'Number', { widgets_values: [5], outputs: [{ links: [10] }] }),
    node(2, 'Reroute', { inputs: [{ name: '', link: 10 }], outputs: [{ links: [11] }] }),
    node(3, 'Save', { widgets_values: ['out'], inputs: [{ name: 'images', link: 11 }] }),
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 2, 0, 3, 0, 'IMAGE']],
});
check('a Reroute is a wire, not a node', !Object.values(routed.prompt).some(n => n.class_type === 'Reroute'));
eq('and the wire goes through it',
  routed.prompt[Object.values(routed.prompt).find(n => n.class_type === 'Save').inputs.images?.[0]]?.class_type,
  'Number');

const named = convert({
  nodes: [
    node(1, 'Number', { widgets_values: [5], outputs: [{ links: [10] }] }),
    node(2, 'SetNode', { widgets_values: ['thing'], inputs: [{ name: '', link: 10 }] }),
    node(3, 'GetNode', { widgets_values: ['thing'], outputs: [{ links: [11] }] }),
    node(4, 'Save', { widgets_values: ['out'], inputs: [{ name: 'images', link: 11 }] }),
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 3, 0, 4, 0, 'IMAGE']],
});
eq('a Get finds what its Set was given',
  named.prompt[Object.values(named.prompt).find(n => n.class_type === 'Save').inputs.images?.[0]]?.class_type,
  'Number');
check('and neither survives into the prompt',
  !Object.values(named.prompt).some(n => ['SetNode', 'GetNode'].includes(n.class_type)));

/* An uninstalled class is reported once, not once per node. */
const missing = convert({
  nodes: [node(1, 'NotInstalled', {}), node(2, 'NotInstalled', {})],
  links: [],
});
eq('a missing node type is one warning', missing.warnings.length, 1);
check('naming the class', /NotInstalled/.test(missing.warnings[0]));

/* ------------------------------------------ the workflow that goes with it

   A prompt is enough to *run* a graph, and for a long time this sent only that.
   It is not enough for the packs that keep settings in the editor's
   `properties` and go looking for them at run time — and `efficiency-nodes-ED`
   does not fall back when it cannot find itself, it raises
   `UnboundLocalError: cannot access local variable 'vae_decode'`, which is the
   Anima sampler failing every generation. */

const withProps = convert({
  nodes: [
    node(1, 'Number', { widgets_values: [5], outputs: [{ links: [10] }] }),
    node(2, 'Save', {
      title: 'the end',
      widgets_values: ['out'],
      inputs: [{ name: 'images', link: 10 }],
      properties: { 'Use tiled VAE decode': true, cycle: 3 },
    }),
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE']],
});

check('editor properties are carried out of the conversion',
  withProps.properties['2']?.['Use tiled VAE decode'] === true);

const editor = G.toEditorWorkflow(withProps.prompt, withProps.properties);
const saveId = Object.keys(withProps.prompt).find(id => withProps.prompt[id].class_type === 'Save');
const saved = editor.nodes.find(n => n.type === 'Save');

/* The lookup on the other side is `node["id"] == int(my_unique_id)`, and in
   Python `"2" == 2` is false — so a workflow numbered with strings is a
   workflow in which nothing ever matches, while looking entirely correct. */
check('every id is a number, not a string', editor.nodes.every(n => typeof n.id === 'number'));
eq('and it is the id the node runs under', saved.id, Number(saveId));
eq('the settings arrive with it', saved.properties['Use tiled VAE decode'], true);
eq('all of them', saved.properties.cycle, 3);
eq('with the name every pack expects to find', saved.properties['Node name for S&R'], 'Save');
eq('and the title, for whoever reads the file', saved.title, 'the end');
eq('a node with no settings still gets its name',
  editor.nodes.find(n => n.type === 'Number').properties['Node name for S&R'], 'Number');

// Read, not indexed into, by two packs here — as [] rather than absent so that
// indexing it is not the next crash.
deep('links is present and empty', editor.links, []);
check('nodes is a list', Array.isArray(editor.nodes) && editor.nodes.length === 2);

/* Stacking LoRAs clones nodes *after* the conversion, so the workflow is built
   from the finished graph. A clone is `<original>#1`, and it has to find the
   settings of the node it was copied from — a clone that finds nothing is
   exactly the case that crashes. */
const cloned = {
  ...withProps.prompt,
  99: { class_type: 'Save', inputs: {}, _meta: { title: 'Save 2', source: `${withProps.prompt[saveId]._meta.source}#1` } },
};
eq('a cloned node inherits its original\'s settings',
  G.toEditorWorkflow(cloned, withProps.properties).nodes.find(n => n.id === 99).properties.cycle, 3);

/* ------------------------------------------------- the real workflows exist */

const dir = path.join(ROOT, 'workflows');
for (const file of ['krea2_turbo.json', 'anima.json', 'minimax.json']) {
  const full = path.join(dir, file);
  check(`${file} is in the repository`, fs.existsSync(full));
  if (!fs.existsSync(full)) continue;
  const workflow = JSON.parse(fs.readFileSync(full, 'utf8'));
  check(`${file} is an editor workflow`, Array.isArray(workflow.nodes) && Array.isArray(workflow.links));
  // Every link in every scope has to read, in whichever spelling it was saved.
  const links = [...workflow.links, ...(workflow.definitions?.subgraphs || []).flatMap(s => s.links || [])];
  check(`${file}: every link normalises`,
    links.every(l => Number.isFinite(G.normaliseLink(l).targetSlot)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
