// Regenerating used to throw the previous answer away. Local models are slow
// enough that losing a good answer to a worse one is genuinely annoying, so
// every regeneration is kept and the message gets a pager to move between them.

let counter = 0;
const nextId = () => `v${Date.now().toString(36)}${(counter++).toString(36)}`;

// A variant is the part of a message that regeneration actually replaces.
// Everything else on the message (role, attachments, star) is shared.
export const asVariant = (message = {}) => ({
  id: message.variantId || nextId(),
  content: message.content ?? '',
  metrics: message.metrics ?? null,
  model: message.model ?? null,
  at: message.at ?? null,
});

export const variantsOf = (message) => {
  const list = message?.variants;
  return Array.isArray(list) && list.length > 0 ? list : [asVariant(message || {})];
};

export const variantCount = (message) => variantsOf(message).length;

// Clamped rather than wrapped: an index left over from a deleted variant should
// land on a real answer instead of silently jumping to the other end.
export const variantIndexOf = (message) => {
  const total = variantCount(message);
  const raw = Number.isInteger(message?.variantIndex) ? message.variantIndex : total - 1;
  return Math.min(Math.max(raw, 0), total - 1);
};

export const hasVariants = (message) => variantCount(message) > 1;

// Called when a regeneration finishes: the answer just produced joins the ones
// already there and becomes the one on show.
export const appendVariant = (message, produced) => {
  const history = variantsOf(message);
  const variants = [...history, asVariant(produced)];
  const index = variants.length - 1;
  return { ...message, ...stripVariantFields(variants[index]), variants, variantIndex: index };
};

export const selectVariant = (message, index) => {
  const variants = variantsOf(message);
  const clamped = Math.min(Math.max(index, 0), variants.length - 1);
  return { ...message, ...stripVariantFields(variants[clamped]), variants, variantIndex: clamped };
};

export const removeVariant = (message, index) => {
  const variants = variantsOf(message);
  if (variants.length <= 1) return message;   // the last answer is the message
  const kept = variants.filter((_, i) => i !== index);
  const next = Math.min(variantIndexOf(message), kept.length - 1);
  return { ...message, ...stripVariantFields(kept[next]), variants: kept, variantIndex: next };
};

// `id` names the variant, not the message, so it must not leak onto the message
// itself — it would collide with the session/message ids used everywhere else.
const stripVariantFields = (variant) => ({
  content: variant.content,
  metrics: variant.metrics,
  model: variant.model,
  variantId: variant.id,
});
