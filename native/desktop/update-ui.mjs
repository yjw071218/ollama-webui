import { localize, tr } from './page-i18n.mjs';
localize();
const $ = id => document.getElementById(id);
const size = bytes => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB' : (bytes / 1e6).toFixed(1) + ' MB';
};
const eta = seconds => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return tr('약 ' + Math.ceil(seconds) + '초 남음', 'about ' + Math.ceil(seconds) + 's left');
  return tr('약 ' + Math.ceil(seconds / 60) + '분 남음', 'about ' + Math.ceil(seconds / 60) + ' min left');
};
let cancelId = 'close';

/* Release notes as text: "- " lines become list items, nothing is parsed as HTML. */
function renderNotes(text) {
  const list = $('notes');
  list.replaceChildren();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^#+\s*$/.test(line)) continue;
    const li = document.createElement('li');
    const bullet = /^[-*•]\s+/.test(line);
    li.textContent = line.replace(/^[-*•]\s+/, '').replace(/^#+\s*/, '');
    if (!bullet) li.className = 'plain';
    list.append(li);
  }
  $('notesBox').hidden = !list.children.length;
}

function buttons(list) {
  const footer = $('buttons');
  footer.replaceChildren();
  for (const [label, action, kind] of list) {
    const b = document.createElement('button');
    b.textContent = label;
    if (kind) b.className = kind;
    b.onclick = () => window.appUpdate.action(action);
    footer.append(b);
  }
  (footer.querySelector('.primary') || footer.lastElementChild)?.focus();
}

function render(s) {
  const info = s.info || {};
  const badge = $('badge');
  badge.className = 'badge';
  $('error').hidden = true;
  $('progressBox').hidden = true;
  $('notesBox').hidden = true;
  cancelId = 'close';
  switch (s.phase) {
    case 'checking':
      badge.textContent = '…'; badge.classList.add('busy');
      $('title').textContent = tr('업데이트 확인 중…', 'Checking for updates…');
      $('subtitle').textContent = tr('GitHub에서 최신 버전을 확인하고 있습니다.', 'Looking for the latest version on GitHub.');
      buttons([[tr('닫기', 'Close'), 'close']]);
      break;
    case 'latest':
      badge.textContent = '✓'; badge.classList.add('ok');
      $('title').textContent = tr('최신 버전입니다', 'You are up to date');
      $('subtitle').textContent = tr('현재 버전 ' + (s.current || '') + '이(가) 가장 최신입니다.', 'Version ' + (s.current || '') + ' is the latest.');
      buttons([[tr('확인', 'OK'), 'close', 'primary']]);
      break;
    case 'available':
      badge.textContent = '↑';
      $('title').textContent = tr('새 버전 ' + info.version + ' 사용 가능', 'Version ' + info.version + ' is available');
      $('subtitle').textContent = tr('현재 ', 'Now ') + info.current + ' → ' + info.version + ' · ' + size(info.size)
        + (info.kind === 'dev' ? tr(' · 개발 실행에서는 릴리스 페이지를 엽니다', ' · a development build opens the release page') : '');
      renderNotes(info.notes);
      cancelId = 'later';
      buttons([[tr('이 버전 건너뛰기', 'Skip this version'), 'skip', 'ghost'], [tr('나중에', 'Later'), 'later'], [info.kind === 'dev' ? tr('릴리스 열기', 'Open release') : tr('지금 업데이트', 'Update now'), 'download', 'primary']]);
      break;
    case 'downloading': {
      const p = s.progress || {};
      const percent = Math.max(0, Math.min(100, p.percent ?? 0));
      badge.textContent = '↓'; badge.classList.add('busy');
      $('title').textContent = tr(info.version + ' 다운로드 중', 'Downloading ' + info.version);
      $('subtitle').textContent = tr('다운로드가 끝나면 파일 무결성(SHA-256)을 확인합니다.', 'The file is checked (SHA-256) once it has downloaded.');
      $('progressBox').hidden = false;
      $('fill').style.width = percent + '%';
      $('bar').setAttribute('aria-valuenow', String(percent));
      $('percent').textContent = percent + '%';
      const speed = p.bytesPerSecond > 0 ? size(p.bytesPerSecond) + '/s' : '';
      const remaining = p.total && p.bytesPerSecond > 0 ? eta((p.total - p.received) / p.bytesPerSecond) : '';
      $('detail').textContent = [size(p.received) + ' / ' + size(p.total), speed, remaining].filter(Boolean).join(' · ');
      renderNotes(info.notes);
      cancelId = 'cancel';
      buttons([[tr('취소', 'Cancel'), 'cancel']]);
      break;
    }
    case 'ready':
      badge.textContent = '✓'; badge.classList.add('ok');
      $('title').textContent = tr(info.version + ' 설치 준비 완료', info.version + ' is ready to install');
      $('subtitle').textContent = tr('검증을 마쳤습니다. 지금 다시 시작하거나, 앱을 종료할 때 자동으로 설치됩니다.', 'Checked. Restart now, or it installs when you quit the app.');
      $('progressBox').hidden = false;
      $('fill').style.width = '100%';
      $('percent').textContent = '100%';
      $('detail').textContent = size(info.size) + tr(' · 검증 완료', ' · checked');
      renderNotes(info.notes);
      cancelId = 'later';
      buttons([[tr('종료할 때 설치', 'Install on quit'), 'later'], [tr('지금 다시 시작하여 설치', 'Restart and install'), 'install', 'primary']]);
      break;
    case 'installing':
      badge.textContent = '…'; badge.classList.add('busy');
      $('title').textContent = tr('설치 중…', 'Installing…');
      $('subtitle').textContent = tr('앱이 종료된 뒤 새 버전으로 다시 시작됩니다.', 'The app closes and starts again in the new version.');
      buttons([]);
      break;
    case 'error':
      badge.textContent = '!'; badge.classList.add('err');
      $('title').textContent = tr('업데이트 오류', 'Update error');
      $('subtitle').textContent = s.error || '';
      $('error').hidden = !s.detail;
      $('error').textContent = s.detail || '';
      buttons([[tr('릴리스 페이지 열기', 'Open release page'), 'release', 'ghost'], [tr('닫기', 'Close'), 'close'], [tr('다시 시도', 'Try again'), 'retry', 'primary']]);
      break;
    default:
      buttons([[tr('닫기', 'Close'), 'close']]);
  }
}

$('close').onclick = () => window.appUpdate.action(cancelId === 'cancel' ? 'close' : cancelId);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); window.appUpdate.action(cancelId === 'cancel' ? 'close' : cancelId); }
});
window.appUpdate.subscribe(render);
