# Studio 전용 브라우저

일반 링크의 기본값은 Playwright 전용 브라우저입니다. 연결 설정의 **링크를 여는 브라우저**에서 시스템 기본 브라우저로 변경합니다. 화면은 저장된 선택, 실제 라우팅, 사용 불가 사유와 복구 상태를 각각 표시합니다. 선택은 사용자 설정 디렉터리의 별도 `browser-settings.json`에 원자적으로 저장하며 기존 0.1.24 설정 파일 형식을 바꾸지 않습니다.

계정·게시·업로드 OAuth 로그인은 항상 시스템 기본 브라우저로 엽니다. 인증 URL은 Rust에서 사용하고 renderer 응답에서 제거합니다. 전용 브라우저의 인증 리디렉션과 팝업도 시스템 브라우저로 넘기며 중복 요청을 억제합니다. 계정 쿠키·토큰·페이지 내용은 renderer나 AI에 전달하지 않습니다. Studio 전용 프로필을 사용하고 개인 Chrome·Aside 쿠키를 가져오지 않습니다.

Rust가 고정된 Node 작업자를 관리합니다. IPC는 `open_external({url,browser?})`, `browser_runtime_status()`, `save_browser_preferences({input:{browser}})`입니다. `browser`는 `system` 또는 `playwright`만 받으며 실행 파일·셸·JavaScript 입력은 없습니다. 작업자는 Playwright Library로 브라우저 시작·링크 열기·종료와 인증 주소의 시스템 브라우저 전달만 처리합니다. Opal 복구나 AI 브라우저 조작은 포함하지 않습니다.

Playwright는 macOS 14 이상·Windows 11 이상에서 제공하며 미지원 OS는 Node를 실행하지 않고 시스템 브라우저를 사용합니다. 앱의 기존 macOS 12 지원을 유지합니다. [Playwright 지원 범위](https://playwright.dev/docs/intro#system-requirements), [Google OAuth 브라우저 정책](https://developers.google.com/identity/protocols/oauth2/policies#use-secure-browsers)을 따릅니다.

## 번들

`desktop/src-tauri/resources/browser/manifest.json`은 Node 24.16.0, playwright-core 1.63.0, Chromium revision 1243 / Chrome for Testing 153.0.8010.12의 플랫폼별 원본 URL·SHA256·바이트 크기·아키텍처·라이선스 정보를 고정합니다. 브라우저 추출기는 경로 이탈·중복·특수 파일을 거부하고 크기와 파일 수를 제한합니다. Mac 배포본의 상대 링크 다섯 개만 허용합니다.

Node 실행 파일, Playwright Library와 headed Chrome만 번들합니다. npm·pnpm·Playwright 테스트 러너·Firefox·WebKit·headless-shell은 포함하지 않습니다. Mac의 Node와 Chrome은 `Contents/Helpers/studio-browser`에 배치하고 개별 서명한 다음 상위 앱을 서명합니다. JavaScript 작업자·Playwright Library·라이선스는 `Contents/Resources/studio-browser`에 보관합니다. Studio 본체에는 JIT 권한을 추가하지 않습니다. Codexify·cloudflared의 macOS 12 배포 대상 검증을 유지하고 설치/업데이트 파일의 512 MiB 제한을 적용합니다.

공개 배포와 설치된 앱 교체는 이번 구현 범위에 포함하지 않습니다. 검증 결과는 [브라우저 전환 검증 기록](BROWSER_RUNTIME_VALIDATION.md)에 기록합니다.
