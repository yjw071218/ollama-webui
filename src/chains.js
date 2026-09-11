/**
 * A prompt that is several prompts.
 *
 * The things people do with a local model twice a week are not single
 * questions. "Summarise this, then argue against the summary, then tell me
 * which objections survive" is three prompts, and doing it by hand means
 * typing the second one after reading the first, copying half of it in, and
 * being present for all four minutes. The saved-prompt library holds each of
 * the three; nothing held the *sequence*, which is the part that is actually
 * yours.
 *
 * A chain is that sequence. Written once, run against any input.
 *
 * ## Each step is a fresh turn, not a conversation
 *
 * The obvious implementation appends every step to one growing conversation.
 * It is wrong here for a reason that is specific to this app: on a machine
 * running a 4k or 8k context, step five would arrive carrying four previous
 * prompts *and* four previous answers, and the chain would run out of room
 * halfway through — silently, because a model given too much context does not
 * error, it forgets the beginning.
 *
 * So every step is asked on its own, and what carries forward is exactly what
 * the author asked to carry: `{{previous}}`, `{{input}}`, `{{step2}}`. That is
 * more work to write and it is the difference between a chain that works on
 * a small model and one that works on somebody else's cloud.
 *
 * ## A failed step stops the chain
 *
 * The alternative — pass the error along as if it were content — produces a
 * final answer confidently written from the sentence "HTTP 500". Stopping
 * with three of five steps done and their outputs kept is worse to look at
 * and much better to have.
 */

export const MAX_STEPS = 8;
export const MAX_NAME = 60;

/** What a step's output is trimmed to before it is handed to the next one. */
export const STEP_BUDGET = 6000;

let counter = 0;
const nextId = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const newStep = (title = '', prompt = '') => ({
  id: nextId('s'),
  title: String(title || '').slice(0, MAX_NAME),
  prompt: String(prompt || ''),
});

export const newChain = (name, steps = []) => ({
  id: nextId('c'),
  name: String(name || '').trim().slice(0, MAX_NAME) || 'Untitled',
  steps: steps.length ? steps.slice(0, MAX_STEPS) : [newStep('', '')],
  createdAt: Date.now(),
});

export const chainStorageKey = (userId) => (userId ? `promptChains:${userId}` : 'promptChains');

export const loadChains = (userId) => {
  try {
    const raw = JSON.parse(localStorage.getItem(chainStorageKey(userId)) || 'null');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(chain => chain && typeof chain.name === 'string' && Array.isArray(chain.steps))
      .map(chain => ({
        id: chain.id || nextId('c'),
        name: chain.name.slice(0, MAX_NAME),
        steps: chain.steps
          .filter(step => step && typeof step.prompt === 'string')
          .slice(0, MAX_STEPS)
          .map(step => ({ id: step.id || nextId('s'), title: String(step.title || ''), prompt: step.prompt })),
        createdAt: chain.createdAt || Date.now(),
      }))
      .filter(chain => chain.steps.length > 0);
  } catch (e) {
    return [];
  }
};

export const saveChains = (userId, chains) => {
  try { localStorage.setItem(chainStorageKey(userId), JSON.stringify(chains || [])); }
  catch (e) { /* quota, or storage disabled */ }
};

const PLACEHOLDER = /\{\{\s*(input|previous|step(\d+))\s*\}\}/gi;

/** Which earlier outputs a step's prompt asks for. */
export const referencesIn = (prompt) => {
  const found = new Set();
  for (const match of String(prompt || '').matchAll(PLACEHOLDER)) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
};

/**
 * Fill a step's prompt in.
 *
 * `outputs` is the list of what previous steps returned, in order. A reference
 * to a step that has not run is left as written rather than replaced with an
 * empty string: an empty string reads as "there was nothing", and the author
 * needs to see that they asked for something that does not exist yet.
 */
export const renderStep = (prompt, { input = '', outputs = [] } = {}) =>
  String(prompt || '').replace(PLACEHOLDER, (whole, name, digits) => {
    const key = name.toLowerCase();
    if (key === 'input') return input;
    if (key === 'previous') {
      return outputs.length ? outputs[outputs.length - 1].slice(0, STEP_BUDGET) : whole;
    }
    const n = Number(digits);
    if (n >= 1 && n <= outputs.length) return outputs[n - 1].slice(0, STEP_BUDGET);
    return whole;
  });

/**
 * What is wrong with this chain, before anybody waits on it.
 *
 * A chain is minutes long on a local model, so a reference to a step that runs
 * *after* the one referring to it must be a message and not a discovery made
 * three minutes in. Returns a list rather than throwing, because the editor
 * shows all of them at once.
 */
