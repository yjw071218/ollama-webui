# 서버 연결형 Android / Windows 앱

앱 실행 시 서버 주소를 입력합니다. 예: `http://0.0.0.0:5173/`.
`0.0.0.0`은 형식 예시이며 실제 접속 주소가 아닙니다. 실제 서버 주소로 바꿔 입력하세요.
서버는 별도로 실행되어 있어야 합니다. Android 8 이상, Windows x64를 지원합니다.

## 설치
- Android: 릴리스의 `OllamaWebUI-Client-1.0.6.apk`를 내려받고 해당 다운로드 앱의 APK 설치를 허용합니다.
- Windows: `*-Setup.exe`로 설치하거나 `*-Portable.exe`를 실행합니다. 상용 코드 서명이 없어 SmartScreen 경고가 발생할 수 있습니다.
- 처음에만 주소를 입력하고 이후 저장된 서버로 자동 연결합니다. 연결 실패 또는 서버 변경 시 주소 화면이 열립니다. Android는 왼쪽 아래 프로필 메뉴의 `새로고침`·`서버 변경`(또는 뒤로 가기), Windows는 앱 메뉴에서 서버를 변경합니다.
- 계정으로 처음 로그인한 기기는 동기화가 끝날 때까지 진행률(%) 화면이 표시되고, 끝나면 앱이 열립니다.

## 지원과 보안
앱 내부 127.0.0.1 프록시를 사용하여 HTTP 원격 서버에서도 보안 컨텍스트를 제공합니다. 마이크·카메라·클립보드·파일 선택 및 저장을 지원하며, 화면 캡처는 OS/앱 동의 후 실행합니다. Android 공유 및 실행 중 알림 브리지를 포함합니다. Android 화면 캡처는 이 커밋의 서버 프런트엔드가 필요합니다.

HTTP 네트워크 구간은 암호화되지 않습니다. 비밀번호·대화·첨부 파일이 노출/변조될 수 있으므로 신뢰하는 서버만 연결하고 HTTPS를 권장합니다. 인증서 오류는 우회하지 않습니다. 앱의 로컬 인증 토큰은 원격 서버에 전달하지 않습니다. Windows 페이지는 Node.js 접근 없이 샌드박스에서 실행됩니다.

종료 후 Web Push, 서버 도메인 패스키, 외부 OAuth, 브라우저 전용 확장 등 모든 웹 API를 지원하는 것은 아닙니다. Android 기기에서 카메라·마이크·공유·알림·캡처 권한을 실제 확인해야 합니다. Android 서버 변경은 쿠키를 초기화합니다. 서버별 로컬 데이터는 분리됩니다.

## Windows 전용 UI (1.0.6)
운영체제 강조색과 무관한 앱 상단 바를 사용합니다. 웹 콘텐츠는 별도 샌드박스 뷰에 있고 상단 바의 IPC에 접근할 수 없습니다.
확인·오류·권한·업데이트·화면 선택은 앱 테마 팝업을 사용합니다. ESC/닫기는 취소이며, 파일 선택·저장 및 OS 자체 권한 창은 운영체제 UI를 유지합니다.

## 앱 안 업데이트 (1.0.7)
앱 실행 시 공개 GitHub 릴리스 목록에서 `native-vX.Y.Z` 안정 버전을 확인하고, 새 버전이 있으면 업데이트 창을 엽니다.
창에는 릴리스 본문의 `## 이번 버전` 부분(`native/RELEASE_NOTES.md`에서 생성), 크기, 다운로드 진행률·속도·남은 시간이 표시됩니다.
- 다운로드는 `github.com`과 GitHub 자산 호스트(HTTPS)로만 리다이렉트를 따라가며, 릴리스의 크기와 `SHA256SUMS.txt`의 SHA-256이 일치할 때만 설치합니다. 일치하지 않으면 파일을 지웁니다.
- Windows 설치형: NSIS 설치 파일을 `--updated /S --force-run`으로 실행해 기존 설치 위치에 조용히 설치하고 다시 시작합니다. "종료할 때 설치"를 고르면 앱 종료 시 설치하고 다시 시작하지 않습니다.
- Windows 포터블: 앱이 종료되면 기존 exe를 새 파일로 바꿔(바로가기 유지) 다시 실행합니다.
- Android: APK가 같은 패키지·릴리스 버전·현재 앱과 같은 서명인지 확인한 뒤 Android 설치 화면을 엽니다. 처음 한 번 "출처를 알 수 없는 앱 설치" 허용이 필요하며, 설치 확인 버튼은 Android 정책상 생략할 수 없습니다.
- 수동 확인: Windows 상단 바의 `업데이트` 버튼·앱 메뉴, Android 프로필 메뉴의 `업데이트 확인` 또는 서버 설정 화면. `이 버전 건너뛰기`는 자동 알림에만 적용됩니다.
- 1.0.6 이하는 이전 방식(릴리스 페이지 열기)이므로 1.0.7은 한 번 직접 설치해야 합니다.
서버 주소·로그인 정보는 업데이트 요청에 포함하지 않습니다. GitHub에는 접속 IP가 보일 수 있습니다.
동일 버전 설치 파일의 교체는 감지하지 않으므로 새 설치 파일 배포 시 버전/태그, Android versionCode, `native/RELEASE_NOTES.md`를 올리세요.
업데이트 확인 기능이 없는 구버전에는 이 기능을 소급 적용할 수 없습니다. 먼저 새 버전을 수동 설치해야 합니다.

