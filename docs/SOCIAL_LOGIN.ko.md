# 소셜 로그인(Google) 설정 방법

```text

이 서버 주소: http://<내 PC IP>.nip.io:5173

소셜 로그인은 선택 사항입니다. 설정하지 않아도 아이디·비밀번호 로그인은 됩니다.
키는 .env 파일에 저장되고, 바꾼 뒤에는 서버를 다시 시작해야 적용됩니다.
콘솔 메뉴 이름은 Google이 화면을 바꾸면 조금 다를 수 있습니다.

0. 주소 정하기 (PUBLIC_ORIGIN)
------------------------------
  Google은 http://192.168.0.5:5173 같은 IP 주소를 등록할 수 없습니다.
  nip.io는 DNS 이름만 제공합니다. Google용 HTTPS 요구사항을 없애 주지 않습니다.
  Google 웹 로그인은 localhost 외에는 유효한 인증서가 있는 HTTPS 주소를 사용하세요.
  (nip.io는 그 IP로 그대로 연결해 주는 공개 DNS입니다. 첫 실행이 자동으로 정해 줍니다.)
  밖에서 접속한다면 공인 IP로 같은 형식을 쓰고, 공유기에서 포트를 열어 주세요.
  .env 의 PUBLIC_ORIGIN 이 이 주소입니다. 주소를 바꾸면 아래 콘솔 등록값도 함께 바꾸세요.

1. Google 로그인
---------------
  ① https://console.cloud.google.com 에 Google 계정으로 로그인합니다.
  ② 위쪽 프로젝트 선택 → [새 프로젝트] → 이름(예: ollama-webui) → [만들기].
  ③ 왼쪽 메뉴 [API 및 서비스] → [OAuth 동의 화면] (새 화면에서는 [Google 인증 플랫폼]) → [시작하기]
     - 앱 이름: 아무 이름 / 사용자 지원 이메일: 내 이메일
     - 대상(사용자 유형): [외부]
     - 연락처 이메일 입력 → 정책 동의 → [만들기]
  ④ [대상(Audience)] 메뉴에서
     - 게시 상태가 "테스트"이면 [테스트 사용자 추가]로 로그인할 Google 계정을 넣거나,
     - 공개 서비스는 [앱 게시] 및 콘솔에서 요구하는 브랜드·도메인 검증을 완료하세요.
  ⑤ [클라이언트(사용자 인증 정보)] → [클라이언트 만들기 / + 사용자 인증 정보 만들기 → OAuth 클라이언트 ID]
     - 애플리케이션 유형: [웹 애플리케이션]
     - [승인된 JavaScript 원본]에 아래를 하나씩 추가:
        http://localhost:5173
     - [승인된 리디렉션 URI]에 아래를 추가 (Android·Windows 앱에서 Google 계정 선택 창을 바로 띄우는 데 씁니다):
        http://127.0.0.1:47615/api/auth/native/google/callback
     - [만들기] → 나오는 "클라이언트 ID"(…apps.googleusercontent.com)를 복사합니다.
       클라이언트 보안 비밀번호(Secret)는 필요 없습니다.
  ⑥ .env 에 저장:  VITE_GOOGLE_CLIENT_ID=복사한_클라이언트_ID
  ⑦ Google 설정은 반영까지 5분~몇 시간 걸릴 수 있습니다.
  자주 나는 오류
     - "origin_mismatch" / 버튼이 안 뜸 : ⑤의 JavaScript 원본에 지금 접속한 주소가 없습니다.
     - 앱에서 중간 페이지가 먼저 뜸     : ⑤의 리디렉션 URI가 아직 없거나 반영 전입니다. Google에 반영된 뒤 다시 시도하세요(거절 결과는 1분 캐시).
     - "403 access_denied"               : ④에서 테스트 사용자에 계정을 넣지 않았습니다.

2. 적용
-------
  .env 를 저장한 뒤 서버를 다시 시작하세요. 웹에서 로그인 화면을 새로고침하면 버튼이 보입니다.
  이 안내를 다시 보려면:  node server/first-run.mjs --reconfigure
  앱과 서버를 함께 업데이트하세요. 파일을 설치해도 실행 중인 옛 서버는 재시작 전까지 그대로입니다.
  공식 Google 안내: https://developers.google.com/identity/protocols/oauth2/web-server

```
