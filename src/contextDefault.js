/**
 * How much context a chat gets, and why the old number was wrong.
 *
 * ## What went wrong
 *
 * The default was 4096 tokens of context and 4096 of answer budget. Both dated
 * from before reasoning models: a model that answers straight away spends its
 * budget on the answer, and 4096 was generous.
 *
 * A thinking model spends one to two and a half thousand tokens *before it
 * writes a word*. Measured here, asking qwen3.6:35b-a3b for a long description
 * in Korean:
 *
 *     num_ctx  4096   done_reason "length"   4032 tokens generated
 *     num_ctx 16384   done_reason "stop"     3499 tokens generated
 *
 * The same question, the same model, the same answer budget — and at 4096 the
 * answer stops in the middle of a sentence, because the thinking and the answer
 * share one ceiling and together they do not fit under it.
 *
 * ## Why not simply a bigger number for everyone, always
 *
 * Because context is not free: Ollama allocates a KV cache for the size it is
 * given, and a cache that does not fit in VRAM pushes layers back onto the CPU.
 * That is the reason `num_ctx` is pinned at all — see `helperOptions` — so the
 * new number had to be measured rather than picked. On this machine, same
 * model, same question:
 *
 *     num_ctx  4096   62.0 tok/s
 *     num_ctx  8192   62.9 tok/s
 *     num_ctx 16384   61.4 tok/s
 *     num_ctx 32768   58.9 tok/s
 *
 * Flat to 16384 and only then starting to cost something. So 16384 is the
 * largest size that is free here, and it is the default.
 *
 * ## Why existing installs are moved too
 *
 * A default only helps somebody installing today. Everybody else has 4096
 * written into their settings from their first run — not chosen, just
 * persisted — and would keep getting cut-off answers for ever.
 *
 * So a value that is *exactly* the old default is raised once, and anything
 * else is left alone: a person who typed 4096 deliberately still has 4096, and
 * a person who typed 2048 because their card is small is not overruled. The
 * one-time flag is what stops it happening again after they change it back.
 */

/** What a fresh install gets. */
export const DEFAULT_NUM_CTX = 16384;
export const DEFAULT_MAX_TOKENS = 8192;

/** What it used to get, and what therefore counts as "never chosen". */
export const OLD_NUM_CTX = 4096;
export const OLD_MAX_TOKENS = 4096;

export const MIGRATION_KEY = 'ctxDefaultsRaised';

/**
 * The value to use, given what is stored.
 *
 * Pure, and returns the reason as well as the number, so the caller can say
 * what it did rather than silently changing somebody's settings.
 */
export const raiseIfUntouched = (stored, { oldDefault, newDefault, alreadyDone }) => {
  const value = stored === null || stored === '' ? null : Number(stored);

  // Nothing stored: a fresh profile, which simply gets the new default.
  if (value === null || !Number.isFinite(value)) return { value: newDefault, changed: false };
  // Already raised once. Whatever is there now is what they want.
  if (alreadyDone) return { value, changed: false };
  // Exactly the old default, and never raised: raise it.
  if (value === oldDefault) return { value: newDefault, changed: true };
  // Anything else was a decision.
  return { value, changed: false };
};
