/**
 * When a subscription is used up, another model answers instead.
 *
 * A CLI model over its limit used to fail the turn with the CLI's own words
 * ("You've hit your limit · resets 3pm"), and the reader picked another model
 * and asked again. `CLI_FALLBACK` is that choice made in advance:
 *
 *     CLI_FALLBACK=codex:gpt-5.5,agy:gemini-3.1-pro-high,qwen3:32b
 *
 * A CLI known to be over its limit -- it said so, with a reset time still
 * ahead -- is not even started; one that refuses when asked is passed over
 * as long as it had not said anything yet. Anything that is not a CLI name is
 * a local model, and answers through Ollama or llama-server exactly as it
 * would have if picked.
 *
 * The answer says who wrote it (`answered_by` on the last frame), and the
 * browser shows it under the message: a reply from a different model than the
 * one picked is never passed off as the one picked.
 *
 * Only for a conversation. A comparison or an evaluation asks for one model
 * on purpose and sends `X-Cli-Fallback: off`.
 */

import { backendOf, callServer, toChatRequest, ChatTranslator, sseEvents } from './llamacpp.js';

const listOf = (value) => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

/** The models to try, in order: the one asked for, then the chain, once each. */
export const candidatesFor = (name, env = {}) => {
  const out = [String(name || '')];
  for (const next of listOf(env.CLI_FALLBACK)) if (!out.includes(next)) out.push(next);
  return out;
};

/* The words a CLI uses to say it is out of quota. */
export const LIMIT_ERROR = /usage limit|rate limit|quota|429|hit your limit|limit reached|resets? (at|in)|out of credits/i;
export const isLimitError = (message) => LIMIT_ERROR.test(String(message || ''));

/* Not installed, or would not start: the next model is as good an answer. */
export const isUnavailableError = (message) =>
  /was not found\. Install it|could not start|not signed in|please (log|sign) ?in|authenticat/i.test(String(message || ''));

/**
 * Whether a CLI is known to be over its limit right now, and until when.
 *
 * Only on its own say-so with a reset still ahead. A refusal with no reset
 * time is believed for fifteen minutes and then tried again: a CLI never
 * asked again would stay "over its limit" for ever.
 */
export const blockedUntil = (limits, now = Date.now()) => {
  if (!limits || limits.status !== 'rejected') return null;
  const times = [
    limits.resetsAt,
    ...(limits.windows || [])
      .filter(w => !w.reset && (w.usedPercent >= 100 || w.id === limits.binding))
      .map(w => w.resetsAt),
  ].filter(t => Number.isFinite(t) && t > now);
  if (times.length) return { until: Math.min(...times) };
  if (limits.updatedAt && now - limits.updatedAt < 15 * 60 * 1000) return { until: null };
  return null;
};

/* --------------------------------------------------------- a local model */

/**
 * One chat answer from the local backend, frame by frame, in Ollama's shape.
 * `onFrame` is called for every frame, the last one included; the promise
 * resolves with that last frame.
 */
export const streamLocal = async (env, body, { signal, onFrame }) => {
  if (backendOf(env) === 'llamacpp') {
    const base = (env.LLAMACPP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
    const upstream = await callServer(base, '/v1/chat/completions', {
      method: 'POST', body: toChatRequest(body, { stream: true }), signal,
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw new Error(`llama-server HTTP ${upstream.status}: ${detail.slice(0, 300)}`);
    }
    const translator = new ChatTranslator(body.model);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) buffer += '\n\n';
      const { events, rest } = sseEvents(buffer);
      buffer = rest;
      for (const event of events) if (!event.done) for (const frame of translator.accept(event.payload)) onFrame(frame);
      if (done) break;
    }
    const last = translator.finish();
    onFrame(last);
    return last;
  }

  const base = (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const upstream = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`Ollama HTTP ${upstream.status}: ${detail.slice(0, 300)}`);
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last = null;
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = done ? '' : (lines.pop() || '');
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.error) throw new Error(String(frame.error));
      onFrame(frame);
      if (frame.done) last = frame;
    }
    if (done) break;
  }
  return last || { done: true, done_reason: 'stop', message: { role: 'assistant', content: '' } };
};