## OAuth 적용 범위
서버의 공개 OAuth 식별자는 기존 `/api/config`에서 자동으로 내려오므로 사용자가 키를 입력할 필요는 없습니다.
서버 운영자는 공급자 콘솔에 실제 HTTPS origin/callback을 등록해야 합니다. 개인 계정 토큰이나 Client Secret은 앱에 내장하지 않습니다.
카카오 콜백은 `KAKAO_REDIRECT_URI` 또는 `PUBLIC_ORIGIN`을 사용하고, 로그인 시작 시 정한 주소를 교환 시에도 그대로 사용합니다.
로그인을 시작한 브라우저의 state 쿠키가 필요합니다. 다른 origin으로 시작/완료하거나 외부 브라우저로 바꾸면 쿠키는 공유되지 않습니다.
Google과 카카오는 시스템 브라우저에서 인증하고 일회성 polling secret으로 앱 세션을 연결합니다. 자동 앱 복귀는 보장하지 않습니다.
Google 계정 선택 창 바로 열기(1.0.8): 앱은 로그인하는 동안만 `127.0.0.1:47615`에서 Google의 응답을 받고(`desktop/googleLoopback.mjs`, `GoogleLoopback.java`), ID 토큰을 앱 게이트웨이를 거쳐 서버 `/api/auth/native/finish`로 넘깁니다. 서버가 audience와 nonce(=일회성 로그인 ID)를 검증합니다.
켜려면 Google 콘솔 웹 클라이언트의 승인된 리디렉션 URI에 `http://127.0.0.1:47615/api/auth/native/google/callback` 하나만 등록하면 됩니다. 서버(v1.0.3+)가 `/api/auth/native/google/ready`에서 Google에 등록 여부를 확인하며(거절은 1분, 허용은 6시간 캐시), 등록 전·포트 사용 중·옛 서버에서는 기존 중간 페이지를 엽니다. 단계별 설정: `docs/SOCIAL_LOGIN.ko.md`.
카카오는 서버가 앱 전용 경로를 모르면(HTTP 404, 서버 v1.0.2 이하) 앱 안 카카오 로그인으로 자동 전환합니다.
Google WebView 로그인을 지원하는 것처럼 표시하거나 인증서/브라우저 정책을 우회하지 않습니다.
실제 공급자 로그인, 모바일 실기기 및 기존 앱에서 업데이트 설치 검증은 별도 확인이 필요합니다.

## 시간 제한
채팅 작업의 기본 30분 종료와 Ollama 30분 종료/기본 무응답 제한을 제거했습니다. llama.cpp 생성 요청 및 앱 프록시도 생성 응답에 시간 제한을 두지 않습니다. 명시적으로 설정한 CLI_TIMEOUT_* / OLLAMA_IDLE_TIMEOUT_MS 제한은 별도입니다. 사용자 취소, 연결 오류, 메모리 한도, 연결 수 제한 및 연결 준비/헤더/TLS 제한은 유지합니다. 서버 코드 수정은 실행 중 서버 재시작 후 적용됩니다.

## 빌드와 테스트
```powershell
npm ci --prefix native/desktop
node --test native/tests/*.test.mjs
node native/tests/desktop-smoke.mjs
npm run pack --prefix native/desktop
powershell -ExecutionPolicy Bypass -File native/bootstrap-android.ps1
powershell -ExecutionPolicy Bypass -File native/build-android.ps1
```
출력은 `native/artifacts/windows` 및 `native/artifacts/android`입니다. Android SDK 라이선스가 필요합니다. 로컬 릴리스 서명 키와 비밀번호는 `native/.tools`에만 보관하며 Git에 추가하지 않습니다. 같은 앱 업데이트를 위해 이 키를 안전하게 백업해야 합니다. CI Android APK는 별도 debug ID/서명이며 공개 릴리스 APK와 다릅니다.
