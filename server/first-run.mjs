// First-run setup for an installed copy, run by the launchers before the
// server starts. Interactive, in the launcher's own console window.
//
//   1. Asks for the access token. The installed app now listens on the
//      network (HOST=0.0.0.0), the way start_ollama_webui.bat runs the
//      project, and the server refuses that without a token. Blank generates
//      one and prints it once.
//   2. For Claude Code, Codex and Antigravity (agy): asks whether there is a
//      paid plan for it. Only on "yes" is the CLI installed (if missing) and
//      its sign-in started (if not signed in) -- each needs a subscription to
//      be any use, and an install nobody can sign in to is just clutter.
//
// Done once; SETUP_DONE=1 in .env records it. `--reconfigure` asks again.
// Without a terminal (a service, the release smoke check) it only makes sure
// a token exists and never blocks.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnvValue, writeEnvValue } from './envFile.js';
import { socialLoginSetup } from './socialSetup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');
const HOME = os.homedir();
const WIN = process.platform === 'win32';
const reconfigure = process.argv.includes('--reconfigure');

if (!fs.existsSync(ENV_FILE)) {
  fs.writeFileSync(ENV_FILE, fs.existsSync(EXAMPLE) ? fs.readFileSync(EXAMPLE, 'utf-8') : '');
}
let env = fs.readFileSync(ENV_FILE, 'utf-8');
const save = (key, value) => { env = writeEnvValue(env, key, value); fs.writeFileSync(ENV_FILE, env); };

const interactive = process.stdin.isTTY && process.stdout.isTTY;

// Never leave the server unable to start: network host without a token.
const ensureNetwork = (token) => {
  const host = readEnvValue(env, 'HOST');
  if (!host || ['127.0.0.1', 'localhost', '::1'].includes(host)) save('HOST', '0.0.0.0');
  if (!readEnvValue(env, 'PORT')) save('PORT', '5173');
  if (token) save('ACCESS_TOKEN', token);
  else if (!readEnvValue(env, 'ACCESS_TOKEN')) save('ACCESS_TOKEN', crypto.randomBytes(24).toString('base64url'));
};

