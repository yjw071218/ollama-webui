/*
 * Google sign-in setup for a first install (server/first-run.mjs).
 *
 * Google only answers addresses registered in its console, and what
 * to register depends on this server's address. So the guide is generated
 * here with this server's exact values, printed during the first run, saved
 * next to .env as SOCIAL_LOGIN_SETUP.ko.txt, and the generic copy in
 * docs/SOCIAL_LOGIN.ko.md is produced by the same function
 * (node server/socialSetup.mjs --doc).
 */
import os from 'node:os';

export const GOOGLE_LOOPBACK_REDIRECT = 'http://127.0.0.1:47615/api/auth/native/google/callback';
export const GOOGLE_CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;

/** This PC's LAN address as <ip>.nip.io, which resolves back to it (Google refuses a bare IP). */
export function suggestedOrigin(port = '5173', interfaces = os.networkInterfaces()) {
  const ip = Object.values(interfaces).flat()
    .find(a => a && a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address))?.address;
  return ip ? `http://${ip}.nip.io:${port}` : '';
}

/** The values each console needs for this server. */
export function registrationValues({ origin, port = '5173' }) {
  const local = `http://localhost:${port}`;
  const origins = [...new Set([origin, local].filter(Boolean))];
  return {
    googleOrigins: origins.filter(o => {
      try { const u = new URL(o); return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); }
      catch { return false; }
    }),
    googleRedirects: [GOOGLE_LOOPBACK_REDIRECT],
  };
}

/** The whole step-by-step guide, as lines of text. */
export function socialGuide({ origin, port = '5173' }) {
  const v = registrationValues({ origin, port });
  const list = (items) => items.map(i => '        ' + i);
  return [
    '소셜 로그인(Google) 설정 방법',
    '====================================',
    '',
    `이 서버 주소: ${origin || '(PUBLIC_ORIGIN 미설정 - 아래 "주소 정하기" 참고)'}`,
    '',
    '소셜 로그인은 선택 사항입니다. 설정하지 않아도 아이디·비밀번호 로그인은 됩니다.',
    '키는 .env 파일에 저장되고, 바꾼 뒤에는 서버를 다시 시작해야 적용됩니다.',
    '콘솔 메뉴 이름은 Google이 화면을 바꾸면 조금 다를 수 있습니다.',
    '',
    '0. 주소 정하기 (PUBLIC_ORIGIN)',
    '------------------------------',
    '  Google은 http://192.168.0.5:5173 같은 IP 주소를 등록할 수 없습니다.',
    '  nip.io는 DNS 이름만 제공합니다. Google용 HTTPS 요구사항을 없애 주지 않습니다.',
    '  Google 웹 로그인은 localhost 외에는 유효한 인증서가 있는 HTTPS 주소를 사용하세요.',
    '  (nip.io는 그 IP로 그대로 연결해 주는 공개 DNS입니다. 첫 실행이 자동으로 정해 줍니다.)',
    '  밖에서 접속한다면 공인 IP로 같은 형식을 쓰고, 공유기에서 포트를 열어 주세요.',
    '  .env 의 PUBLIC_ORIGIN 이 이 주소입니다. 주소를 바꾸면 아래 콘솔 등록값도 함께 바꾸세요.',
    '',
    '1. Google 로그인',
    '---------------',
    '  ① https://console.cloud.google.com 에 Google 계정으로 로그인합니다.',
    '  ② 위쪽 프로젝트 선택 → [새 프로젝트] → 이름(예: ollama-webui) → [만들기].',
    '  ③ 왼쪽 메뉴 [API 및 서비스] → [OAuth 동의 화면] (새 화면에서는 [Google 인증 플랫폼]) → [시작하기]',
    '     - 앱 이름: 아무 이름 / 사용자 지원 이메일: 내 이메일',
    '     - 대상(사용자 유형): [외부]',
    '     - 연락처 이메일 입력 → 정책 동의 → [만들기]',
    '  ④ [대상(Audience)] 메뉴에서',
    '     - 게시 상태가 "테스트"이면 [테스트 사용자 추가]로 로그인할 Google 계정을 넣거나,',
    '     - 공개 서비스는 [앱 게시] 및 콘솔에서 요구하는 브랜드·도메인 검증을 완료하세요.',
    '  ⑤ [클라이언트(사용자 인증 정보)] → [클라이언트 만들기 / + 사용자 인증 정보 만들기 → OAuth 클라이언트 ID]',
    '     - 애플리케이션 유형: [웹 애플리케이션]',
    '     - [승인된 JavaScript 원본]에 아래를 하나씩 추가:',
    ...list(v.googleOrigins),
    '     - [승인된 리디렉션 URI]에 아래를 추가 (Android·Windows 앱에서 Google 계정 선택 창을 바로 띄우는 데 씁니다):',
    ...list(v.googleRedirects),
    '     - [만들기] → 나오는 "클라이언트 ID"(…apps.googleusercontent.com)를 복사합니다.',
    '       클라이언트 보안 비밀번호(Secret)는 필요 없습니다.',
    '  ⑥ .env 에 저장:  VITE_GOOGLE_CLIENT_ID=복사한_클라이언트_ID',
    '  ⑦ Google 설정은 반영까지 5분~몇 시간 걸릴 수 있습니다.',
    '  자주 나는 오류',
    '     - "origin_mismatch" / 버튼이 안 뜸 : ⑤의 JavaScript 원본에 지금 접속한 주소가 없습니다.',
    '     - 앱에서 중간 페이지가 먼저 뜸     : ⑤의 리디렉션 URI가 아직 없거나 반영 전입니다. Google에 반영된 뒤 다시 시도하세요(거절 결과는 1분 캐시).',
    '     - "403 access_denied"               : ④에서 테스트 사용자에 계정을 넣지 않았습니다.',
    '',
    '2. 적용',
    '-------',
    '  .env 를 저장한 뒤 서버를 다시 시작하세요. 웹에서 로그인 화면을 새로고침하면 버튼이 보입니다.',
    '  이 안내를 다시 보려면:  node server/first-run.mjs --reconfigure',
    '  앱과 서버를 함께 업데이트하세요. 파일을 설치해도 실행 중인 옛 서버는 재시작 전까지 그대로입니다.',
    '  공식 Google 안내: https://developers.google.com/identity/protocols/oauth2/web-server',
    '',
  ];
}

