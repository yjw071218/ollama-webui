import { useEffect, useRef, useState } from 'react';
import { Upload, Cpu, RefreshCcw, HelpCircle, SlidersHorizontal, PanelLeft, Brain } from 'lucide-react';
import './risuai.css';
import embedCss from './risuEmbed.css?raw';
import { currentTabSession, currentCsrfToken } from './session.jsx';

const sessionInfo = () => ({ id: currentTabSession(), csrf: currentCsrfToken() });
/* RisuAI's own terms screen comes up inside the frame on first use, before it
   says `ready`; covering the frame then would wait forever. Its answer is kept
   in the frame's (account-scoped) localStorage, which this page shares. */
const termsAccepted = (scope) => {
  try { return localStorage.getItem(`webui-risu:${encodeURIComponent(scope || 'guest')}:tos4`) === 'true'; } catch { return false; }
};
// The states after which there is nothing more to wait for.
const SETTLED = new Set(['synced', 'guest', 'error']);

export function RisuPanel({ scope, model, picked, onPick }) {
  const frame = useRef(null);
  const input = useRef(null);
  const pending = useRef(new Map());
  const [installed, setInstalled] = useState(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('RisuAI를 불러오는 중입니다…');
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [localModel, setLocalModel] = useState('');
  const [localModels, setLocalModels] = useState([]);
  const [modelError, setModelError] = useState('');
  /* The model bridge answers long before RisuAI reports `ready` -- that waits
     for the whole app to boot and for the terms dialog to be accepted, and a
     boot that stalls or a dialog still open never sends it. Gating the model
     picker on `ready` left it greyed out with every model already listed. The
     first model report is proof enough that `connect` will be heard. */
  const [bridge, setBridge] = useState(false);
  const [sync, setSync] = useState({ state: 'waiting', message: '동기화 연결 대기 중' });
  /* RisuAI stays covered until the first sync has finished, so what shows is
     what is on the server -- not this device's older copy, replaced a moment
     later. `firstSync` ends on the first settled state; `skipSync` is the
     reader not wanting to wait. */
  const [firstSync, setFirstSync] = useState(false);
  const [skipSync, setSkipSync] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);
  const [canSkip, setCanSkip] = useState(false);
  const [thinkingHidden, setThinkingHidden] = useState(null);
  // Changing the chat's model must not reload a live roleplay conversation.
  const [initialModel] = useState(model || '');
  const lastPick = useRef(picked);
  // The message listener is registered once; the handler it calls is current.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  useEffect(() => {
    const controller = new AbortController();
    fetch('/risuai/status', { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }).then(data => setInstalled(data.installed)).catch(e => {
      if (e.name !== 'AbortError') { setInstalled(false); setStatus(e.message); }
    });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    const requests = pending.current;
    const receive = event => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== 'webui-risu') return;
      if (event.data.syncState) {
        setSync({ state: event.data.syncState, message: event.data.syncMessage });
        setSyncProgress(event.data.syncProgress || null);
        if (SETTLED.has(event.data.syncState)) setFirstSync(true);
        return;
      }
      if (event.data.thinkingState) { setThinkingHidden(!!event.data.hidden); return; }
      if (event.data.modelState) {
        setBridge(true);
        setLocalModel(event.data.model || '');
        setLocalModels(event.data.models || []);
        setModelError(event.data.error || '');
        // Chosen in one of RisuAI's own model pickers: the WebUI follows.
        if (event.data.picked && event.data.model && !event.data.error) onPickRef.current?.(event.data.model);
        return;
      }
      if (event.data.openImport) { input.current?.click(); return; }
      if (event.data.ready) {
        frame.current.contentWindow.postMessage({ channel: 'webui-risu', action: 'session', session: sessionInfo() }, location.origin);
        setReady(true); setStatus(''); return;
      }
      const resolve = requests.get(event.data.id);
      if (resolve) { requests.delete(event.data.id); resolve(event.data); }
    };
    window.addEventListener('message', receive);
    const timer = setTimeout(() => setStatus(current => current.includes('불러오는 중') ? '로딩이 오래 걸리고 있습니다. 잠시 후에도 화면이 나오지 않으면 다시 불러오기를 눌러 주세요.' : current), 60000);
    return () => {
      window.removeEventListener('message', receive);
      clearTimeout(timer);
      for (const resolve of requests.values()) resolve({ ok: false, message: '화면이 닫혔습니다.' });
      requests.clear();
    };
  }, []);
  /* Only a model the reader picked in the WebUI by hand is passed on. `model`
     also changes by itself -- opening another conversation restores that
     chat's last model, routing chooses one per message -- and forwarding those
     put back the model just chosen in the toolbar below. */
  useEffect(() => {
    if (!bridge || !picked) return;
    if (lastPick.current === picked) return;
    lastPick.current = picked;
    frame.current?.contentWindow.postMessage({ channel: 'webui-risu', action: 'connect', model: picked.name, session: sessionInfo() }, location.origin);
  }, [picked, bridge]);
  /* "기다리지 않고 열기" after a few seconds, for a sync that is slow (a big
     asset library on mobile data) or stuck. */
  const waitingForSync = installed && !skipSync && !firstSync && (ready || termsAccepted(scope));
  useEffect(() => {
    if (!waitingForSync) { setCanSkip(false); return undefined; }
    const timer = setTimeout(() => setCanSkip(true), 5000);
    return () => clearTimeout(timer);
  }, [waitingForSync, reload]);
  const request = payload => new Promise(resolve => {
    const id = crypto.randomUUID();
    pending.current.set(id, resolve);
    frame.current.contentWindow.postMessage({ channel: 'webui-risu', id, session: sessionInfo(), ...payload }, location.origin);
  });
  const report = result => { setStatus(result.message); setError(!result.ok); };
  const importFiles = async files => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      for (const file of files) {
        setError(false);
        setStatus(`${file.name}: 에셋과 설정을 가져오는 중…`);
        const result = await request({ action: 'import', file });
        report(result);
        if (!result.ok) break;
      }
    } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  /* The frame is same-origin: once it loads, the WebUI hands it the stylesheet
     that makes RisuAI's chrome look like part of this app. */
  const dress = () => {
    setLoaded(true);
    // The page is up; "loading" would now only be waiting on the terms dialog.
    setStatus(current => current.includes('불러오는 중') ? '' : current);
    try {
      const doc = frame.current?.contentDocument;
      if (!doc || doc.getElementById('webui-embed')) return;
      const style = doc.createElement('style');
      style.id = 'webui-embed';
      style.textContent = embedCss;
      doc.head.append(style);
    } catch { /* a frame we may not touch keeps RisuAI's own look */ }
  };
  return <section className="risu-panel" aria-label="RisuAI 상황극">
    <div className="risu-toolbar">
      <div className={`risu-model${modelError ? ' is-error' : ''}`} title={modelError || '상황극 모델 · Ollama 로컬 · 마지막 선택 자동 저장'}><Cpu size={14} /><select aria-label="상황극 로컬 모델" value={localModel} disabled={!bridge || busy || !localModels.length} onChange={async event => {
        /* One model for the whole app: a pick here is also a pick at the top.
           Two selectors that could disagree read as this one not working --
           the header kept showing the old model after the change. */
        const name = event.target.value;
        const result = await request({ action: 'connect', model: name });
        report(result);
        if (result.ok) onPick?.(name);
      }}>{!localModel && <option value="">{modelError ? 'Ollama 연결 필요' : '모델 확인 중…'}</option>}{localModels.map(name => <option key={name} value={name}>{name}</option>)}</select></div>
      {/* Sync used to take a whole row of its own under the toolbar for one
          sentence; it is a status, so it sits with the other statuses. */}
      <span className={`risu-sync risu-sync-${sync.state}`} role="status" title={sync.message}><i aria-hidden="true" /><span>{sync.message}</span></span>
      <button className="risu-import" type="button" disabled={!ready || busy} onClick={() => input.current.click()}><Upload size={15} /> 파일 가져오기</button>
      <button type="button" disabled={!ready || busy} title="캐릭터 패널 열기/닫기" aria-label="캐릭터 패널" onClick={() => frame.current?.contentWindow.postMessage({ channel: 'webui-risu', action: 'characters' }, location.origin)}><PanelLeft size={15} /> 캐릭터</button>
      <input ref={input} hidden type="file" multiple accept=".charx,.png,.jpg,.jpeg,.json,.risup,.risupreset,.preset,.risum" onChange={event => importFiles([...event.target.files])} />
      <button type="button" className={`risu-thinking${thinkingHidden === false ? ' is-on' : ''}`} disabled={!ready || thinkingHidden === null}
        aria-pressed={thinkingHidden === false} title={thinkingHidden ? '사고과정 보이기' : '사고과정 숨기기'}
        onClick={() => frame.current?.contentWindow.postMessage({ channel: 'webui-risu', action: 'thinking', hidden: !thinkingHidden }, location.origin)}>
        <Brain size={15} /> 사고과정 {thinkingHidden ? '끔' : '켬'}</button>
      <button type="button" disabled={!ready || busy} title="설정 · 프리셋" aria-label="설정 · 프리셋" onClick={async () => report(await request({ action: 'settings' }))}><SlidersHorizontal size={15} /> 설정 · 프리셋</button>
      <button className="risu-icon-button" type="button" disabled={busy} title="다시 불러오기" aria-label="RisuAI 다시 불러오기" onClick={() => { setReady(false); setBridge(false); setLoaded(false); setFirstSync(false); setSkipSync(false); setSyncProgress(null); setStatus('RisuAI를 불러오는 중입니다…'); setReload(value => value + 1); }}><RefreshCcw size={15} /></button>
      <details><summary aria-label="사용 안내"><HelpCircle size={17} /></summary><div className="risu-help"><p>CHARX·PNG·JSON 캐릭터 카드, RISUP·RISUPRESET 프리셋, RISUM 모듈을 가져올 수 있습니다. 프리셋은 가져온 뒤 설정에서 선택하세요.</p><p>Ollama에 설치된 로컬 대화 모델을 자동으로 연결합니다. WebUI에서 선택한 모델이 로컬에 있으면 우선 사용하며, 프리셋을 바꿔도 로컬 연결을 유지합니다.</p><p>같은 WebUI 서버와 계정으로 로그인하면 캐릭터·에셋·대화를 기기 간 동기화합니다. 먼저 PC에서 동기화됨을 확인한 뒤 모바일에서 열어 주세요. 게스트 데이터는 이 기기에만 저장됩니다.</p><p><a href="https://github.com/kwaroran/Risuai" target="_blank" rel="noreferrer">RisuAI 원본</a> · <a href="/risuai/LICENSE.txt" target="_blank" rel="noreferrer">라이선스</a></p></div></details>
    </div>
    {(modelError || (status && (loaded || installed === false))) && <p className={`risu-status${error || modelError ? ' is-error' : ''}`} role="status">{modelError || status}</p>}
    {installed === false
      ? <div className="risu-install"><p>RisuAI 빌드가 준비되지 않았습니다.</p><code>npm run risu:setup</code><p>설치 후 다시 불러오기를 눌러 주세요.</p></div>
      : <div className="risu-stage">
        {installed && <iframe key={reload} ref={frame} onLoad={dress} title="RisuAI 캐릭터 상황극" src={`/risuai/?scope=${encodeURIComponent(scope || 'guest')}&model=${encodeURIComponent(initialModel)}`} allow="clipboard-read; clipboard-write; fullscreen" />}
        {/* Until the frame has loaded there was a blank panel. The cover
            lifts on the frame's load, not on `ready`: `ready` waits for the
            terms dialog, and covering that dialog would wait forever. */}
        {!loaded && <div className="risu-loading" role="status"><RefreshCcw className="spin" size={18} /><span>{status || 'RisuAI를 불러오는 중입니다…'}</span></div>}
        {loaded && waitingForSync && <div className="risu-loading risu-sync-cover" role="status" aria-live="polite">
          <RefreshCcw className="spin" size={18} />
          <strong>동기화하는 중입니다</strong>
          <span>{sync.state === 'waiting' ? '동기화 서버에 연결하는 중…' : sync.message}</span>
          {syncProgress?.total > 0 && <div className="risu-sync-bar" role="progressbar" aria-valuemin={0} aria-valuemax={syncProgress.total} aria-valuenow={syncProgress.done}>
            <i style={{ width: `${Math.min(100, Math.round(syncProgress.done / syncProgress.total * 100))}%` }} />
          </div>}
          {syncProgress?.total > 0 && <small>{Math.min(100, Math.round(syncProgress.done / syncProgress.total * 100))}%</small>}
          {canSkip && <button type="button" onClick={() => setSkipSync(true)}>기다리지 않고 열기</button>}
        </div>}
      </div>}
  </section>;
}
