import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Check, AlertTriangle, Loader2, Download, RefreshCw } from 'lucide-react';
import { useI18n } from './i18n.jsx';

/* The newcomer's guide: a few cards shown on the first visit, with a skip
 * button on every one and a "show again" entry in Settings -> General.
 *
 * Step 2 is the semi-automatic part of setting up. It checks what a first
 * chat needs -- Ollama reachable, a chat model, the embedding model, and the
 * three coding CLIs (installed / signed in, via GET /cli/doctor) -- and offers
 * a one-click fix where one exists (pulling a model). The CLIs themselves are
 * installed and signed in by the launcher's first run (server/first-run.mjs),
 * because a sign-in needs a terminal on the PC; the card says how to redo it.
 *
 * Seen-state is per browser (localStorage), not per profile: the guide is
 * about this app, and somebody switching profiles has already met it. */

export const GUIDE_SEEN_KEY = 'ollama-webui:guide-seen';
export const GUIDE_VERSION = '1';
export const guideSeen = () => {
  // An automated browser (the UI tests) is not a newcomer; a modal over the
  // page would only cover what it is there to click.
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  try { return localStorage.getItem(GUIDE_SEEN_KEY) === GUIDE_VERSION; } catch { return true; }
};
const markSeen = () => { try { localStorage.setItem(GUIDE_SEEN_KEY, GUIDE_VERSION); } catch { /* private mode */ } };

const RECOMMENDED_CHAT = 'qwen3:8b';
const RECOMMENDED_EMBED = 'qwen3-embedding:0.6b';

