# 서버 연결형 Android / Windows 앱

앱 실행 시 서버 주소를 입력합니다. 예: `http://218.48.73.149.nip.io:5173/`.
서버는 별도로 실행되어 있어야 합니다. Android 8 이상, Windows x64를 지원합니다.

## 설치
- Android: 릴리스의 `OllamaWebUI-Client-1.0.0.apk`를 내려받고 해당 다운로드 앱의 APK 설치를 허용합니다.
- Windows: `*-Setup.exe`로 설치하거나 `*-Portable.exe`를 실행합니다. 상용 코드 서명이 없어 SmartScreen 경고가 발생할 수 있습니다.
- 처음과 재실행 시 주소 입력 화면이 나타납니다. Android 상단/Windows 앱 메뉴에서 서버를 변경합니다.

## 지원과 보안
앱 내부 127.0.0.1 프록시를 사용하여 HTTP 원격 서버에서도 보안 컨텍스트를 제공합니다. 마이크·카메라·클립보드·파일 선택 및 저장을 지원하며, 화면 캡처는 OS/앱 동의 후 실행합니다. Android 공유 및 실행 중 알림 브리지를 포함합니다. Android 화면 캡처는 이 커밋의 서버 프런트엔드가 필요합니다.

HTTP 네트워크 구간은 암호화되지 않습니다. 비밀번호·대화·첨부 파일이 노출/변조될 수 있으므로 신뢰하는 서버만 연결하고 HTTPS를 권장합니다. 인증서 오류는 우회하지 않습니다. 앱의 로컬 인증 토큰은 원격 서버에 전달하지 않습니다. Windows 페이지는 Node.js 접근 없이 샌드박스에서 실행됩니다.

종료 후 Web Push, 서버 도메인 패스키, 외부 OAuth, 브라우저 전용 확장 등 모든 웹 API를 지원하는 것은 아닙니다. Android 기기에서 카메라·마이크·공유·알림·캡처 권한을 실제 확인해야 합니다. Android 서버 변경은 쿠키를 초기화합니다. 서버별 로컬 데이터는 분리됩니다.

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