if (readEnvValue(env, 'SETUP_DONE') === '1' && !reconfigure) { ensureNetwork(); process.exit(0); }
if (!interactive) { ensureNetwork(); process.exit(0); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim();
const yes = async (q) => /^(y|yes|ㅛ|예|네|응)$/i.test(await ask(`${q} [y/N] `));
const line = () => console.log('------------------------------------------');

console.log('');
line();
console.log(' Ollama WebUI 첫 실행 설정');
line();

/* ------------------------------------------------------------ 1. token */

console.log('');
console.log('[1/4] 접속 토큰');
console.log('  다른 기기(휴대폰, 외부망)에서 접속할 때 입력하는 비밀번호입니다.');
console.log('  비워 두면 자동으로 만들어 드립니다.');
let token = '';
for (;;) {
  token = await ask('  접속 토큰 (8자 이상, Enter = 자동 생성): ');
  if (!token) { token = crypto.randomBytes(18).toString('base64url'); console.log(`  생성된 토큰: ${token}`); break; }
  if (/\s/.test(token)) { console.log('  공백은 쓸 수 없어요.'); continue; }
  if (token.length < 8) { console.log('  8자 이상으로 입력해 주세요.'); continue; }
  break;
}
ensureNetwork(token);
console.log('  저장했습니다. 나중에 바꾸려면 .env의 ACCESS_TOKEN을 고치거나');
console.log('  이 설정을 다시 실행하세요 (node server/first-run.mjs --reconfigure).');

/* ---------------------------------------------------- 2. social sign-in */

// Google and Kakao answer only addresses registered in their consoles. The
// step-by-step guide with this server's exact values is server/socialSetup.mjs;
// it is also saved next to .env as SOCIAL_LOGIN_SETUP.ko.txt.
console.log('');
line();
console.log(' [2/4] 소셜 로그인 (Google · 카카오)');
const openUrl = (url) => (WIN
  ? spawnSync('cmd.exe', ['/d', '/c', 'start', '', url], { stdio: 'ignore' })
  : spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' }));
const socialNote = await socialLoginSetup({
  env: () => env, save, readEnvValue, ask, yes, openUrl,
  writeGuide: (text) => { const file = path.join(ROOT, 'SOCIAL_LOGIN_SETUP.ko.txt'); fs.writeFileSync(file, text); return file; },
});

/* --------------------------------------------------------------- 2. CLIs */

// Same places server/cliModels.js resolveBinary looks, so whatever is found
// here is what the server will find.
const searchDirs = () => [
  ...String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean),
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'AppData', 'Roaming', 'npm'),
  path.join(HOME, 'AppData', 'Local', 'agy', 'bin'),
  path.join(HOME, 'AppData', 'Local', 'Antigravity'),
];
const findBin = (bin) => {
  const names = WIN ? [`${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of searchDirs()) for (const name of names) {
    const file = path.join(dir, name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return null;
};

// npm that came with the bundled Node, else the system one. Run through this
// Node directly, so no `.cmd` and no shell is involved.
const npmCli = () => {
  const dir = path.dirname(process.execPath);
  for (const p of [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (fs.existsSync(p)) return { command: process.execPath, args: [p] };
  }
  return { command: WIN ? 'npm.cmd' : 'npm', args: [], shell: WIN };
};
// Global installs go where resolveBinary looks, without admin rights.
const npmPrefix = WIN ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm') : path.join(HOME, '.local');

// readline lets go of the console while a child (an installer, a login) owns it.
const run = (command, args, opts = {}) => {
  rl.pause();
  try { return spawnSync(command, args, { stdio: 'inherit', ...opts }).status === 0; } finally { rl.resume(); }
};
const script = (winUrl, unixUrl) => (WIN
  ? run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${winUrl} | iex`])
  : run('sh', ['-c', `curl -fsSL ${unixUrl} | bash`]));

const CLIS = [
  {
    id: 'claude', label: 'Claude Code', bin: 'claude',
    plan: 'Claude Pro / Max (또는 Anthropic API 결제)',
    authFiles: [['.claude', '.credentials.json']],
    install: () => script('https://claude.ai/install.ps1', 'https://claude.ai/install.sh'),
    login: [['auth', 'login']],
    loginHint: '창이 열리면 /login 으로 로그인한 뒤 /exit 로 나오세요.',
  },
  {
    id: 'codex', label: 'Codex', bin: 'codex',
    plan: 'ChatGPT Plus / Pro / Business (또는 OpenAI API 결제)',
    authFiles: [['.codex', 'auth.json']],
    install: () => {
      const npm = npmCli();
      return run(npm.command, [...npm.args, 'install', '-g', '--prefix', npmPrefix, '@openai/codex'], { shell: npm.shell });
    },
    login: [['login']],
  },
  {
    id: 'agy', label: 'Antigravity (agy)', bin: 'agy',
    plan: 'Google AI Pro / Ultra',
    authFiles: [['.gemini', 'oauth_creds.json'], ['.gemini', 'google_accounts.json']],
    install: () => script('https://antigravity.google/cli/install.ps1', 'https://antigravity.google/cli/install.sh'),
    login: [[]],
    loginHint: '창이 열리면 Google 계정으로 로그인한 뒤 Ctrl+C 로 나오세요.',
  },
];

const signedIn = (cli) => cli.authFiles.some(parts => fs.existsSync(path.join(HOME, ...parts)));
const launch = (file, args) => (WIN && /\.cmd$/i.test(file)
  ? run('cmd.exe', ['/d', '/c', file, ...args])
  : run(file, args));

console.log('');
console.log('[3/4] AI 코딩 CLI (Claude Code · Codex · Antigravity)');
console.log('  각 서비스의 유료 구독이 있어야 쓸 수 있습니다. 구독이 있는 것만');
console.log('  설치하고 로그인합니다. 없으면 n 을 눌러 건너뛰세요.');

