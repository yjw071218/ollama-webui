export const isLocalOllama = db => db.aiModel === 'ollama-hosted'
  && db.ollamaModelSource !== 'cloud'
  && !!db.ollamaModel
  && !/^(?:agy|claude-code|codex):/i.test(db.ollamaModel)
  && !/(?:[:/-])cloud(?:$|[:/-])/i.test(db.ollamaModel);
export const fastGeneration = db => isLocalOllama(db) && db.webuiFastGeneration !== false;

/* What a model answered by a coding CLI can actually take (server/cliModels.js).
   A preset's maxContext was written for whatever API it was made for; the
   CLI's own window is the real ceiling. */
const CLI_WINDOWS = { 'claude-code': 200000, codex: 200000, agy: 1000000 };
export const cliWindow = db => {
  const m = /^(agy|claude-code|codex):/i.exec(String(db?.ollamaModel || ''));
  return m && db.aiModel === 'ollama-hosted' ? CLI_WINDOWS[m[1].toLowerCase()] : 0;
};

/* A budget raised for this one request, because the prompt RisuAI cannot drop
   -- card, preset, lorebook -- did not fit in it. Reset when each request
   starts (startBudget); read by contextBudget, so Ollama's num_ctx follows. */
let lifted = 0;

export const contextBudget = db => {
  const base = fastGeneration(db) ? Math.min(Number(db.maxContext) || 32768, 32768) : db.maxContext;
  return lifted > Number(base || 0) ? lifted : base;
};
export const responseBudget = db => fastGeneration(db) ? Math.min(Number(db.maxResponse) || 2048, 2048) : db.maxResponse;

/** The budget for a new request, with nothing lifted from the last one. */
export const startBudget = db => { lifted = 0; return contextBudget(db); };

/**
 * The budget when the prompt that cannot be dropped needs `mandatory` tokens.
 *
 * RisuAI drops the oldest messages until the prompt fits, and when only the
 * last one is left and it still does not fit, it refuses the request ("the
 * minimum tokens required are more than the maximum"). A long card and
 * lorebook did that after a handful of turns -- under a ceiling this app set,
 * not one the model has:
 *
 *   - fast generation caps a local model at 32,768 for speed; the preset's own
 *     maxContext is what the reader actually chose, so up to that;
 *   - a CLI model gets the preset's maxContext, written for some API; the
 *     CLI's own window is the real limit.
 *
 * It is raised to fit the mandatory part plus room for history (the preset's
 * budget for a CLI, at most 8,192 for a local model, whose memory the budget
 * really is), never past that ceiling. A local model with fast generation off
 * keeps exactly what the reader set, and still refuses when it does not fit.
 */
export const liftBudget = (db, mandatory, budget) => {
  const current = Number(budget) || 0;
  if (!(mandatory > current * 0.8)) return budget;
  const cli = cliWindow(db);
  const ceiling = cli || (fastGeneration(db) ? Number(db.maxContext) || 0 : 0);
  if (!ceiling) return budget;
  const room = cli ? Math.max(current, 8192) : Math.min(current, 8192);
  const wanted = Math.min(ceiling, Math.ceil(mandatory + room + (Number(responseBudget(db)) || 0)));
  if (wanted <= current) return budget;
  lifted = wanted;
  return wanted;
};
