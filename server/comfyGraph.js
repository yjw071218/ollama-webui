/**
 * A ComfyUI workflow, as ComfyUI's API wants it.
 *
 * ## Two formats, and why this exists
 *
 * What you save out of ComfyUI is the *editor's* format: nodes with positions,
 * links as an array of tuples, widget values in a positional array, subgraphs
 * kept as reusable definitions and instantiated by id. What `POST /prompt`
 * accepts is something else entirely — a flat object of `id -> {class_type,
 * inputs}` where every input is either a literal or `[sourceNodeId, slot]`.
 *
 * The editor converts between them in the browser, which is no help to a server
 * that has been handed a `.json` file. Hence this.
 *
 * ## What has to happen, and what is silently wrong if it does not
 *
 *   * **Widget values are positional.** `widgets_values: [301016887883500,
 *     "randomize", 8, 1, "euler", "simple", 1]` becomes seed/steps/cfg/
 *     sampler_name/scheduler/denoise only if you know the order — which lives
 *     in `/object_info`, not in the file. Off by one and the sampler becomes
 *     the scheduler.
 *   * **`control_after_generate` inserts an extra value** after the widget it
 *     belongs to. It is the "randomize" above. It is not an input, and counting
 *     it as one shifts everything after it.
 *   * **A widget can also be a socket.** Promote `seed` to an input and it
 *     appears in both `inputs[]` and `widgets_values`. The link wins.
 *   * **Subgraphs must be flattened.** They nest, and their boundary is two
 *     pseudo-nodes: `-10` is the inputs, `-20` the outputs.
 *   * **Muted and bypassed nodes are different.** Muted (mode 2) is deleted.
 *     Bypassed (mode 4) passes its input through to its output, which is the
 *     whole point of bypassing rather than muting.
 *   * **Some nodes never existed.** Reroute, PrimitiveNode, SetNode and GetNode
 *     are the editor's own; the server has never heard of them and they have to
 *     be resolved away rather than emitted.
 *
 * Every one of those is a workflow that queues happily and then fails forty
 * seconds later, or worse, produces a picture that is subtly not what the graph
 * said. So the conversion is pure and tested against real exported workflows.
 */

/* ------------------------------------------------------------ what a widget is

   An input is a widget if its value can be typed rather than plugged in: a
   combo (declared as a list of options), or one of the four primitives. Anything
   else — MODEL, CLIP, LATENT, IMAGE, CONDITIONING and every custom type — is a
   socket and never appears in `widgets_values`. */

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

export const isWidgetInput = (declaredType) =>
  Array.isArray(declaredType) || WIDGET_TYPES.has(String(declaredType));

/**
 * Every input a class declares, in the order the editor lays them out.
 *
 * `required` before `optional`, which is the order `widgets_values` is written
 * in. Returns the whole list rather than only the widgets, because emitting
 * needs to know about the sockets too.
 */
export const declaredInputs = (classSpec) => {
  const out = [];
  for (const section of ['required', 'optional']) {
    const group = classSpec?.input?.[section];
    if (!group) continue;
    for (const [name, decl] of Object.entries(group)) {
      const type = Array.isArray(decl) ? decl[0] : decl;
      const opts = (Array.isArray(decl) && decl[1] && typeof decl[1] === 'object') ? decl[1] : {};
      out.push({
        name,
        type,
        widget: isWidgetInput(type),
        // The extra positional value that follows a seed. Not an input.
        control: !!opts.control_after_generate,
        /* ComfyUI's v3 dynamic inputs. A dynamic combo is a choice followed by
           however many values that choice needs — `["scale by multiplier", 2]`
           is two slots, `["target dimensions", 1920, 1080]` is three — so how
           much of `widgets_values` it eats depends on which option was picked.
           An auto-grow input eats none of it: it is purely sockets. */
        combo: type === 'COMFY_DYNAMICCOMBO_V3' ? (opts.options || []) : null,
        autogrow: type === 'COMFY_AUTOGROW_V3',
      });
    }
  }
  return out;
};

/* What a `control_after_generate` widget can be set to. The editor writes one
 * of these into `widgets_values` right after the number it controls. */
const CONTROLS = new Set(['randomize', 'fixed', 'increment', 'decrement']);