const summary = [];
summary.push(socialNote);
for (const cli of CLIS) {
  console.log('');
  line();
  console.log(` ${cli.label}  -  필요 구독: ${cli.plan}`);
  // Semi-automatic: already installed and signed in means a subscription is
  // in use -- nothing to ask.
  let file = findBin(cli.bin);
  if (file && signedIn(cli)) { console.log('  이미 설치·로그인되어 있어 그대로 씁니다.'); summary.push(`${cli.label}: 준비됨 (자동 감지)`); continue; }
  if (!(await yes('  이 구독을 결제해 사용 중인가요?'))) { summary.push(`${cli.label}: 건너뜀 (구독 없음)`); continue; }

  if (file) console.log(`  이미 설치되어 있습니다: ${file}`);
  else {
    console.log(`  ${cli.label} 설치 중...`);
    cli.install();
    file = findBin(cli.bin);
    if (!file) { summary.push(`${cli.label}: 설치 실패 - 위 메시지를 확인하세요`); continue; }
    console.log(`  설치했습니다: ${file}`);
  }

  if (signedIn(cli)) { summary.push(`${cli.label}: 준비됨 (이미 로그인)`); console.log('  이미 로그인되어 있습니다.'); continue; }
  console.log('  로그인을 시작합니다. 브라우저가 열리면 결제한 계정으로 로그인하세요.');
  if (cli.loginHint) console.log(`  (${cli.loginHint})`);
  for (const args of cli.login) { if (launch(file, args) && signedIn(cli)) break; }
  if (!signedIn(cli) && cli.id === 'claude') {
    // Older Claude Code without `auth login`: the interactive /login.
    console.log(`  ${cli.loginHint}`);
    launch(file, []);
  }
  summary.push(`${cli.label}: ${signedIn(cli) ? '준비됨' : '로그인 안 됨 - 나중에 터미널에서 직접 로그인하세요'}`);
}

/* ------------------------------------------------------------- 3. Ollama */

// Reachable, and with something to chat with and the embedder. Pulls the
// recommended ones on a single "yes" -- the web guide offers the same.
console.log('');
line();
console.log(' [4/4] Ollama 점검');
const OLLAMA = ([readEnvValue(env, 'OLLAMA_URL'), readEnvValue(env, 'OLLAMA_HOST')].find(v => /^https?:\/\//.test(v || '')) || 'http://127.0.0.1:11434').replace(/\/$/, '');
let tags = null;
try { tags = (await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) })).json()).models || []; } catch { /* down */ }
if (!tags) {
  console.log('  Ollama에 연결할 수 없어요. https://ollama.com 에서 설치한 뒤 실행해 두세요.');
  summary.push('Ollama: 연결 안 됨');
} else {
  const isEmbed = (m) => /embed|bge|gte|minilm|nomic-bert/i.test(m.name) || /bert/i.test(m.details?.family || '');
  const want = [];
  if (!tags.some(m => !isEmbed(m))) want.push('qwen3:8b');
  if (!tags.some(isEmbed)) want.push('qwen3-embedding:0.6b');
  if (!want.length) { console.log('  대화 모델과 임베딩 모델이 이미 있어요.'); summary.push('Ollama: 준비됨'); }
  else if (await yes(`  추천 모델을 받을까요? (${want.join(', ')})`)) {
    for (const name of want) {
      console.log(`  ${name} 받는 중... (몇 분 걸릴 수 있어요)`);
      const ok = run('ollama', ['pull', name], { shell: WIN });
      summary.push(`Ollama ${name}: ${ok ? '받음' : '실패 - 나중에 ollama pull ' + name}`);
    }
  } else summary.push('Ollama: 모델은 나중에 웹 가이드에서 받기');
}

save('SETUP_DONE', '1');
console.log('');
line();
console.log(' 설정 완료');
for (const s of summary) console.log(`  - ${s}`);
console.log(`  - 접속 토큰: ${readEnvValue(env, 'ACCESS_TOKEN')}`);
line();
console.log('');
rl.close();
