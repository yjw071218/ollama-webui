// Shared by startup, preset changes and generation: no provider credentials or
// cloud fallback can be inherited from an imported roleplay preset.
// The one exception is a model answered by a coding CLI signed in on this
// machine (server/cliModels.js): it is remote, but chosen on purpose in the
// WebUI and paid for by the reader's own subscription, not by a preset.
const viaCli = model => model.details?.format === 'cli';
export const localChatModels = models => (Array.isArray(models) ? models : []).filter(model => {
  const name = String(model.name || model.model || '');
  const families = [model.details?.family, ...(model.details?.families || [])].join(' ');
  return name && (viaCli(model) || (!model.remote_model && !model.remote_host && !/(?:[:/-])cloud(?:$|[:/-])/i.test(name)))
    && !/embed|rerank|bert|clip/i.test(name + ' ' + families)
    && (!Array.isArray(model.capabilities) || model.capabilities.includes('completion'));
});
export function chooseLocalModel(models, preferred, previous) {
  const names = localChatModels(models).map(model => model.name || model.model);
  return names.find(name => name === preferred) || names.find(name => name === previous) || names[0] || '';
}

let selected = '';
let preferred = '';
let available = [];
let checkedAt = 0;
let loading;
/* Everyone who shows the model: the host toolbar, by message, and RisuAI's
   own model pickers, by subscription (src/WebUIModelList.svelte). `picked`
   says the change was made inside RisuAI, so the host moves its selector too. */
const listeners = new Set();
const snapshot = error => ({ model: selected, models: available.map(model => model.name || model.model), error: error || '' });
const announce = (error, picked = false) => {
  const state = snapshot(error);
  window.parent.postMessage({ channel: 'webui-risu', modelState: true, picked, ...state }, location.origin);
  for (const listener of listeners) { try { listener(state); } catch { /* one view is not the others' problem */ } }
};
export function subscribeLocalModel(listener) {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export function pinLocalModel(db) {
  db.aiModel = 'ollama-hosted';
  db.subModel = 'ollama-hosted';
  db.ollamaModelSource = 'local';
  db.ollamaURL = location.origin + '/risuai/ollama';
  db.ollamaModel = selected;
  // RisuAI shows this label in place of the model when it is set; left over
  // from an imported preset, it named a model that was no longer in use.
  db.ollamaModelName = '';
  db.seperateModelsForAxModels = false;
  return db;
}

export function applySyncedLocalModel(db) {
  selected = chooseLocalModel(available, db.ollamaModel, selected);
  preferred = selected;
  pinLocalModel(db);
  if (selected) localStorage.setItem('last-ollama-model', selected);
  announce('');
}

export async function ensureLocalModel(db, requested, { picked = false } = {}) {
  if (requested !== undefined) preferred = String(requested || '');
  if (!checkedAt || Date.now() - checkedAt > 30000) {
    loading ||= (async () => {
      const response = await fetch('/risuai/ollama/api/tags', { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Ollama에 연결할 수 없습니다. Ollama 실행 상태를 확인해 주세요.');
      available = localChatModels((await response.json()).models);
      checkedAt = Date.now();
    })().finally(() => { loading = null; });
    try { await loading; } catch (error) {
      selected = ''; checkedAt = 0; pinLocalModel(db); announce(error.message); throw error;
    }
  }
  selected = chooseLocalModel(available, preferred, selected || db.ollamaModel);
  pinLocalModel(db);
  if (!selected) {
    const message = '설치된 Ollama 대화 모델이 없습니다. 로컬 모델을 설치한 뒤 다시 불러와 주세요.';
    announce(message); throw new Error(message);
  }
  localStorage.setItem('last-ollama-model', selected);
  announce('', picked);
  return selected;
}
