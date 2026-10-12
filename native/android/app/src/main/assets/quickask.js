// Standalone, memory-only conversation. No App, sync engine or conversation/job ID.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const actions = [...document.querySelectorAll('[data-prompt]')];
  let auth = {};
  let selection = '', history = [], controller = null, lastAnswer = '', closed = false;
  const status = text => { $('status').textContent = text; };
  function available() {
    const ready = !!$('model').value;
    $('send').disabled = !ready && !controller;
    $('send').textContent = controller ? '중지' : '보내기';
    $('model').disabled = !!controller || !ready;
    $('input').disabled = !!controller;
    actions.forEach(button => { button.disabled = !!controller || !ready; });
  }
  function consumeActions() {
    const queued = window.__ollamaNative || [];
    window.__ollamaNative = [];
    for (const event of queued) if (event.type === 'selection') {
      selection = String(event.text || '');
      $('selection').textContent = selection;
      $('selection').hidden = !selection;
    }
  }
  window.addEventListener('ollama-native-action', consumeActions);
  consumeActions();
  async function sessionHeaders() {
    const response = await fetch('/api/auth/session', {cache:'no-store', headers:auth['X-Session-Id']?{'X-Session-Id':auth['X-Session-Id']}:{}, signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('로그인 연결을 확인해 주세요.');
    const session = await response.json();
    if (session.anyAccounts && !session.user) { $('open').hidden = false; throw new Error('로그인이 만료되었습니다. 앱에서 로그인한 뒤 다시 열어 주세요.'); }
    if (session.pendingDevice) throw new Error('메인 앱에서 기기 승인을 완료해 주세요.');
    return {...(session.sessionId ? {'X-Session-Id':session.sessionId}:{}), ...(session.csrfToken ? {'X-CSRF-Token':session.csrfToken}:{})};
  }
  async function models() {
    $('retry').hidden = true; $('open').hidden = true;
    status('모델 불러오는 중…');
    try {
      auth = await sessionHeaders();
      const response = await fetch('/api/tags', { cache: 'no-store', headers: auth, signal: AbortSignal.timeout(15000) });
      if (response.status === 401 || response.status === 403) {
        $('open').hidden = false;
        throw new Error('클라이언트에서 로그인한 뒤 다시 열어 주세요.');
      }
      if (!response.ok) throw new Error('서버에 연결할 수 없습니다.');
      const data = await response.json();
      const list = (data.models || []).filter(m => m.name && !/embed|rerank/i.test(m.name));
      if (!list.length) throw new Error('사용 가능한 대화 모델이 없습니다.');
      $('model').replaceChildren(...list.map(m => new Option(m.name, m.name)));
      status('대화 기록에 저장하지 않습니다.');
    } catch (error) {
      status(error.name === 'TimeoutError' ? '연결이 지연되고 있습니다. 다시 시도해 주세요.' : error.message);
      $('retry').hidden = false;
    } finally { available(); }
  }
  function row(kind, text) {
    const node = document.createElement('div');
    node.className = kind; node.textContent = text;
    $('thread').appendChild(node);
    $('thread').scrollTop = $('thread').scrollHeight;
    return node;
  }
  async function ask(question) {
    if (controller || closed || !$('model').value || !question.trim()) return;
    controller = new AbortController();
    const current = controller;
    available(); $('empty').hidden = true; status('답변 준비 중…');
    const message = { role: 'user', content: question.trim() + (!history.length && selection ? '\n\n선택한 글:\n"""\n' + selection + '\n"""' : '') };
    row('question', question.trim());
    const answer = row('answer', '');
    let content = '', done = false, reader;
    const frame = line => {
      if (!line.trim()) return;
      const value = JSON.parse(line);
      if (value.error) throw new Error(typeof value.error === 'string' ? value.error : '답변 생성에 실패했습니다.');
      content += value.message?.content || value.response || '';
      const nearBottom = $('thread').scrollHeight - $('thread').scrollTop - $('thread').clientHeight < 70;
      answer.textContent = content;
      if (nearBottom) $('thread').scrollTop = $('thread').scrollHeight;
      status(content ? '답변 중…' : '생각 중…');
      done = !!value.done;
    };
    try {
      auth = await sessionHeaders();
      const response = await fetch('/api/chat', {
        method: 'POST', signal: current.signal,
        headers: { ...auth, 'Content-Type': 'application/json', 'X-Chat-Ephemeral': '1', 'X-Cli-Tools': 'off' },
        body: JSON.stringify({ model: $('model').value, messages: [...history, message], stream: true }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `요청에 실패했습니다 (${response.status}).`);
      }
      if (!response.body) throw new Error('답변 스트림을 열 수 없습니다.');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!done) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        let newline;
        while (!done && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); frame(line);
        }
        if (chunk.done) { if (!done && buffer.trim()) frame(buffer); break; }
      }
      if (!done) throw new Error('연결이 끊겼습니다. 다시 질문해 주세요.');
      $('input').value = '';
      history.push(message, { role: 'assistant', content });
      status('대화 기록에 저장하지 않습니다.');
      if (!content) answer.textContent = '텍스트 답변이 없습니다.';
    } catch (error) {
      status(current.signal.aborted ? '답변을 중지했습니다.' : String(error.message));
      if (!content) answer.textContent = current.signal.aborted ? '중지됨' : '답변을 받지 못했습니다.';
    } finally {
      if (reader) await reader.cancel().catch(() => {});
      current.abort();
      if (content) { lastAnswer = content; $('copy').disabled = false; }
      controller = null; available();
    }
  }
  $('form').addEventListener('submit', event => {
    event.preventDefault();
    if (controller) { controller.abort(); return; }
    const question = $('input').value;
    if (!question.trim()) { $('input').focus(); return; }
    void ask(question);
  });
  actions.forEach(button => button.addEventListener('click', () => void ask(button.dataset.prompt)));
  $('retry').addEventListener('click', () => void models());
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastAnswer); status('답변을 복사했습니다.'); }
    catch { status('복사할 수 없습니다. 다시 시도해 주세요.'); }
  });
  function dispose() { closed = true; controller?.abort(); history = []; selection = ''; lastAnswer = ''; }
  $('close').addEventListener('click', () => { dispose(); window.ollamaNative?.closeQuickAsk(); });
  $('open').addEventListener('click', () => { dispose(); window.ollamaNative?.openQuickAskApp(); });
  $('bubble').addEventListener('click', async () => {
    try { await window.ollamaNative?.showQuickAskBubble(); } catch(error) { status(error.message); }
  });
  $('input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('form').requestSubmit(); }
  });
  window.addEventListener('pageshow', () => { closed = false; });
  window.addEventListener('pagehide', dispose);
  available(); void models();
})();