const TEXT = {
  ko: {
    skip: '건너뛰기', back: '이전', next: '다음', done: '시작하기', close: '닫기',
    step: (i, n) => `${i} / ${n}`,
    s1t: 'Ollama WebUI에 오신 걸 환영해요',
    s1b: '내 PC에서 돌아가는 AI와 대화하고, 그림을 만들고, 코딩 CLI(Claude Code · Codex · Antigravity)까지 한곳에서 쓸 수 있어요. 1분이면 둘러볼 수 있어요.',
    s2t: '자동 점검',
    s2b: '처음 쓰는 데 필요한 것들을 확인했어요. 빠진 건 버튼 한 번으로 받을 수 있어요.',
    recheck: '다시 점검',
    ollama: 'Ollama 연결', ollamaOk: '연결됨', ollamaBad: 'Ollama가 꺼져 있거나 설치되지 않았어요. ollama.com에서 설치한 뒤 다시 점검하세요.',
    chat: '대화 모델', chatOk: (n) => `${n}개 설치됨`, chatBad: '대화할 모델이 없어요.',
    embed: '임베딩 모델 (긴 문서 참고용)', embedOk: '설치됨', embedBad: '없어도 되지만, 있으면 긴 첨부 파일을 더 잘 찾아 읽어요.',
    pull: (m) => `${m} 받기`, pulling: '받는 중',
    clis: '코딩 CLI',
    cliReady: '준비됨', cliNoLogin: '설치됨 · 로그인 필요', cliMissing: '설치 안 됨',
    cliHelp: 'CLI는 구독이 있을 때만 필요해요. 설치와 로그인은 PC에서 앱을 처음 켤 때 자동으로 진행돼요. 다시 하려면 PC에서 다음 명령을 실행하세요:',
    cliUnknown: '확인할 수 없었어요 (로그인한 관리자만 볼 수 있어요).',
    s3t: '대화하기',
    s3b: [
      '위쪽 모델 선택에서 쓸 모델을 고르세요. CLI 모델도 같은 목록에 있어요.',
      '파일은 대화 화면 어디에나 끌어다 놓으면 첨부돼요. 긴 파일은 그 대화에서만 자동으로 참고해요.',
      '/ 를 입력하면 명령 목록이, + 버튼에서 웹 검색·도구를 켜고 끌 수 있어요.',
    ],
    s4t: '스튜디오와 상황극',
    s4b: [
      '왼쪽 사이드바의 스튜디오에서 그림과 영상을 만들 수 있어요.',
      '상황극 탭은 캐릭터 대화용이에요. 로그인하면 PC와 휴대폰 사이에 동기화돼요.',
      '우측 상단 배지는 CLI 사용량이에요. 누르면 한도별로 자세히 보여요.',
    ],
    s6t: '로그인과 동기화',
    s6b: [
      '로그인하면 대화·설정·상황극이 계정에 저장돼서 PC와 휴대폰에서 똑같이 보여요.',
      'Google 버튼은 첫 실행 설정에서 키를 넣으면 생겨요. 없으면 아이디·비밀번호로 가입하면 돼요.',
      '항상 같은 주소(실행 창에 나온 nip.io 주소)로 접속하세요. 주소가 다르면 브라우저가 다른 사이트로 여겨서 로그인을 따로 해야 해요.',
    ],
    s7t: '코딩 CLI 활용',
    s7b: [
      'Claude Code·Codex·Antigravity 모델을 고르면 PC에 로그인된 구독으로 답해요. 추가 요금은 없어요.',
      '파일·폴더를 끌어다 놓으면 경로가 함께 전달돼서 CLI가 그 파일을 직접 열어 작업할 수 있어요.',
      '우측 상단 배지에서 한도가 초기화되기까지 남은 시간을 확인하세요.',
    ],
    s8t: '다른 PC로 옮기기',
    s8b: [
      '쓰던 PC의 앱 폴더에서 node server/setup-bundle.mjs export 를 실행하면 바탕 화면에 설정 파일이 생겨요.',
      '그 파일을 새 PC의 바탕 화면이나 다운로드 폴더에 두고 설치하면, 첫 실행에서 자동으로 찾아 그대로 가져와요.',
      '파일에는 접속 토큰과 API 키가 들어 있으니 옮긴 뒤 지우세요.',
    ],
    s9t: '알아 두면 좋은 것',
    s9b: [
      'Ctrl+K: 명령 팔레트 · Esc: 창 닫기',
      '긴 문서는 설정 → 지식에서 공용으로 올려 두면 모든 대화가 참고해요.',
      '설정 → 일반에서 언어·테마·애니메이션 줄이기를 바꿀 수 있어요.',
      '문제가 생기면 PC의 실행 창(검은 창) 메시지를 먼저 확인하세요.',
    ],
    s5t: '휴대폰에서 접속하기',
    s5b: [
      'PC 실행 창에 나온 주소(예: http://192.168.0.10:5173)를 같은 와이파이의 휴대폰에서 여세요.',
      '처음 실행할 때 정한 접속 토큰을 입력하면 돼요.',
      '집 밖에서 쓰려면 공유기에서 포트 5173을 포트포워딩하세요.',
    ],
    s5foot: '이 가이드는 설정 → 일반 → "초보자 가이드 다시 보기"에서 언제든 다시 열 수 있어요.',
  },
  en: {
    skip: 'Skip', back: 'Back', next: 'Next', done: 'Get started', close: 'Close',
    step: (i, n) => `${i} / ${n}`,
    s1t: 'Welcome to Ollama WebUI',
    s1b: 'Chat with AI running on your own PC, make pictures, and use the coding CLIs (Claude Code · Codex · Antigravity), all in one place. The tour takes a minute.',
    s2t: 'Automatic check',
    s2b: 'Here is what a first chat needs. Anything missing is one click away.',
    recheck: 'Check again',
    ollama: 'Ollama', ollamaOk: 'Connected', ollamaBad: 'Ollama is not running or not installed. Install it from ollama.com, then check again.',
    chat: 'Chat model', chatOk: (n) => `${n} installed`, chatBad: 'No model to chat with.',
    embed: 'Embedding model (for long documents)', embedOk: 'Installed', embedBad: 'Optional, but long attachments are read far better with it.',
    pull: (m) => `Get ${m}`, pulling: 'Downloading',
    clis: 'Coding CLIs',
    cliReady: 'Ready', cliNoLogin: 'Installed · sign-in needed', cliMissing: 'Not installed',
    cliHelp: 'The CLIs are only needed with a subscription. They are installed and signed in the first time the app starts on the PC. To redo it, run on the PC:',
    cliUnknown: 'Could not check (signed-in owner only).',
    s3t: 'Chatting',
    s3b: [
      'Pick a model at the top. CLI models are in the same list.',
      'Drop a file anywhere on the chat to attach it. Long files are referenced in that chat only.',
      'Type / for commands; the + button turns web search and tools on or off.',
    ],
    s4t: 'Studio and role-play',
    s4b: [
      'The Studio in the sidebar makes pictures and videos.',
      'The role-play tab is for character chats, synced between PC and phone when signed in.',
      'The badge at the top right is CLI usage; click it for each limit.',
    ],
    s6t: 'Signing in and sync',
    s6b: [
      'Signed in, your chats, settings and role-play live in your account and look the same on PC and phone.',
      'The Google button appears once its key is entered in the first-run setup; otherwise sign up with a username and password.',
      'Always use the same address (the nip.io one in the PC window): a different address is a different site to the browser, with its own login.',
    ],
    s7t: 'Using the coding CLIs',
    s7b: [
      'Pick a Claude Code, Codex or Antigravity model and it answers with the subscription signed in on the PC, at no extra cost.',
      'Dropped files and folders carry their path, so a CLI can open and work on them itself.',
      'The badge at the top right shows how long until each limit resets.',
    ],
    s8t: 'Moving to another PC',
    s8b: [
      'On the old PC, run node server/setup-bundle.mjs export in the app folder: a setup file appears on the Desktop.',
      'Put it on the new PC\'s Desktop or Downloads before installing; the first run finds it and imports it as is.',
      'It holds your access token and API keys, so delete it afterwards.',
    ],
    s9t: 'Good to know',
    s9b: [
      'Ctrl+K: command palette · Esc: close',
      'Long documents added under Settings → Knowledge are referenced by every chat.',
      'Settings → General changes language, theme and reduced motion.',
      'When something goes wrong, read the PC\'s launcher window first.',
    ],
    s5t: 'Using it from your phone',
    s5b: [
      'Open the address shown in the PC window (e.g. http://192.168.0.10:5173) on a phone on the same Wi-Fi.',
      'Enter the access token you chose on first run.',
      'From outside your home, forward port 5173 on your router.',
    ],
    s5foot: 'Open this guide again any time from Settings → General → "Show the beginner guide".',
  },
};

