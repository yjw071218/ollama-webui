import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = 'yjw071218/ollama-webui';
const version = JSON.parse(await readFile(path.join(root, 'native/desktop/package.json'), 'utf8')).version;
const tag = 'native-v' + version;
const command = args => execFileSync('git', args, {cwd:root, encoding:'utf8', env:{...process.env, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'Never'}}).trim();
function credential() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const output = execFileSync('git', ['credential', 'fill'], {cwd:root, input:'protocol=https\nhost=github.com\n\n', encoding:'utf8', env:{...process.env, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'Never'}, stdio:['pipe','pipe','pipe']});
  const match = output.match(/^password=(.+)$/m);
  if (!match) throw new Error('GitHub 배포 인증이 없습니다.');
  return match[1].trim();
}
const token = credential();
async function api(endpoint, options = {}) {
  const response = await fetch('https://api.github.com/repos/' + repo + endpoint, {
    ...options, headers:{Accept:'application/vnd.github+json', Authorization:'Bearer ' + token, 'X-GitHub-Api-Version':'2022-11-28', ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}
  });
  if (!response.ok) throw new Error('GitHub API ' + response.status + ' (' + endpoint + ')');
  return response.status === 204 ? null : response.json();
}
if (process.argv.includes('--check')) {
  const info = await api('');
  console.log(JSON.stringify({ repository:info.full_name, canPush:info.permissions?.push, private:info.private }));
} else if (process.argv.includes('--publish')) {
  const sha = command(['rev-parse','HEAD']);
  const ref = await api('/git/ref/tags/' + tag);
  if (ref.object.type !== 'commit' || ref.object.sha !== sha) throw new Error('원격 릴리스 태그가 현재 커밋과 일치하지 않습니다.');
  if (command(['diff','HEAD','--','native', 'src/capture.js', '.github/workflows/native-clients.yml'])) throw new Error('커밋하지 않은 앱 변경이 있습니다.');
  const names = [`android/OllamaWebUI-Client-${version}.apk`, `windows/OllamaWebUI-Client-${version}-x64-Setup.exe`, `windows/OllamaWebUI-Client-${version}-x64-Portable.exe`];
  const files = names.map(name => path.join(root, 'native/artifacts', name));
  const hashes = [];
  for (const file of files) {
    const size = (await stat(file)).size;
    if (size < 100000) throw new Error('설치 파일 크기가 올바르지 않습니다: ' + path.basename(file));
    hashes.push(createHash('sha256').update(await readFile(file)).digest('hex') + '  ' + path.basename(file));
  }
  const checksums = path.join(root, 'native/artifacts/SHA256SUMS.txt');
  await writeFile(checksums, hashes.join('\n') + '\n'); files.push(checksums);
  const body = [
    '## 서버 연결형 Android / Windows 앱',
    '- 처음 실행할 때 서버 주소를 입력하세요. 이후에는 저장된 서버에 자동 연결됩니다. 주소 입력은 서버 변경에서 가능합니다. http://0.0.0.0:5173/는 실제 연결용이 아닌 예시입니다.',
    '- Android 8+ APK / Windows x64 설치형 및 포터블 EXE',
    '- 마이크·카메라, 파일 업로드·저장, 클립보드, 화면 캡처. Android 네이티브 공유·실행 중 알림.',
    '- HTTP 원격 서버를 앱 내부 loopback 보안 컨텍스트에 연결합니다. HTTP 네트워크 통신 자체는 암호화되지 않습니다.',
    '- Android 화면 캡처는 이번 커밋의 서버 프런트엔드와 OS 동의가 필요합니다.',
    '- 계정으로 처음 로그인한 기기는 동기화가 끝날 때까지 진행률(%) 화면이 표시되고, 완료 후 앱이 열립니다(서버 재시작 후 적용).',
    '- Android: 상단 버튼 줄을 없앴습니다. 새로고침·서버 변경은 왼쪽 아래 프로필 메뉴에 있고, 상태 표시줄은 화면 테마 색을 따릅니다.',
    '- Google 버튼을 Google로 계속으로 복원하고, 인증 브라우저를 닫아도 재시도할 수 있도록 수정했습니다. Android 인증 ID 처리 오류를 수정했습니다. 웹 로그인 변경은 서버 코드 반영이 필요합니다.',
    '- 첫 동기화 미완료 상태를 완료로 처리하지 않도록 수정하고 내부 동기화 상태를 계정 설정에서 제외했습니다.',
    '- 알려진 제한: 설정 동기화 누락 전체 해결 및 Google·카카오 직접 인증 팝업은 미완료입니다. 실제 공급자 로그인과 모바일 실기기 검증은 완료하지 않았습니다. OAuth 키는 앱에 내장하지 않습니다.',
    '- 앱 실행 시 새 버전이 GitHub에 올라오면 업데이트 안내가 표시됩니다.',
    '- 종료 후 Web Push, 서버 도메인 패스키는 지원하지 않습니다. 모든 브라우저 API의 지원을 보장하지 않습니다.',
    '- Windows 실행 파일은 상용 코드 서명 인증서가 없어 SmartScreen 경고가 나올 수 있습니다.',
    '- Android APK는 지속 보관하는 로컬 릴리스 키로 서명했습니다. Android 실제 기기의 카메라·마이크·화면 캡처는 추가 확인이 필요합니다.',
    '', '소스 커밋: ' + sha,
    '설치 및 지원 범위: https://github.com/' + repo + '/blob/' + tag + '/native/README.ko.md',
  ].join('\n');
  const releases = await api('/releases?per_page=100');
  let release = releases.find(r => r.tag_name === tag);
  if (release && !release.draft) throw new Error('이미 공개된 릴리스는 변경하지 않습니다.');
  if (!release) release = await api('/releases', {method:'POST', body:JSON.stringify({tag_name:tag, target_commitish:sha, name:'Ollama WebUI Client ' + version + ' — Android / Windows', body, draft:true, prerelease:false, make_latest:'false'})});
  for (const file of files) {
    const name = path.basename(file);
    const old = release.assets?.find(a => a.name === name);
    if (old) await api('/releases/assets/' + old.id, {method:'DELETE'});
    const size = (await stat(file)).size;
    const response = await fetch('https://uploads.github.com/repos/' + repo + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(name), {
      method:'POST', headers:{Authorization:'Bearer ' + token, 'Content-Type':'application/octet-stream', 'Content-Length':String(size)},
      body:createReadStream(file), duplex:'half',
    });
    if (!response.ok) throw new Error('파일 업로드 실패: ' + name + ' HTTP ' + response.status);
    const asset = await response.json();
    if (asset.size !== size || asset.state !== 'uploaded') throw new Error('업로드 검증 실패: ' + name);
    console.log('Uploaded ' + name + ' (' + size + ' bytes)');
  }
  release = await api('/releases/' + release.id, {method:'PATCH',body:JSON.stringify({draft:false,body,make_latest:'false'})});
  console.log('Published ' + release.html_url);
} else console.log('Usage: node native/publish.mjs --check | --publish');
