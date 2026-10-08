import { localize, tr } from './page-i18n.mjs';
localize();
const $ = selector => document.querySelector(selector);
const form = $('form');
const input = $('#url');
const status = $('#status');
const button = $('#submit');
input.value = await window.connection.current();

let timer = null;
const stopCountdown = () => { clearInterval(timer); timer = null; $('#countdown').textContent = ''; };
async function connect(value) {
  stopCountdown();
  button.disabled = true; $('#retry').disabled = true;
  status.textContent = tr('연결 중…', 'Connecting…');
  try { await window.connection.connect(value); }
  catch (error) { status.textContent = error.message; await showFailure(); }
  finally { button.disabled = false; $('#retry').disabled = false; }
}
form.addEventListener('submit', event => { event.preventDefault(); connect(input.value); });

/* The saved server did not answer: say so, offer to try again, and try again
   on its own every 15 seconds -- a server still starting comes up by itself. */
async function showFailure() {
  const failure = await window.connection.failure();
  $('#failure').hidden = !failure;
  if (!failure) return;
  $('#failureServer').textContent = failure.server;
  $('#failureMessage').textContent = failure.message;
  /* Not this server at all (a web site saved as one, or something else at
     that address): trying it again would not change that. */
  $('#retry').hidden = !!failure.invalid;
  if (failure.invalid) { stopCountdown(); return; }
  $('#retry').onclick = () => connect(failure.server);
  let left = 15;
  const tick = () => {
    $('#countdown').textContent = tr(left + '초 후 자동으로 다시 시도', 'Trying again in ' + left + 's');
    if (left-- <= 0) connect(failure.server);
  };
  stopCountdown(); tick(); timer = setInterval(tick, 1000);
}
// Typing another address is choosing not to wait for this one.
input.addEventListener('input', stopCountdown);

async function showRecent() {
  const list = await window.connection.recent();
  const ul = $('#recent');
  ul.replaceChildren();
  for (const server of list) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'recent-open'; open.textContent = server;
    open.title = tr('이 서버에 연결', 'Connect to this server');
    open.onclick = () => { input.value = server; connect(server); };
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'recent-remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', tr(server + ' 목록에서 지우기', 'Remove ' + server));
    remove.onclick = async () => { await window.connection.forget(server); showRecent(); };
    li.append(open, remove); ul.append(li);
  }
  $('#recentBox').hidden = !list.length;
}
await showFailure();
await showRecent();
