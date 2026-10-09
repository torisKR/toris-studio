# 설치 앱의 ChatGPT MCP 연결과 YouTube 게시 QA

## 지원 범위

`0.1.14`부터 **채널과 연결 → 연결·게시 QA**에서 설정합니다. ChatGPT 브라우저 로그인, MCP 도구 왕복, 파일 수신, YouTube OAuth 업로드 권한, 실제 게시 결과는 별개의 상태입니다. 앱은 브라우저 쿠키·세션을 추출하지 않고 연결이 안 된 단계를 완료라고 표시하지 않습니다.

이 버전은 기존 에셋 제작/규격 변환과 설치 환경의 연결·게시 QA를 완성하는 업데이트입니다. `docs/superpowers/specs/2026-10-09-ai-first-asset-operations-design.md`의 AI 작업 DAG/상주 실행기 전체 구현 버전은 아닙니다.

## ChatGPT와 MCP

설치 앱의 **설치 앱 MCP 설정 복사**를 사용하면 현재 설치된 실행 파일 경로와 `--studio-mcp` 인자가 포함된 stdio 설정을 얻습니다. macOS와 Windows 모두 Rust 실행 파일 자체가 에셋 MCP 서버입니다. Node.js, pnpm, 개발용 체크아웃이 필요하지 않습니다. 해당 실행 경로는 GUI와 OAuth 저장소를 시작하지 않고 동일한 로컬 에셋 저장소만 사용합니다.

서버는 JSON-RPC stdio MCP의 initialize, ping, tools/list, tools/call을 지원합니다. 기존 8개 에셋 도구와 `studio_connection_check`를 제공합니다. 호출/파일 수신 시각은 로컬 에셋 저장소에 기록합니다. 이 기록은 호출한 클라이언트의 실제 ChatGPT 계정 신원을 인증한 증거는 아닙니다.

ChatGPT 웹에서 로컬 stdio를 사용하려면 공식 **Secure MCP Tunnel**을 준비하세요. 복사한 실행 파일과 인자를 터널의 로컬 MCP 명령으로 연결하고, 대상 ChatGPT 워크스페이스에 터널을 연결합니다. 터널 ID, 런타임 인증키, 워크스페이스 권한과 사용자 로그인은 별도입니다. 앱에 키를 하드코딩하거나 공개 무인증 터널을 만들지 않습니다. 터널은 모델 생성 권한이나 사용 한도를 늘리지 않습니다.

ChatGPT에 연결한 후 앱의 **확인 요청 복사** 내용을 대화에 전달합니다. 실제 파일 전달 확인에는 `studio_asset_request`로 작업을 만들고 생성 기능을 지원하는 ChatGPT 대화에서 이미지 생성 후 `studio_asset_receive`를 호출합니다. 실제 결과가 저장돼야 수신 시각이 갱신됩니다. 없는 생성물을 보관함에 자동으로 추가하지 않습니다.

개발용 `pnpm assets:mcp` 경로는 호환을 위해 남겨 둡니다. 설치 사용자는 복사한 네이티브 MCP 설정을 사용하세요. 네이티브 수신은 HTTPS `oaiusercontent.com` 또는 그 하위 도메인의 직접 다운로드만 허용하고 파일을 32 MiB로 제한합니다. OAuth 자격 증명과 게시 도구는 에셋 MCP에 노출하지 않습니다.

## YouTube 업로드 권한

**OAuth 앱 설정**에서 기존 Google 데스크톱 OAuth Client ID를 저장한 후 **업로드 권한 승인**을 누릅니다. 기본 읽기 전용 SNS 로그인과 다르게 이 경로는 `youtube.readonly`와 `youtube.upload`를 요청합니다. 권한 추가는 사용자가 시스템 브라우저에서 승인합니다. 기존 세션은 새 인증이 성공하기 전까지 보존합니다.