/**
 * Widget values, matched to the names they belong to.
 *
 * The one place an off-by-one turns a working graph into a wrong one, and there
 * are two independent ways to get the alignment wrong.
 *
 * **Which inputs are widgets at all.** `/object_info` says what a class
 * *declares*, and a declared `STRING` is normally a text box — but a node can
 * make one a plain socket instead, and a socket occupies no slot in
 * `widgets_values`. `Efficient Loader` does exactly this with `positive` and
 * `negative`, and counting them shifted everything after them: `cfg` came out
 * `null`, `sampler_name` came out `7`, and ComfyUI refused the graph. So the
 * instance's own `inputs[]` is the authority, and `sockets` is it. A socket
 * that carries `widget: {...}` is a *promoted* widget and does still occupy a
 * slot; one without is a pure socket and does not.
 *
 * **`control_after_generate`.** It writes an extra value after the number it
 * controls. Core nodes declare it; custom nodes with a plain INT called `seed`
 * get one from the editor and declare nothing. It shows up as one of four
 * keywords, or as `null` — both are handled, and both were found in these
 * workflows rather than guessed at.
 */
export const readWidgets = (classSpec, values = [], sockets = []) => {
  const pureSockets = new Set(sockets.filter(s => !s.isWidget).map(s => s.name));
  const out = {};
  let i = 0;

  for (const input of declaredInputs(classSpec)) {
    /* A dynamic combo: the chosen option's name, then that option's own
       inputs. Its sub-values are written under the dotted names the node uses
       for them, which is exactly what ComfyUI's API expects to read back. */
    if (input.combo) {
      const key = values[i];
      out[input.name] = key;
      i += 1;
      const option = input.combo.find(o => o.key === key);
      // `optional` as well as `required`: `TextGenerate`'s sampling options end
      // with an optional `presence_penalty`, and stopping at the required ones
      // left two values unconsumed — which pushed `thinking` and
      // `use_default_template` onto the wrong slots and lost
      // `repetition_penalty` altogether.
      // `{ input: … }` because an option spells its inputs `inputs` where a
      // class spells them `input`, and `declaredInputs` reads the class shape.
      for (const sub of declaredInputs({ input: option?.inputs })) {
        out[`${input.name}.${sub.name}`] = values[i];
        i += 1;
        if (sub.control) i += 1;
      }
      continue;
    }
    // Auto-grow inputs are sockets only; they occupy nothing here.
    if (input.autogrow) continue;

    if (!input.widget) continue;
    if (pureSockets.has(input.name)) continue;

    if (i < values.length) out[input.name] = values[i];
    i += 1;

    const seedLike = input.type === 'INT' && /(^|_)seed$/i.test(input.name);
    const keyword = typeof values[i] === 'string' && CONTROLS.has(values[i]);
    if (input.control || (input.type === 'INT' && keyword) || (seedLike && values[i] === null)) {
      i += 1;
    }
  }
  return out;
};

/* --------------------------------------------------------------- the links

   Two spellings of the same thing: the top level writes them as tuples and a
   subgraph definition writes them as objects. Neither is wrong; both have to be
   read. */

export const normaliseLink = (link) => {
  if (Array.isArray(link)) {
    const [id, originId, originSlot, targetId, targetSlot, type] = link;
    return { id, originId, originSlot, targetId, targetSlot, type };
  }
  return {
    id: link.id,
    originId: link.origin_id,
    originSlot: link.origin_slot,
    targetId: link.target_id,
    targetSlot: link.target_slot,
    type: link.type,
  };
};

/* ---------------------------------------------------- nodes that are not nodes */

const VIRTUAL = new Set(['Reroute', 'PrimitiveNode', 'SetNode', 'GetNode', 'Note', 'MarkdownNote']);
const DROPPED = new Set(['Note', 'MarkdownNote']);

const MUTED = 2;
const BYPASSED = 4;

/**
 * Walk the workflow, expanding subgraphs, without resolving anything yet.
 *
 * Expansion and resolution are two passes on purpose. A link inside a subgraph
 * can point out through the boundary at a node in the parent — which is a node
 * in a *different namespace*, and possibly one the walk has not reached yet. Any
 * attempt to resolve while walking either reads an id in the wrong scope or
 * chases its own tail; the first version of this did both, and turned a nested
 * workflow into a stack overflow.
 *
 * So this pass only records, in scope-local terms, and `resolveIn` below does
 * the joining once everything is known.
 */
