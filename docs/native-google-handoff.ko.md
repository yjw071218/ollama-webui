# 네이티브 Google 로그인 변경 (2026-10-03)

- Windows/Android 내부 프록시에서 Google GIS를 실행하지 않고, 입력한 서버의 /api/auth/native/page를 시스템 브라우저로 연다.
- Google client ID는 서버의 기존 설정을 사용한다. 앱에 프로젝트 공통 키나 비밀키를 추가하지 않는다.
- 요청별 Google nonce 검증, 앱 전용 polling secret, 5분 만료, 일회성 소비를 적용했다.
- 인증 후 사용자가 앱으로 돌아오면 기존 Google 로그인 API를 통해 앱 세션을 생성한다. **자동 앱 복귀(deep link)는 아직 구현하지 않았다.**
- 서버 코드와 웹 빌드, 네이티브 클라이언트를 함께 업데이트해야 한다.
- 서버의 실제 브라우저 주소가 Google에 승인된 원본이어야 한다. 외부 HTTP 주소의 Google 정책 제한이나 잘못된 원본 등록을 우회하지 않는다.
- 서버 접근 토큰을 요구하는 설치에서는 외부 브라우저도 별도로 서버 접근 인증이 필요할 수 있다.
- Kakao 네이티브 브라우저 handoff는 이번 변경에 포함하지 않았다.

## 검증
- 신규 handoff/nonce/게이트웨이 테스트 5개 통과.
- 기존 Windows navigation 테스트 3개 통과.
- scripts/auth.test.mjs: 113개 통과.
- native/tests/*.test.mjs: 21개 통과 (navigation 3개 포함).
- 개발 Electron smoke test 통과.
- 웹 프로덕션 빌드 성공.
- Android release 빌드, lintRelease, APK 서명 검증 성공.
- Windows NSIS 및 portable 빌드 성공.

실제 Google 계정의 브라우저 인증 및 Android 실기기 종단간 테스트는 미실시.
GitHub 업로드는 수행하지 않았다.
