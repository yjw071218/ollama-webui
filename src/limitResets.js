export const settleResets = (entry = {}, now = Date.now()) => {
  const windows = (entry.windows || []).map(w => (
    Number.isFinite(w.resetsAt) && w.resetsAt <= now ? { ...w, usedPercent: 0, reset: true, forecast: undefined } : w));
  if (entry.status !== 'rejected') return { ...entry, windows };
  const heard = Number(entry.updatedAt) || 0;
  // A full window that has reset is what the refusal was about; any other
  // window counts only if it reset after the refusal was heard.
  const resetSince = windows.some((w, i) => w.reset
    && ((entry.windows[i]?.usedPercent >= 100) || w.resetsAt > heard))
    || (Number.isFinite(entry.resetsAt) && entry.resetsAt <= now && entry.resetsAt > heard);
  const stillFull = windows.some(w => !w.reset && w.usedPercent >= 100)
    || (Number.isFinite(entry.resetsAt) && entry.resetsAt > now);
  if (!resetSince || stillFull) return { ...entry, windows };
  const warning = windows.some(w => !w.reset && w.usedPercent >= 80);
  return { ...entry, windows, status: warning ? 'allowed_warning' : 'allowed' };
};
