# 서버 연결형 Android / Windows 앱

앱 실행 시 서버 주소를 입력합니다. 예: `http://0.0.0.0:5173/`.
`0.0.0.0`은 형식 예시이며 실제 접속 주소가 아닙니다. 실제 서버 주소로 바꿔 입력하세요.
서버는 별도로 실행되어 있어야 합니다. Android 8 이상, Windows x64를 지원합니다.

## 설치
- Android: 릴리스의 `OllamaWebUI-Client-1.0.3.apk`를 내려받고 해당 다운로드 앱의 APK 설치를 허용합니다.
- Windows: `*-Setup.exe`로 설치하거나 `*-Portable.exe`를 실행합니다. 상용 코드 서명이 없어 SmartScreen 경고가 발생할 수 있습니다.
- 처음과 재실행 시 주소 입력 화면이 나타납니다. Android 상단/Windows 앱 메뉴에서 서버를 변경합니다.

## 지원과 보안
앱 내부 127.0.0.1 프록시를 사용하여 HTTP 원격 서버에서도 보안 컨텍스트를 제공합니다. 마이크·카메라·클립보드·파일 선택 및 저장을 지원하며, 화면 캡처는 OS/앱 동의 후 실행합니다. Android 공유 및 실행 중 알림 브리지를 포함합니다. Android 화면 캡처는 이 커밋의 서버 프런트엔드가 필요합니다.

HTTP 네트워크 구간은 암호화되지 않습니다. 비밀번호·대화·첨부 파일이 노출/변조될 수 있으므로 신뢰하는 서버만 연결하고 HTTPS를 권장합니다. 인증서 오류는 우회하지 않습니다. 앱의 로컬 인증 토큰은 원격 서버에 전달하지 않습니다. Windows 페이지는 Node.js 접근 없이 샌드박스에서 실행됩니다.

종료 후 Web Push, 서버 도메인 패스키, 외부 OAuth, 브라우저 전용 확장 등 모든 웹 API를 지원하는 것은 아닙니다. Android 기기에서 카메라·마이크·공유·알림·캡처 권한을 실제 확인해야 합니다. Android 서버 변경은 쿠키를 초기화합니다. 서버별 로컬 데이터는 분리됩니다.

## 업데이트 알림
앱 실행 시 공개 GitHub 릴리스 목록에서 `native-vX.Y.Z` 안정 버전을 확인합니다.
현재 버전보다 높고 해당 OS 설치 파일이 있는 경우 안내하며, 사용자가 선택해야 릴리스 페이지를 엽니다.
서버 주소·로그인 정보는 업데이트 확인 요청에 포함하지 않습니다. GitHub에는 접속 IP가 보일 수 있습니다.
네트워크 실패는 앱 연결을 막지 않으며, 서버 설정 화면(Android) 또는 앱 메뉴(Windows)에서 수동 확인할 수 있습니다.
동일 버전 설치 파일의 교체는 감지하지 않으므로 새 설치 파일 배포 시 버전/태그와 Android versionCode를 올리세요.
업데이트 확인 기능이 없는 구버전에는 이 기능을 소급 적용할 수 없습니다. 먼저 새 버전을 수동 설치해야 합니다.

## OAuth 적용 범위
서버의 공개 OAuth 식별자는 기존 `/api/config`에서 자동으로 내려오므로 사용자가 키를 입력할 필요는 없습니다.
서버 운영자는 공급자 콘솔에 실제 HTTPS origin/callback을 등록해야 합니다. 개인 계정 토큰이나 Client Secret은 앱에 내장하지 않습니다.
카카오 콜백은 `KAKAO_REDIRECT_URI` 또는 `PUBLIC_ORIGIN`을 사용하고, 로그인 시작 시 정한 주소를 교환 시에도 그대로 사용합니다.
로그인을 시작한 브라우저의 state 쿠키가 필요합니다. 다른 origin으로 시작/완료하거나 외부 브라우저로 바꾸면 쿠키는 공유되지 않습니다.
Google은 시스템 브라우저 인증 후 앱으로 돌아오면 nonce·일회성 polling secret으로 앱 세션을 연결합니다. 자동 앱 복귀와 카카오 외부 브라우저 세션 전달은 아직 지원하지 않습니다.
외부 HTTP 서버는 Google의 승인된 원본 정책을 충족하지 않습니다. 서버에 HTTPS를 설정하고 Google 콘솔에 그 주소를 등록한 뒤 앱에서도 HTTPS 주소로 연결해야 합니다. 이미 계정 인증을 마쳤더라도 이 조건은 필요합니다.
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
