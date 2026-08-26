import localforage from 'localforage';
import { decodeByteFallback } from './byteFallback.js';

/**
 * Facts that outlive a single chat.
 *
 * Per-chat system prompts already exist, but nothing carried across
 * conversations — the assistant re-learned the same things every time. These
 * are short statements, stored per profile, injected into the system prompt.
 */

const store = localforage.createInstance({ name: 'ollama-webui', storeName: 'memory' });

const keyFor = (userId) => `memory:${userId || 'guest'}`;

export const MEMORY_KINDS = ['profile', 'preference', 'project', 'fact'];

export const loadMemories = async (userId) => {
  const list = await store.getItem(keyFor(userId));
  return Array.isArray(list) ? list : [];
};

export const saveMemories = (userId, memories) => store.setItem(keyFor(userId), memories);

export const newMemory = (text, kind = 'fact') => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  text: String(text).trim(),
  kind: MEMORY_KINDS.includes(kind) ? kind : 'fact',
  enabled: true,
  createdAt: Date.now(),
});

/**
 * Near-duplicate guard.
 *
 * Extraction runs after many turns and would otherwise pile up a dozen
 * rewordings of the same fact. Compares on significant words rather than exact
 * text, so "prefers Korean" and "Prefers Korean replies" collapse together.
 */
export const isDuplicate = (candidate, memories, threshold = 0.7) => {
  const words = (text) => new Set(
    String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2)
  );

  const a = words(candidate);
  if (a.size === 0) return true;   // nothing meaningful to keep

  return memories.some(memory => {
    const b = words(memory.text);
    if (b.size === 0) return false;
    let shared = 0;
    a.forEach(w => { if (b.has(w)) shared++; });
    return shared / Math.min(a.size, b.size) >= threshold;
  });
};

export const addMemories = async (userId, candidates) => {
  const existing = await loadMemories(userId);
  const added = [];

  for (const candidate of candidates) {
    const text = String(candidate?.text || candidate || '').trim();
    if (!text || text.length < 4 || text.length > 300) continue;
    if (isDuplicate(text, [...existing, ...added])) continue;
    added.push(newMemory(text, candidate?.kind));
  }

  if (added.length === 0) return { memories: existing, added: [] };
  const next = [...existing, ...added];
  await saveMemories(userId, next);
  return { memories: next, added };
};

export const removeMemory = async (userId, id) => {
  const next = (await loadMemories(userId)).filter(m => m.id !== id);
  await saveMemories(userId, next);
  return next;
};

/** Formats the enabled memories for the system prompt. */
export const formatMemories = (memories) => {
  const active = memories.filter(m => m.enabled !== false);
  if (active.length === 0) return '';

  const byKind = MEMORY_KINDS
    .map(kind => [kind, active.filter(m => m.kind === kind)])
    .filter(([, list]) => list.length > 0);

  const lines = byKind.map(([kind, list]) => (
    `${kind}:\n${list.map(m => `  - ${m.text}`).join('\n')}`
  ));

  return [
    '[What you already know about this user]',
    ...lines,
    'Use these when they are relevant. Do not recite them back unprompted,',
    'and prefer anything said in this conversation if it contradicts them.',
  ].join('\n');
};

/** The JSON shape the extraction pass is constrained to. */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: MEMORY_KINDS },
        },
        required: ['text', 'kind'],
      },
    },
  },
  required: ['memories'],
};

export const EXTRACTION_PROMPT = [
  'Read the conversation below and pull out durable facts about the user that',
  'would still be useful in an unrelated conversation weeks from now.',
  '',
  'Record: who they are, what they are working on, stated preferences about how',
  'they want to be helped, and their tools or environment.',
  '',
  'Do NOT record: the topic of this conversation, anything the assistant said',
  'about itself, one-off questions, transient state, or anything you inferred',
  'rather than were told.',
  '',
  'Write each as one short standalone sentence in the third person, starting',
  'with "The user". Return an empty array when nothing qualifies — that is the',
  'normal outcome for most conversations.',
].join('\n');

/**
 * Runs the extraction pass against Ollama. `format` pins the reply to the
 * schema, so no output parsing guesswork is needed.
 */
export const extractMemories = async (transcript, model, { signal } = {}) => {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: EXTRACTION_SCHEMA,
      messages: [{ role: 'user', content: `${EXTRACTION_PROMPT}\n\n---\n${transcript}` }],
      options: { temperature: 0.2, num_predict: 400 },
    }),
  });

  if (!res.ok) throw new Error(`Extraction failed (HTTP ${res.status})`);
  const data = await res.json();

  let parsed;
  try {
    parsed = JSON.parse(decodeByteFallback(data.message?.content || '{}'));
  } catch (e) {
    throw new Error('The model did not return valid JSON');
  }

  return Array.isArray(parsed.memories) ? parsed.memories : [];
};
