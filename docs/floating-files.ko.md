# 플로팅 버튼과 AI 파일 제작 (2.0.4)

## Android

프로필 메뉴의 **AI 플로팅 버튼 켜기**, 또는 텍스트 선택 후 AI에게 묻기의 **−** 버튼으로 활성화합니다. 최초 한 번 Android의 다른 앱 위에 표시 권한을 허용해야 합니다. 원형 버튼은 드래그로 이동하고 누르면 임시 질문 화면을 엽니다. 길게 누르거나 알림의 버튼 끄기로 종료합니다. 임시 질문은 기존 로그인 쿠키를 사용하며 대화 저장·동기화를 실행하지 않습니다. 질문마다 세션을 갱신하고 실패한 입력을 보존합니다. 닫거나 접을 때 임시 질문 내용은 사라집니다.

첨부된 이전 화면의 메인 UI·질문 다이얼로그는 새 APK에서 사용하지 않습니다. 서버 업데이트만으로 APK 내부 UI가 바뀌지는 않습니다.

## 미리보기와 다운로드

문서 카드의 미리보기는 모든 슬라이드, 표, 본문을 보여 줍니다. 실제 파일 보기는 생성된 오피스 파일을 서버의 LibreOffice 등 기존 변환기로 PDF 변환하여 표시합니다. 기본 미리보기는 변환기 없이 사용할 수 있습니다. PDF는 브라우저 내장 플러그인 대신 PDF.js로 그려 Android에서도 페이지 이동·확대가 가능합니다. 변환을 지원하지 않는 파일은 원본 다운로드를 제공합니다.

Windows 다운로드는 Electron의 실제 수신 바이트와 완료 이벤트를 표시합니다. Android는 저장 선택기 이후 실제 저장 진행 및 결과를 표시합니다. 일반 브라우저는 브라우저로 전달된 상태까지만 표시하며 완료를 임의로 보고하지 않습니다.

모바일의 로컬 파일 링크는 해당 계정의 저장된 assistant 메시지에 포함된 파일 링크만 인증·CSRF 검증 후 읽습니다. 상대 경로·실행 파일·다른 계정의 링크는 허용하지 않습니다. 저장된 대화가 아직 동기화되지 않았거나 서버 파일이 이동된 경우 오류를 표시합니다. PC 클라이언트의 기존 로컬 열기 기능도 유지합니다.

## 디자인과 추가 형식

PPT는 14개 레이아웃과 6개 테마를 지원합니다. freeform의 elements는 rect/ellipse/text/image를 받습니다. 좌표 단위는 인치, 캔버스는 13.333 × 7.5이며 최대 80개 요소를 허용합니다. text는 size(포인트), color, bold를, 도형은 fill을, 이미지는 src를 사용합니다. 이미지 주소는 실제 PNG/JPEG/WebP 자료를 사용하고 최대 10 MB입니다. 미리보기와 PPTX는 같은 배치 데이터를 사용합니다. 긴 문장은 글자 크기를 줄이되 발표용 가독성을 위해 여러 슬라이드로 나누는 것이 좋습니다.

기존 office JSON에 format: tex/pdf/html/svg/md/json 및 title, text를 넣을 수 있습니다. tex 카드는 PDF 만들기를 추가 제공합니다. pdf의 text가 documentclass로 시작하면 LaTeX, 그 외에는 본문을 오피스 변환기로 PDF로 변환합니다. HTML·SVG 미리보기는 스크립트 권한 없는 iframe에서 열립니다.

LaTeX 서버 준비: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-latex.ps1`. 공식 Tectonic Windows 실행 파일을 설치하며 제공되는 SHA-256을 검사합니다. 다른 OS는 Tectonic을 설치하거나 TECTONIC_PATH로 경로를 지정합니다. 첫 실행에는 패키지 다운로드가 필요합니다. 변환 제한은 5분, 원문 200,000자, PDF 50 MB이며 한 번에 하나만 변환합니다. 파일 I/O·매크로 정의·셸 실행을 허용하지 않는 제한된 명령/패키지와 Tectonic untrusted 모드를 사용합니다. 제한 밖 문서는 원본을 다운로드할 수 있고 변환 실패 이유가 표시됩니다.

검증: `node --test scripts/floating-files.test.mjs scripts/answer-presentation.test.mjs native/tests/quickask.test.mjs`, `node native/tests/quickask.browser.mjs`, `node scripts/answer-presentation.browser.test.mjs`, `node scripts/office-suite.browser.test.mjs`, 웹 빌드와 Android assembleRelease/lintRelease, Windows 패키지 smoke.