const expand = (scope, subgraphs, prefix, parentPrefix, instanceNode, out) => {
  const links = (scope.links || []).map(normaliseLink);
  const id = (raw) => `${prefix}${raw}`;

  /* Where this scope's boundary leads.
   *
   * `inputs[k]` is what the instantiating node plugged into input k, expressed
   * in the *parent's* terms; `outputs[k]` is what the inside connected to
   * output k, in this scope's terms. Together they are how a wire crosses. */
  const boundary = { parentPrefix, inputs: [], outputs: [] };
  out.scopes.set(prefix, boundary);

  if (instanceNode) {
    /* Boundary inputs are matched by *name*, not by position.
     *
     * A link inside the subgraph says `origin_id: -10, origin_slot: k`, and k
     * indexes the definition's own `inputs[]`. The instantiating node's
     * `inputs[]` is a different and usually shorter list — only the ones
     * promoted to visible sockets — so reading it at index k lines the wrong
     * wire up with the wrong socket. It is invisible where the extra inputs are
     * unconnected (the inner widget value is used and the graph still works),
     * and it is a type error where they are not: a RESSHIFT_MODEL arriving at
     * an input called `seed`. */
    const parentLinks = instanceNode.parentLinks || [];
    const sockets = instanceNode.inputs || [];
    (scope.inputs || []).forEach((declared, slot) => {
      const socket = sockets.find(s => s.name === declared.name);
      const linkId = socket?.link ?? null;
      if (linkId === null || linkId === undefined) { boundary.inputs[slot] = null; return; }
      const link = parentLinks.find(l => l.id === linkId);
      boundary.inputs[slot] = link ? { originId: link.originId, slot: link.originSlot } : null;
    });
  }

  for (const node of scope.nodes || []) {
    if (DROPPED.has(node.type)) continue;

    const definition = subgraphs.get(node.type);
    if (!definition) {
      out.nodes.set(id(node.id), {
        id: id(node.id),
        scope: prefix,
        type: node.type,
        mode: node.mode || 0,
        title: node.title || '',
        widgets: node.widgets_values,
        /* Not an input, and not ignorable. `properties` is where the editor
           keeps a node's right-click settings, and several packs read their own
           back out of it at run time rather than taking them as inputs — see
           `toEditorWorkflow`, which is what carries them across. */
        properties: node.properties || {},
        // Which named inputs are sockets, and what is plugged into them. Needed
        // because a promoted widget appears both here and in `widgets_values`.
        sockets: (node.inputs || []).map(input => ({
          name: input.name,
          isWidget: !!input.widget,
          link: input.link ?? null,
        })),
      });
      continue;
    }

    const innerPrefix = `${id(node.id)}:`;
    out.instances.set(id(node.id), innerPrefix);
    expand(definition, subgraphs, innerPrefix, prefix, { ...node, parentLinks: links }, out);
  }

  for (const link of links) {
    if (link.targetId === -20) {
      boundary.outputs[link.targetSlot] = { originId: link.originId, slot: link.originSlot };
      continue;
    }
    out.links.set(`${id(link.targetId)}:${link.targetSlot}`, {
      scope: prefix,
      originId: link.originId,
      slot: link.originSlot,
    });
  }
};

/**
 * One scope-local reference, followed until it lands on a real node.
 *
 * Three things can be in the way and each is a hop rather than an answer: a
 * subgraph instance (the real source is inside it), the `-10` boundary (the real
 * source is outside it), and a chain of either. The depth guard is not
 * defensive programming — the editor will happily save a subgraph whose output
 * is wired to its own input.
 */
const resolveIn = (out, scope, originId, slot, depth = 0) => {
  if (depth > 128) return null;

  // Out through the boundary: whatever the parent plugged into this slot.
  if (originId === -10) {
    const here = out.scopes.get(scope);
    const outer = here?.inputs?.[slot];
    // Nothing plugged in, or no parent to ask — the top level has no boundary,
    // so a `-10` there is a workflow referring to an outside that is not there.
    if (!outer || here.parentPrefix === null || here.parentPrefix === undefined) return null;
    return resolveIn(out, here.parentPrefix, outer.originId, outer.slot, depth + 1);
  }

  const nodeId = `${scope}${originId}`;

  // In through a subgraph instance: whatever the inside wired to this output.
  const innerPrefix = out.instances.get(nodeId);
  if (innerPrefix) {
    const inner = out.scopes.get(innerPrefix);
    const wired = inner?.outputs?.[slot];
    if (!wired) return null;
    return resolveIn(out, innerPrefix, wired.originId, wired.slot, depth + 1);
  }

  return out.nodes.has(nodeId) ? { node: nodeId, slot } : null;
};

