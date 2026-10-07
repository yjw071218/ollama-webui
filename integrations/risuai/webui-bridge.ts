import { getDatabase, importPreset } from './ts/storage/database.svelte';
import { importCharacterProcess } from './ts/characterCards';
import { readModule } from './ts/process/modules';
import { DBState, settingsOpen, SettingsMenuIndex, sideBarStore, sideBarClosing, ReloadGUIPointer } from './ts/stores.svelte';
import { get } from 'svelte/store';
import { checkCharOrder } from './ts/globalApi.svelte';
import { alertStore } from './ts/alert';
import { changeLanguage } from './lang';
import { changeChar } from './ts/characters';
import { ensureLocalModel } from './webui-local-model.js';
import { startWebUISync } from './webui-sync';
import { isLocalOllama } from './webui-performance.js';

const send = (data: object) => window.parent.postMessage({ channel: 'webui-risu', ...data }, location.origin);
export async function initializeWebUI() {
  const db = getDatabase();
  const initializeFastMode = (db as any).webuiFastGeneration === undefined;
  if (initializeFastMode) {
    (db as any).webuiFastGeneration = true;
  }
  const query = new URLSearchParams(location.search);
  if (!db.didFirstSetup) {
    db.didFirstSetup = true;
    db.language = 'ko';
    changeLanguage('ko');
  }
  let busy = false;
  let sync: ReturnType<typeof startWebUISync>;
  window.addEventListener('message', async event => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.channel !== 'webui-risu') return;
    const { action, id } = event.data;
    if (event.data.session) (window as any).__WEBUI_SESSION__ = event.data.session;
    if (action === 'session') {
      sync ||= startWebUISync(() => busy);
      send({ thinkingState: true, hidden: !!(getDatabase() as any).webuiHideThinking });
      return;
    }
    /* The toolbar's 사고과정 switch: thought blocks shown or left out of every
       message on screen (the saved messages keep them). */
    if (action === 'thinking') {
      const db = getDatabase() as any;
      if (typeof event.data.hidden === 'boolean') db.webuiHideThinking = event.data.hidden;
      ReloadGUIPointer.update(v => v + 1);
      send({ thinkingState: true, hidden: !!db.webuiHideThinking });
      return;
    }
    if (action === 'sync') { sync?.run(); return; }
    if (action === 'characters') {
      const open = !get(sideBarStore);
      sideBarClosing.set(false);
      sideBarStore.set(open);
      return;
    }
    if (action === 'settings') {
      SettingsMenuIndex.set(1);
      settingsOpen.set(true);
      send({ id, ok: true, message: '모델 · 프리셋 설정을 열었습니다.' });
      return;
    }
    if (action === 'connect') {
      try {
        const model = await ensureLocalModel(getDatabase(), event.data.model);
        send({ id, ok: true, message: `${model} · Ollama 로컬 모델 자동 연결` });
      } catch (error) { send({ id, ok: false, message: String(error.message || error) }); }
      return;
    }
    if (action !== 'import') return;
    if (busy) { send({ id, ok: false, message: '이전 파일을 가져오는 중입니다.' }); return; }
    busy = true;
    try {
      const file = event.data.file;
      if (!(file instanceof File)) throw new Error('파일을 읽을 수 없습니다.');
      const name = file.name.toLowerCase();
      if (/\.(risup|risupreset|preset)$/.test(name)) {
        const count = getDatabase().botPresets.length;
        await importPreset({ name, data: new Uint8Array(await file.arrayBuffer()) });
        if (getDatabase().botPresets.length <= count) throw new Error('프리셋을 가져오지 못했습니다.');
        SettingsMenuIndex.set(1);
        settingsOpen.set(true);
      } else if (name.endsWith('.risum')) {
        const module = await readModule(Buffer.from(await file.arrayBuffer()));
        if (!module) throw new Error('모듈을 가져오지 못했습니다.');
        module.id = crypto.randomUUID();
        DBState.db.modules.push(module);
        SettingsMenuIndex.set(14);
        settingsOpen.set(true);
      } else if (/\.(charx|png|jpg|jpeg|json)$/.test(name)) {
        const before = getDatabase().characters.length;
        await importCharacterProcess({ name, data: file });
        const after = getDatabase().characters.length;
        if (after <= before) throw new Error('캐릭터를 가져오지 못했습니다. RisuAI의 오류 내용을 확인하세요.');
        checkCharOrder();
        settingsOpen.set(false);
        await changeChar(after - 1);
        alertStore.set({ type: 'none', msg: '' });
      } else throw new Error('지원하지 않는 파일 확장자입니다.');
      send({ id, ok: true, message: `${file.name}: 가져왔습니다.` });
    } catch (error) {
      send({ id, ok: false, message: String(error instanceof Error ? error.message : error) });
    } finally { busy = false; }
  });
  // A missing/stopped Ollama must not prevent importing or editing characters.
  try { await ensureLocalModel(db, localStorage.getItem('last-ollama-model') || db.ollamaModel || query.get('model') || ''); } catch { /* modelState reports the error */ }
  if (initializeFastMode && isLocalOllama(db)) db.useStreaming = true;
}
