/**
 * Servers connected to before, newest first, for the address screen.
 * Only addresses are kept (normalised origins), never anything signed in.
 */
export const MAX_RECENT = 6;

export const addRecent = (list, server, max = MAX_RECENT) =>
  [server, ...(Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && s !== server)].filter(Boolean).slice(0, max);

export const forgetRecent = (list, server) => (Array.isArray(list) ? list : []).filter(s => s !== server);