/** What feeds one socket of one node, fully resolved. */
const sourceOf = (out, nodeId, socketIndex) => {
  const ref = out.links.get(`${nodeId}:${socketIndex}`);
  if (!ref) return null;
  return resolveIn(out, ref.scope, ref.originId, ref.slot);
};

/* ------------------------------------------------ resolving the editor's nodes

   Reroute and the rest are wires drawn as boxes. Following them is one loop,
   and the loop needs a guard because a workflow can contain a cycle of them
   that the editor happily draws and nothing else survives. */

const resolveThrough = (out, source, depth = 0) => {
  if (!source || depth > 64) return source;
  const node = out.nodes.get(source.node);
  if (!node) return source;

  if (node.type === 'Reroute') {
    return resolveThrough(out, sourceOf(out, node.id, 0), depth + 1);
  }

  /* `SetNode` and `GetNode` are a named wire drawn as two boxes. A `GetNode`
     is worth whatever was put into the `SetNode` sharing its name — and the
     name is the widget value, because that is all either of them is. */
  if (node.type === 'GetNode') {
    const name = node.widgets?.[0];
    for (const other of out.nodes.values()) {
      if (other.type === 'SetNode' && other.widgets?.[0] === name) {
        return resolveThrough(out, sourceOf(out, other.id, 0), depth + 1);
      }
    }
    return null;
  }

  if (node.type === 'SetNode') {
    return resolveThrough(out, sourceOf(out, node.id, 0), depth + 1);
  }

  /* Bypassed: the node is gone but the wire through it is not. The signal
     leaves by the output it was asked for and enters by the first input of the
     same type — which is how the editor draws it, and why a bypassed loader
     passes a model through while ignoring its own filename widget. */
  if (node.mode === BYPASSED) {
    const spec = out.objectInfo?.[node.type];
    const wantedType = spec?.output?.[source.slot];
    const declared = spec ? declaredInputs(spec) : [];
    const bySocket = node.sockets || [];

    let fallback = null;
    for (let slot = 0; slot < bySocket.length; slot += 1) {
      if (bySocket[slot].isWidget) continue;
      const feed = sourceOf(out, node.id, slot);
      if (!feed) continue;
      if (fallback === null) fallback = feed;
      const named = declared.find(d => d.name === bySocket[slot].name);
      if (wantedType && named && named.type === wantedType) {
        return resolveThrough(out, feed, depth + 1);
      }
    }
    return fallback ? resolveThrough(out, fallback, depth + 1) : null;
  }

  if (node.mode === MUTED) return null;

  return source;
};

/**
 * The whole conversion.
 *
 * `objectInfo` is what ComfyUI reports at `/object_info` — the widget order
 * lives there and nowhere else, so this cannot be done offline against an
 * arbitrary workflow without it.
 */