const Status = ({ state }) => (
  state === 'ok' ? <Check size={16} className="guide-ok" />
    : state === 'busy' ? <Loader2 size={16} className="spin" />
      : <AlertTriangle size={16} className="guide-warn" />
);

const useSetupCheck = (open, isEmbeddingModel) => {
  const [state, setState] = useState(null);
  const run = useCallback(async () => {
    setState(s => ({ ...(s || {}), busy: true }));
    let models = null;
    try {
      const res = await fetch('/api/tags', { cache: 'no-store' });
      if (res.ok) models = (await res.json()).models || [];
    } catch { /* unreachable */ }
    let clis = null;
    try {
      const res = await fetch('/cli/doctor', { cache: 'no-store' });
      const d = res.ok ? await res.json() : null;
      if (d?.success) clis = d.providers;
    } catch { /* not allowed or offline */ }
    setState({
      busy: false,
      ollama: models !== null,
      chat: (models || []).filter(m => !isEmbeddingModel(m)).length,
      embed: (models || []).some(m => isEmbeddingModel(m)),
      clis,
    });
  }, [isEmbeddingModel]);
  useEffect(() => { if (open) run(); }, [open, run]);
  return [state, run];
};

/* POST /api/pull, read to the end; percent as it goes. */
const pullModel = async (name, onPercent) => {
  const res = await fetch('/api/pull', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, model: name, stream: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = done ? '' : (lines.pop() || '');
    for (const line of lines) {
      if (!line.trim()) continue;
      let p; try { p = JSON.parse(line); } catch { continue; }
      if (p.error) throw new Error(p.error);
      if (p.total) onPercent(Math.min(100, Math.round(((p.completed || 0) / p.total) * 100)));
    }
    if (done) break;
  }
};

