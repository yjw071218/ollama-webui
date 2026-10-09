// agy has independent quota pools. Unknown/legacy provider-wide errors must
// not turn a different model family into an exhausted one.
export const agyQuotaGroup = name => /gemini/i.test(String(name)) ? 'gemini'
  : /claude|gpt|anthropic|^3p(?:[-_]|$)|third.?party/i.test(String(name)) ? 'claude-gpt' : null;
// agy names its Claude/GPT windows "3p-5h", "3p-weekly" (third-party); the
// model picker matched only "claude|gpt" and dropped them, so the badge read
// "—" while Settings, which shows every window, had them.
export function agyQuotaForModel(entry, model, now = Date.now()) {
  if (!entry) return entry;
  const group = agyQuotaGroup(model);
  const windows = (entry.windows || []).filter(w => group && agyQuotaGroup(w.group || w.id) === group)
    .map(w => w.resetsAt && w.resetsAt <= now ? {...w, usedPercent:0, reset:true} : w);
  const error = group && entry.poolErrors?.[group];
  const until = error?.resetsAt || (Number(error?.updatedAt) + 15 * 60000);
  const newerMeasurement = windows.length && Number(entry.updatedAt) > Number(error?.updatedAt)
    && entry.source !== 'error';
  const rejected = windows.some(w => !w.reset && w.usedPercent >= 100)
    || !!(error && until > now && !newerMeasurement);
  return {...entry, windows, status: rejected ? 'rejected'
    : windows.length ? (windows.some(w=>w.usedPercent >= 80) ? 'allowed_warning':'allowed') : 'unknown',
    lastError: rejected ? error?.message : undefined,
    resetsAt: rejected && error && !newerMeasurement ? until : undefined,
    quotaGroup: group};
}