export const toApiPrompt = (workflow, objectInfo = {}) => {
  const subgraphs = new Map((workflow?.definitions?.subgraphs || []).map(s => [s.id, s]));
  const out = {
    nodes: new Map(),
    links: new Map(),
    scopes: new Map(),
    instances: new Map(),
    objectInfo,
  };

  expand(workflow, subgraphs, '', null, null, out);

  const prompt = {};
  const warnings = [];
  const missing = new Set();
  const propsBySource = new Map();

  for (const node of out.nodes.values()) {
    if (VIRTUAL.has(node.type)) continue;
    if (node.mode === MUTED || node.mode === BYPASSED) continue;

    const spec = objectInfo[node.type];
    if (!spec) {
      // Once per class, not once per node: a workflow with eight of something
      // uninstalled is one problem, not eight.
      if (!missing.has(node.type)) {
        missing.add(node.type);
        warnings.push(`${node.type} is not installed in this ComfyUI`);
      }
      continue;
    }

    const widgets = readWidgets(spec, node.widgets || [], node.sockets || []);
    const sockets = node.sockets || [];
    const inputs = {};

    for (const declared of declaredInputs(spec)) {
      const socketIndex = sockets.findIndex(s => s.name === declared.name);
      const resolved = socketIndex === -1
        ? null
        : resolveThrough(out, sourceOf(out, node.id, socketIndex));

      if (resolved) {
        /* A PrimitiveNode is a widget value wearing a box. It has no
           `class_type` to point at, so its value is inlined instead. */
        const upstream = out.nodes.get(resolved.node);
        if (upstream?.type === 'PrimitiveNode') {
          inputs[declared.name] = upstream.widgets?.[0];
        } else {
          inputs[declared.name] = [resolved.node, resolved.slot];
        }
        continue;
      }

      // `declared.combo` is the chosen option's name, which is a value even
      // though the type is not one this counts as a widget.
      if ((declared.widget || declared.combo) && widgets[declared.name] !== undefined) {
        inputs[declared.name] = widgets[declared.name];
      }
    }

    /* The sub-inputs of a v3 dynamic input — `values.a`, `resize_type.scale`.
     *
     * They have no entry of their own in `/object_info`: the class declares one
     * `values` or `resize_type`, and the node grows a socket per element. The
     * API addresses them by exactly the dotted name the node uses, which was
     * settled by asking this ComfyUI which of four spellings it would accept
     * rather than by reading it anywhere. Emitting them is the difference
     * between a maths node with its operands and one that reports "Required
     * input is missing: a". */
    const declaredNames = new Set(declaredInputs(spec).map(d => d.name));
    sockets.forEach((socket, index) => {
      if (declaredNames.has(socket.name)) return;
      if (!socket.name.includes('.')) return;

      const resolved = resolveThrough(out, sourceOf(out, node.id, index));
      if (resolved) {
        const upstream = out.nodes.get(resolved.node);
        inputs[socket.name] = upstream?.type === 'PrimitiveNode'
          ? upstream.widgets?.[0]
          : [resolved.node, resolved.slot];
        return;
      }
      if (widgets[socket.name] !== undefined) inputs[socket.name] = widgets[socket.name];
    });

    /* And the dotted values that are not sockets at all. A dynamic combo's
       sub-inputs are ordinary widgets on the node — they only become sockets
       if somebody promotes them — so most of them arrive here rather than
       above, and leaving them out is a node missing half its settings. */
    for (const [name, value] of Object.entries(widgets)) {
      if (!name.includes('.')) continue;
      if (inputs[name] !== undefined) continue;
      inputs[name] = value;
    }

    prompt[node.id] = {
      class_type: node.type,
      inputs,
      ...(node.title ? { _meta: { title: node.title } } : {}),
    };
    propsBySource.set(node.id, node.properties || {});
  }

  /* Plain integer ids.
   *
   * Flattening names an inner node after the instance that holds it —
   * `30:19`, `41:71:68` — which is unambiguous and readable and is not what
   * ComfyUI has ever been given. Its own exporter renumbers, so a colon in a
   * node id is a shape only this code produces, and "unusual input to somebody
   * else's scheduler" is not a thing to leave in for the sake of a nicer
   * debugging experience. The mapping is kept in `_meta` instead, where it
   * costs nothing and still answers "which node in the editor was this". */
  /* Keyed by the *editor* id, not the one it runs under.
     `toEditorWorkflow` looks them up through `_meta.source`, which survives both
     the renumbering here and the node-cloning that stacking LoRAs does later —
     so a clone still finds the settings of the node it was copied from. */
  return { prompt: renumber(prompt), properties: Object.fromEntries(propsBySource), warnings };
};

const renumber = (prompt) => {
  const ids = Object.keys(prompt);
  const numbered = new Map(ids.map((id, index) => [id, String(index + 1)]));
  const point = (value) => (
    Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && numbered.has(value[0])
      ? [numbered.get(value[0]), value[1]]
      : value);

  const out = {};
  for (const id of ids) {
    const node = prompt[id];
    const inputs = {};
    for (const [name, value] of Object.entries(node.inputs)) inputs[name] = point(value);
    out[numbered.get(id)] = {
      ...node,
      inputs,
      _meta: { ...(node._meta || {}), source: id },
    };
  }
  return out;
};