export const NewbieGuide = ({ open, onClose, isEmbeddingModel, onModelsChanged }) => {
  const { lang } = useI18n();
  const T = TEXT[String(lang).startsWith('ko') ? 'ko' : 'en'];
  const [step, setStep] = useState(0);
  const [pulling, setPulling] = useState({});
  const [check, recheck] = useSetupCheck(open && step === 1, isEmbeddingModel);

  useEffect(() => { if (open) setStep(0); }, [open]);

  const finish = useCallback(() => { markSeen(); onClose(); }, [onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') setStep(s => Math.min(s + 1, 8));
      else if (e.key === 'ArrowLeft') setStep(s => Math.max(s - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish]);

  if (!open) return null;

  const pull = async (name) => {
    setPulling(p => ({ ...p, [name]: 0 }));
    try {
      await pullModel(name, (pc) => setPulling(p => ({ ...p, [name]: pc })));
      onModelsChanged?.();
    } catch (e) {
      setPulling(p => ({ ...p, [name]: `! ${e.message}` }));
      return;
    }
    setPulling(p => { const n = { ...p }; delete n[name]; return n; });
    recheck();
  };
  const pullButton = (name) => {
    const st = pulling[name];
    if (typeof st === 'number') return <span className="guide-pulling">{T.pulling} {st}%</span>;
    return (
      <>
        <button type="button" className="guide-btn is-small" onClick={() => pull(name)}>
          <Download size={14} /> {T.pull(name)}
        </button>
        {typeof st === 'string' && <span className="guide-error">{st}</span>}
      </>
    );
  };

  const cliState = (c) => (c.installed && c.signedIn ? 'ok' : 'warn');
  const cliText = (c) => (!c.installed ? T.cliMissing : c.signedIn === false ? T.cliNoLogin : T.cliReady);

  const pages = [
    { title: T.s1t, body: <p>{T.s1b}</p> },
    {
      title: T.s2t,
      body: (
        <>
          <p>{T.s2b}</p>
          {!check || (check.busy && check.ollama === undefined) ? (
            <div className="guide-row"><Status state="busy" /> …</div>
          ) : (
            <ul className="guide-checks">
              <li className="guide-row">
                <Status state={check.ollama ? 'ok' : 'warn'} />
                <span className="guide-label">{T.ollama}</span>
                <span className="guide-detail">{check.ollama ? T.ollamaOk : T.ollamaBad}</span>
              </li>
              {check.ollama && (
                <li className="guide-row">
                  <Status state={check.chat ? 'ok' : 'warn'} />
                  <span className="guide-label">{T.chat}</span>
                  <span className="guide-detail">{check.chat ? T.chatOk(check.chat) : <>{T.chatBad} {pullButton(RECOMMENDED_CHAT)}</>}</span>
                </li>
              )}
              {check.ollama && (
                <li className="guide-row">
                  <Status state={check.embed ? 'ok' : 'warn'} />
                  <span className="guide-label">{T.embed}</span>
                  <span className="guide-detail">{check.embed ? T.embedOk : <>{T.embedBad} {pullButton(RECOMMENDED_EMBED)}</>}</span>
                </li>
              )}
              <li className="guide-row is-block">
                <span className="guide-label">{T.clis}</span>
                {check.clis ? (
                  <ul className="guide-sub">
                    {check.clis.map(c => (
                      <li key={c.id} className="guide-row"><Status state={cliState(c)} /> <span className="guide-label">{c.label}</span> <span className="guide-detail">{cliText(c)}</span></li>
                    ))}
                  </ul>
                ) : <span className="guide-detail">{T.cliUnknown}</span>}
                {(!check.clis || check.clis.some(c => cliState(c) !== 'ok')) && (
                  <div className="guide-hint">{T.cliHelp}<code>node server/first-run.mjs --reconfigure</code></div>
                )}
              </li>
            </ul>
          )}
          <button type="button" className="guide-btn is-small is-ghost" onClick={recheck} disabled={check?.busy}>
            <RefreshCw size={14} /> {T.recheck}
          </button>
        </>
      ),
    },
    { title: T.s3t, body: <ul className="guide-list">{T.s3b.map(x => <li key={x}>{x}</li>)}</ul> },
    { title: T.s4t, body: <ul className="guide-list">{T.s4b.map(x => <li key={x}>{x}</li>)}</ul> },
    { title: T.s6t, body: <ul className="guide-list">{T.s6b.map(x => <li key={x}>{x}</li>)}</ul> },
    { title: T.s7t, body: <ul className="guide-list">{T.s7b.map(x => <li key={x}>{x}</li>)}</ul> },
    { title: T.s8t, body: <ul className="guide-list">{T.s8b.map(x => <li key={x}>{x}</li>)}</ul> },
    { title: T.s9t, body: <ul className="guide-list">{T.s9b.map(x => <li key={x}>{x}</li>)}</ul> },
    {
      title: T.s5t,
      body: (
        <>
          <ul className="guide-list">{T.s5b.map(x => <li key={x}>{x}</li>)}</ul>
          <p className="guide-foot">{T.s5foot}</p>
        </>
      ),
    },
  ];
  const last = step === pages.length - 1;
  const page = pages[step];

  return createPortal(
    <div className="guide-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(); }}>
      <div className="guide-card" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <button type="button" className="guide-x" aria-label={T.close} onClick={finish}><X size={18} /></button>
        {/* Keyed by step, so each page plays its entrance. */}
        <div className="guide-page" key={step}>
          <h2 id="guide-title">{page.title}</h2>
          {page.body}
        </div>
        <div className="guide-dots" aria-label={T.step(step + 1, pages.length)}>
          {pages.map((_, i) => (
            <button key={i} type="button" className={`guide-dot ${i === step ? 'is-on' : ''}`}
              aria-label={T.step(i + 1, pages.length)} onClick={() => setStep(i)} />
          ))}
        </div>
        <div className="guide-actions">
          {!last && <button type="button" className="guide-btn is-ghost" onClick={finish}>{T.skip}</button>}
          <span style={{ flex: 1 }} />
          {step > 0 && (
            <button type="button" className="guide-btn is-ghost" onClick={() => setStep(step - 1)}>
              <ChevronLeft size={16} /> {T.back}
            </button>
          )}
          <button type="button" className="guide-btn is-primary" onClick={() => (last ? finish() : setStep(step + 1))}>
            {last ? T.done : <>{T.next} <ChevronRight size={16} /></>}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