export const validateChain = (chain) => {
  const problems = [];
  const steps = chain?.steps || [];

  if (!String(chain?.name || '').trim()) problems.push({ kind: 'name' });
  if (steps.length === 0) problems.push({ kind: 'empty' });

  steps.forEach((step, index) => {
    if (!String(step.prompt || '').trim()) {
      problems.push({ kind: 'blank', step: index + 1 });
      return;
    }
    for (const reference of referencesIn(step.prompt)) {
      if (reference === 'input') continue;
      if (reference === 'previous') {
        // The first step has no previous. This is the commonest way a chain is
        // written wrong, because the second step is the one people write first.
        if (index === 0) problems.push({ kind: 'noPrevious', step: 1 });
        continue;
      }
      const n = Number(reference.replace('step', ''));
      if (!(n >= 1) || n > index) problems.push({ kind: 'forward', step: index + 1, refers: n });
    }
  });

  // Not an error, but the commonest reason a chain quietly ignores its input.
  if (steps.length > 0 && !referencesIn(steps[0].prompt).includes('input')) {
    problems.push({ kind: 'noInput', step: 1 });
  }

  return problems;
};

/** Only the ones that stop a run; `noInput` is advice. */
export const blocking = (problems) => (problems || []).filter(p => p.kind !== 'noInput');

/**
 * Run it.
 *
 * `ask` is injected for the same reason it is in the research loop: a real run
 * takes minutes and needs a model, so without a stand-in this is code that is
 * written once and never exercised again.
 *
 * Every step is reported as it starts and as it finishes. A chain that prints
 * nothing for four minutes is indistinguishable from one that has hung, and
 * the intermediate outputs are most of the value anyway — when the last step
 * disappoints, the interesting question is which step went wrong.
 */
export const runChain = async ({
  chain,
  input = '',
  ask,
  onStep = () => {},
  signal,
} = {}) => {
  const steps = chain?.steps || [];
  const results = [];
  const outputs = [];

  const report = (entry) => {
    onStep(entry, results);
    return entry;
  };

  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) {
      return { steps: results, output: outputs[outputs.length - 1] || '', cancelled: true };
    }

    const step = steps[i];
    const prompt = renderStep(step.prompt, { input, outputs });
    const entry = {
      index: i,
      title: step.title || '',
      prompt,
      output: '',
      state: 'running',
    };
    results.push(entry);
    report(entry);

    try {
      const answer = await ask(prompt, { signal, step: i, total: steps.length });
      entry.output = String(answer || '');
      entry.state = 'done';
      outputs.push(entry.output);
      report(entry);
    } catch (e) {
      if (signal?.aborted) {
        entry.state = 'cancelled';
        report(entry);
        return { steps: results, output: outputs[outputs.length - 1] || '', cancelled: true };
      }
      entry.state = 'failed';
      entry.error = e.message;
      report(entry);
      // Stopping here keeps three of five outputs. Passing "HTTP 500" forward
      // as if it were content produces a final answer confidently written from
      // an error message.
      return { steps: results, output: outputs[outputs.length - 1] || '', failed: e.message };
    }
  }

  return { steps: results, output: outputs[outputs.length - 1] || '' };
};

/**
 * Chains worth starting from.
 *
 * Three, and each one is a shape rather than a subject: refine, criticise,
 * translate-and-check. A starter list of twenty would be a list nobody reads;
 * three that visibly do different things is a demonstration of what the
 * placeholders are for.
 */
export const STARTER_CHAINS = [
  {
    nameKey: 'chains.starter.critique',
    steps: [
      { titleKey: 'chains.starter.critiqueDraft', prompt: '{{input}}' },
      {
        titleKey: 'chains.starter.critiqueAttack',
        prompt: 'Argue against the following as strongly as you honestly can. '
          + 'Name the weakest claims and say why.\n\n{{previous}}',
      },
      {
        titleKey: 'chains.starter.critiqueSettle',
        prompt: 'Here is an answer and the case against it. Say which objections survive '
          + 'and rewrite the answer to account for them. Keep what was right.\n\n'
          + 'ANSWER:\n{{step1}}\n\nOBJECTIONS:\n{{step2}}',
      },
    ],
  },
  {
    nameKey: 'chains.starter.explain',
    steps: [
      {
        titleKey: 'chains.starter.explainPlain',
        prompt: 'Explain this in plain language, assuming no background:\n\n{{input}}',
      },
      {
        titleKey: 'chains.starter.explainCheck',
        prompt: 'Read this explanation and list anything it gets wrong, oversimplifies '
          + 'to the point of being misleading, or leaves out.\n\n{{previous}}',
      },
    ],
  },
  {
    nameKey: 'chains.starter.translate',
    steps: [
      { titleKey: 'chains.starter.translateDo', prompt: 'Translate into English:\n\n{{input}}' },
      {
        titleKey: 'chains.starter.translateBack',
        prompt: 'Translate this back into the original language of the source text, '
          + 'literally:\n\n{{previous}}',
      },
      {
        titleKey: 'chains.starter.translateCompare',
        prompt: 'Compare the original with the round trip and point out where meaning '
          + 'shifted.\n\nORIGINAL:\n{{input}}\n\nROUND TRIP:\n{{step2}}',
      },
    ],
  },
];