/**
 * The graph again, in the shape `extra_pnginfo.workflow` is expected to be.
 *
 * ## Why a prompt is not enough
 *
 * ComfyUI's own web page posts two descriptions of the same graph: the API
 * prompt, which is what executes, and the editor workflow, which is what the
 * page had on screen. Everything necessary to *run* is in the first, so an API
 * client can and normally does send only that.
 *
 * Except that a node's right-click settings live in neither. They are the
 * editor's `properties`, they are never inputs, and a pack that uses them reads
 * them back at run time by rummaging through `extra_pnginfo.workflow` for a node
 * whose `id` matches its own. Sent a prompt alone, those nodes find nothing.
 *
 * Most degrade quietly to a default. `efficiency-nodes-ED` does not:
 *
 *     if extra_pnginfo and "workflow" in extra_pnginfo:
 *         for node in workflow["nodes"]:
 *             if node["id"] == int(my_unique_id):
 *                 ...
 *                 vae_decode = "true (tiled)" if properties['tiled_vae'] else "true"
 *                 return properties, vae_decode
 *     return properties, vae_decode        # never assigned on this path
 *
 * — so the miss is `UnboundLocalError: cannot access local variable
 * 'vae_decode'`, and `KSampler (Efficient) ED` is the sampler in Anima. Their
 * bug, our trigger: sending the workflow is both the fix and what a client is
 * supposed to do.
 *
 * ## Why the ids have to be numbers
 *
 * The comparison is `node["id"] == int(my_unique_id)`, and in Python `"12" == 12`
 * is false. The renumbering above produces string keys, so they are converted
 * here; a workflow whose ids are strings looks completely correct and matches
 * nothing.
 *
 * ## What is deliberately not in it
 *
 * Wiring. The links are already resolved into the prompt's inputs, and turning
 * them back into editor links means inventing slot indices and socket types that
 * the API format does not carry — a graph that loads and is subtly wrong, which
 * is worse than one that plainly is not the original. Nothing reads them during
 * execution (the two packs here that touch `workflow["links"]` do it while
 * reading a saved PNG, not while running), and the API prompt goes into the
 * image's metadata regardless, so the replayable copy is not lost. `links` is
 * present but empty so that indexing it is not an error either.
 */
/* A node's editor settings, found through the id it had before renumbering.
   Cloned nodes carry `30:15#1` — the id they were copied from plus which copy —
   so a clone that finds nothing under its own name asks again under its
   original's. */
const settingsOf = (node, properties) => {
  const source = node._meta?.source;
  if (source === undefined) return {};
  return properties[source] || properties[String(source).replace(/#\d+$/, '')] || {};
};

export const toEditorWorkflow = (prompt, properties = {}) => {
  const nodes = Object.entries(prompt).map(([id, node], index) => ({
    id: Number(id),
    type: node.class_type,
    order: index,
    mode: 0,
    pos: [0, 0],
    size: [0, 0],
    flags: {},
    inputs: [],
    outputs: [],
    ...(node._meta?.title ? { title: node._meta.title } : {}),
    /* `Node name for S&R` is the one property the editor writes for every node
       and the one packs assume is there. The node's own properties go on top,
       because a workflow that sets it to something else meant to. */
    properties: { 'Node name for S&R': node.class_type, ...settingsOf(node, properties) },
    widgets_values: [],
  }));

  return {
    id: 'ollama-webui',
    revision: 0,
    last_node_id: nodes.reduce((high, node) => Math.max(high, node.id), 0),
    last_link_id: 0,
    nodes,
    links: [],
    groups: [],
    config: {},
    // Named for whoever opens the PNG and wonders why the wires are missing.
    extra: { generated_by: 'ollama-webui', note: 'Node settings only; the runnable copy is the API prompt.' },
    version: 0.4,
  };
};

/* --------------------------------------------------------- reading a graph

   Once a workflow is a prompt, the interesting question is which of its nodes
   are the ones a person would want to change: the prompt text, the size, the
   sampler, the checkpoint. Finding them by class and by role is what lets the
   Studio render controls for a workflow nobody hardcoded. */

/** Every node of a given class, as `[id, node]`. */
export const nodesOfClass = (prompt, ...classes) => {
  const wanted = new Set(classes);
  return Object.entries(prompt).filter(([, node]) => wanted.has(node.class_type));
};

/** Whether an input is a literal a person could set, rather than a wire. */
export const isLiteral = (value) =>
  value !== undefined && !(Array.isArray(value) && value.length === 2 && typeof value[0] === 'string');