업로드 권한은 실제 OAuth 응답의 scope로 판단합니다. 예전 세션에 scope 기록이 없으면 업로드 허용으로 추정하지 않습니다. Google이 scope를 생략한 갱신 응답은 이전에 확인한 scope를 유지합니다. 로그인·갱신 토큰은 OS 자격 증명 저장소에만 있고 UI, MCP, 로그, Git에 포함되지 않습니다.

이 네이티브 게시 경로는 별도의 웹 업로드 환경 변수나 Next.js 서버를 요구하지 않습니다. 기존 웹 `/api/youtube/upload`는 호환성을 위해 별도의 기존 인증 경로를 유지합니다.

## 공개 게시 QA

현재 실제 게시 어댑터는 **YouTube 영상**입니다. Threads/Instagram/TikTok/네이버 글 게시 기능은 제공하지 않으며 로그인 성공을 게시 성공으로 표시하지 않습니다.

1. 업로드 권한 승인 후 **채널 조회**로 현재 계정의 채널을 조회하고 정확한 대상을 선택합니다.
2. **MP4 선택**으로 64 MiB 이하 영상을 선택하거나 **3초 QA 영상 만들기**를 사용합니다. 생성 기능에는 로컬 FFmpeg가 필요하며 생성만으로 업로드하지 않습니다.
3. 제목·설명·아동용 여부·공개 범위를 지정합니다. 기본 비공개이며 일부 공개와 공개는 외부 노출 동의를 추가로 요구합니다.
4. **게시 준비**를 누릅니다. 입력, 선택 파일, 현재 인증 채널을 검사하고 10분짜리 1회용 확인 티켓에 고정합니다. 이 단계에서는 업로드하지 않습니다.
5. 채널·파일·제목·공개 범위를 최종 확인하고 실제 전송에 동의한 뒤 전송 버튼을 누릅니다.

선택한 파일의 원본은 변경하지 않습니다. 선택 시 읽은 바이트/해시를 티켓에 고정하며 이후 경로를 바꿔 전송 대상을 바꿀 수 없습니다. 게시 시 계정 채널을 다시 검사합니다. Google의 재개형 업로드 프로토콜을 사용하되 자동 재시도는 하지 않습니다. 세션 URL은 HTTPS의 고정 Google 업로드 경로만 허용하고 토큰/세션 URL을 기록하지 않습니다. 구독자 알림은 비활성화됩니다.

응답의 영상 ID·채널·실제 공개 범위를 검증합니다. 프로젝트 심사 정책 등으로 Google이 private로 저장하면 **실제 비공개**라고 표시합니다. ‘저장 확인’과 영상 처리·공개 배포 완료는 구분합니다.

전송 전 기록을 원자적으로 저장하고 프로세스 간 잠금으로 중복 실행을 제한합니다. 실패/앱 종료/통신 단절의 결과가 불명확하면 자동 재전송하지 않습니다. YouTube Studio에서 확인한 뒤 **전송 결과 확인 완료**를 선택해야 같은 파일을 다시 준비할 수 있습니다. 이 확인은 실제 게시물을 삭제하거나 다시 공개하는 작업이 아닙니다.

## 검증과 배포

- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --test release_integration_contract`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib oauth::upload_tests`
- `node scripts/verify-integration-ui.mjs` (브라우저 IPC fixture; 실제 공개 게시하지 않음)
- `cargo run --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --example publishing_sample_probe -- --generate-local-sample` (실제 로컬 샘플 생성; 전송하지 않음)

기존 업데이트 공개키와 데이터 경로를 유지합니다. 세 플랫폼 설치 파일과 서명/검증 manifest가 모두 준비된 뒤 GitHub Release와 GitHub Packages OCI에 배포합니다. 앱 업데이트는 공개 Release의 `latest.json`을 사용하며, package visibility와 무관합니다. Apple 공증·Windows Authenticode는 Tauri 업데이트 서명과 별개입니다.

공식 자료(확인: 2026-10-09):
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.google.com/youtube/v3/docs/videos/insert
- https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
- https://v2.tauri.app/plugin/updater/
