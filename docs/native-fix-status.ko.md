# 네이티브 클라이언트 수정 현황 (2026-10-03, 1.0.3)

## 구현 및 검증
- Windows: 최초 탐색이 취소돼도 실제 신뢰한 페이지 로딩 완료를 기다림(`ERR_ABORTED (-3)` 연결 오류 수정). Electron smoke 테스트 통과.
- Android/Windows: 실행 시 GitHub의 `native-v*` 정식 릴리스를 확인하고, 새 버전이면 업데이트 안내 → 릴리스 페이지 열기.
- Android/Windows 아이콘: `src/Logo.jsx`·`public/favicon.svg`의 새 대화 로고와 같은 도형.
- 카카오 로그인: 로그인 페이지(kauth/accounts/logins.kakao.com, HTTPS만)를 앱 창 안에서 열고, 서버 주소로 돌아오는 콜백을 앱 내부 주소로 바꿔 state 쿠키가 일치하도록 수정. 이전에는 외부 브라우저로 열려 "Sign-in browser could not be verified"로 실패.
- Google 로그인: 앱(WebView/Electron)에서는 Google이 내장 브라우저 로그인을 막으므로, 시스템 브라우저에서 서버 주소의 `/api/auth/native/page`로 인증 → nonce·일회성 비밀값으로 앱 세션에 전달.
  이전 버전에 있던 "외부 HTTP 주소 차단" 문구를 제거. Google 콘솔에 등록된 원본(예: `http://0.0.0.0.nip.io:5173` 형식)이면 그대로 동작하며, 판단은 Google이 함.
- OAuth 키는 서버(.env)에 있고 앱에는 넣지 않음. 앱을 설치한 누구나 그 서버의 로그인 버튼으로 본인 계정 로그인 가능.

## 개인정보 검사
- 추적·미추적(무시 제외) 텍스트 518개 검사: 공인 IP 0건. 테스트/문서의 실제 내부망 주소도 예시 주소로 교체.
- 새 APK(68개 파일), Windows app.asar, 웹 dist(275개 파일) 바이트 검사: IP 0건.
- 남은 곳(배포 대상 아님): `server/data`(대화 DB·백업, .gitignore 대상), `.env`, 로그.
- Git 기록: 커밋 1개(b7aef32, 원격 태그 `native-v1.0.0`·`native-v1.0.2`가 가리킴)의 `native/desktop/setup.html` 예시에 IP가 남아 있음. 기록 재작성/태그 삭제는 승인 후 진행.

## 남은 작업
1. 실행 중인 서버 재시작(새 `/api/auth/native/*` API 적용에 필요).
2. 실기기에서 카카오/Google 로그인 확인.
3. 위 Git 기록 정리 여부 결정.