/**
 * The interactive step. `io` is the first run's own helpers, so this works in
 * whichever version of first-run.mjs calls it.
 */
export async function socialLoginSetup({ env, save, readEnvValue, ask, yes, openUrl, writeGuide, log = console.log }) {
  const port = readEnvValue(env(), 'PORT') || '5173';
  if (!readEnvValue(env(), 'PUBLIC_ORIGIN')) {
    const origin = suggestedOrigin(port);
    if (origin) { save('PUBLIC_ORIGIN', origin); log(`  접속 주소를 정했어요: ${origin}`); }
  }
  const origin = readEnvValue(env(), 'PUBLIC_ORIGIN');
  const has = (...keys) => keys.some(k => readEnvValue(env(), k));
  const guide = socialGuide({ origin, port });
  const section = (from, to) => guide.slice(guide.indexOf(from), to ? guide.indexOf(to) : undefined);
  log('  Google 로그인은 선택입니다. 안 써도 아이디·비밀번호 로그인은 됩니다.');
  const wantGoogle = !has('VITE_GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID');
  if (!wantGoogle) log('  Google 키가 이미 있어요.');
  else if (await yes('  Google 로그인을 설정할까요? (단계별 안내가 나옵니다)')) {
    log('');
    for (const l of section('1. Google 로그인', '2. 적용')) log('  ' + l);
    if (await yes('  Google Cloud 콘솔을 브라우저로 열까요?')) openUrl('https://console.cloud.google.com/apis/credentials');
    for (;;) {
      const id = await ask('  Google 클라이언트 ID (Enter = 나중에): ');
      if (!id) break;
      if (GOOGLE_CLIENT_ID.test(id)) { save('VITE_GOOGLE_CLIENT_ID', id); log('  저장했어요.'); break; }
      log('  형식이 달라요. "숫자-영문.apps.googleusercontent.com" 전체를 붙여 넣으세요.');
    }
  }
  let file = '';
  try { file = writeGuide(guide.join(os.EOL)); } catch { /* the console copy is enough */ }
  const v = registrationValues({ origin, port });
  log('');
  log('  콘솔에 등록할 값 (이미 했다면 넘어가세요):');
  log(`    Google  승인된 JavaScript 원본 : ${v.googleOrigins.join(' , ')}`);
  log(`    Google  승인된 리디렉션 URI    : ${v.googleRedirects.join(' , ')}`);
  if (file) log(`  전체 안내를 저장했어요: ${file}`);
  const configured = [has('VITE_GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID') && 'Google'].filter(Boolean);
  return `소셜 로그인: ${configured.length ? configured.join('·') + ' 키 있음' : '설정 안 함'}${file ? ' (안내: ' + file + ')' : ''}`;
}

// `node server/socialSetup.mjs --doc` prints the generic guide (docs/SOCIAL_LOGIN.ko.md).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()) && process.argv.includes('--doc')) {
  const lines = socialGuide({ origin: 'http://<내 PC IP>.nip.io:5173', port: '5173' });
  process.stdout.write(['# ' + lines[0], '', '```text', ...lines.slice(2), '```', ''].join('\n'));
}
