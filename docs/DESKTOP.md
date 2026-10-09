# Toris Studio 데스크톱

Toris Studio는 macOS·Windows용 Tauri 앱입니다. `desktop/src-tauri`의 Rust가 DB, SNS OAuth, API 요청, AI 연결, 로컬 파일 저장과 영상 처리를 담당합니다. `desktop/src`의 React 화면은 검증된 Tauri 명령을 호출합니다. 데스크톱 앱 실행에 Next.js 서버는 필요하지 않습니다.

시스템 WebView를 사용해 Chromium을 함께 배포하지 않는 Tauri를 선택했습니다. macOS와 Windows의 WebView 차이는 각 OS에서 확인해야 합니다. UI·Rust 검증과 Windows 설치 파일의 실제 실행 검증은 별개의 단계입니다.

실행 결과와 아직 검증하지 않은 범위는 [로컬 검증 기록](DESKTOP_VALIDATION.md)에 정리했습니다.

## 개발 실행

0.1.20부터 **코딩** 메뉴에서 Open WebUI 로컬 컨테이너를 시작하고 전용 앱 창으로 엽니다. ChatGPT 작업 전달 상태와 MCP 연결 진단도 이 메뉴에서 확인합니다. [Open WebUI 설치·연결 안내](OPEN_WEBUI.md)를 참고하세요.

저장소 루트에서 Node.js 24, pnpm, Rust stable을 설치한 뒤 실행합니다. macOS는 Xcode Command Line Tools, Windows는 Visual Studio C++ Build Tools와 WebView2가 필요합니다.

```bash
pnpm install --frozen-lockfile
pnpm desktop:dev
```

Tauri CLI가 `127.0.0.1:1420`의 Vite 화면과 Rust 앱을 함께 실행합니다. 데스크톱 화면만 빌드하려면 `pnpm desktop:ui`, Rust와 화면 타입 검사는 `pnpm desktop:check`를 사용합니다. `cargo run --manifest-path desktop/src-tauri/Cargo.toml -- --self-check`는 민감한 값을 제외한 로컬 연결 상태를 출력합니다.

## 앱 빌드

macOS:

```bash
pnpm --dir desktop exec tauri build --bundles app,dmg
```

결과는 `desktop/src-tauri/target/release/bundle/macos/Toris Studio.app`와 `bundle/dmg/`에 생성됩니다. 앱을 실행하면 설치된 브라우저 탭 대신 전용 앱 창을 사용합니다.

Windows PowerShell:

```powershell
pnpm --dir desktop exec tauri build --bundles nsis
```

결과는 `desktop/src-tauri/target/release/bundle/nsis/`에 생성됩니다. `.github/workflows/desktop.yml`에는 macOS·Windows 빌드 경로가 준비되어 있습니다. Windows CI 구성과 실제 Windows 기기에서 설치·OAuth·DB·영상 출력을 확인한 결과를 혼동하지 마세요. macOS 로컬 빌드와 별도로 Windows 실행 검증이 필요합니다.

공개 CI는 macOS Apple Silicon·Intel과 Windows x64 설치 파일을 빌드하며 서명한 updater 파일을 GitHub Releases·Packages에 보관합니다. 앱의 **연결 설정 → 앱 업데이트**로 설치합니다. Apple Developer ID 공증과 Windows Authenticode 서명은 아직 설정되지 않았으며 updater 서명과 별개입니다. 절차는 [배포 안내](RELEASE.md)를 참고하세요.

설치 아이콘 원본은 `desktop/logo-full.png`입니다. 로고를 교체한 뒤 다음 명령으로 macOS ICNS와 Windows ICO를 함께 생성하고 앱을 다시 빌드하세요. PNG의 투명 배경을 유지합니다.

```bash
pnpm --dir desktop exec tauri icon logo-full.png --output src-tauri/icons
pnpm desktop:build
```

macOS 27에서 Rust의 `mis-aligned LINKEDIT string pool` 오류가 발생하는 것을 피하기 위해 release 빌드의 `strip`을 `none`으로 설정합니다. [Rust 공식 이슈](https://github.com/rust-lang/rust/issues/157750)를 참고하세요.

## 로컬 DB

macOS는 OrbStack, Windows는 Docker Desktop을 실행한 뒤 앱의 **연결 설정 → DB 컨테이너 실행 · 초기화**를 누릅니다. Rust가 PostgreSQL 컨테이너를 실행하고 기존 데이터를 유지하면서 스키마를 준비합니다. 새 DB의 앱 연결 주소를 준비한 뒤 대시보드에서 실제 연결을 다시 확인합니다.

기본 포트는 `127.0.0.1:54329`이며 데이터는 Docker 볼륨에 남습니다. 콘텐츠·채널·트렌드 기록이 이 DB에 저장됩니다. 컨테이너가 꺼져 있으면 읽기·저장을 다시 시도하기 전에 실행하세요.

**DB 백업 저장**은 로컬 컨테이너에 `pg_dump`를 실행하고 결과 파일의 경로와 크기를 화면에 표시합니다. 백업은 설정 디렉터리의 `backups/social-*.dump`입니다. 백업 파일에는 실제 콘텐츠가 들어가므로 GitHub에 추가하지 않습니다. 복원은 자동 버튼으로 제공하지 않습니다.

DB 컨테이너 실행에 필요한 비밀번호는 Git에서 제외된 `.env.db.local`에 보관합니다. 데스크톱 앱이 사용하는 DB 주소·API 키·SNS 비밀 정보는 OS 자격 증명 저장소에 보관하며 일반 설정 JSON에는 민감한 값을 넣지 않습니다. 앱에 표시되는 설정 파일 경로는 일반 설정의 위치입니다.

## YouTube와 SNS

**연결 설정 → 수집 API**에 YouTube Data API KEY를 저장하면 **YouTube 관리**에서 `@핸들`, `UC` 채널 ID 또는 채널 URL로 공개 채널 성과와 최근 영상을 조회할 수 있습니다. 키로 비공개 영상·수익 조회, 업로드, 제목 수정 권한을 얻지는 않습니다.

수집 API의 YouTube 키·네이버 ID·시크릿에는 개별 **저장됨 / 미등록** 표시가 있습니다. **저장된 값 → 보기**를 누르면 해당 항목만 Rust에서 읽어 표시하고, **숨기기**나 화면 이동·설정 작업 시 표시값을 비웁니다. **변경할 때만 입력** 칸은 별도이며, 저장값을 확인하는 것만으로 키를 변경하지 않습니다. 비워서 저장하면 기존 키를 유지합니다.

**내 채널 → 저장 정보 보기**에서 로컬 DB에 들어간 채널 이름·핸들·URL을 확인하고 다시 숨길 수 있습니다. 채널 등록에는 이름과 선택한 SNS의 공식 HTTPS 채널 URL이 필요합니다. 저장에 성공하면 내 채널 화면으로 이동하며 등록한 채널과 성공 메시지가 표시됩니다. 누락된 입력·저장 실패는 입력 화면에 표시하고 작성한 내용을 유지합니다.

**SNS 로그인**은 계정 권한을 별도로 연결하는 화면입니다. 클라이언트 등록, 리디렉션 주소와 각 플랫폼의 제한은 [OAuth 설정](OAUTH.md)을 참고하세요. 저장된 연결 자체가 콘텐츠 자동 발행이나 다섯 플랫폼 전체의 실시간 인기 데이터 수집을 의미하지 않습니다.

## 키워드 탐색

Opal 메뉴를 **키워드 탐색**으로 교체합니다. 저장 자료 검색, YouTube·네이버 공식 검색과 Google Trends 주제 필터, 콘텐츠별 검색어 확인, 로컬 Crawl4AI 원문 수집을 제공합니다. 본문에서 추출한 단어와 실제 API 검색어는 구분해 표시합니다. 최신 5,000개 검색 범위·본문 앞부분 3,000자 색인·소스별 제한과 컨테이너 실행 방법은 [키워드 탐색 설계](KEYWORD_EXPLORER.md)를 참고하세요.

## AI 연결

OpenCodex 대시보드 `http://localhost:10100/#dashboard`에서 기존 계정 로그인을 완료하고, 앱에는 API 주소 `http://127.0.0.1:10100/v1`와 지원 모델 ID를 입력합니다. teamclaude도 실행 중인 로컬 `/v1` 서비스의 주소와 모델을 설정합니다. **로그인한 Claude CLI 사용**은 이 기기에서 로그인한 CLI를 선택적으로 실행합니다.

구독 계정의 비밀번호·OAuth 토큰을 Toris Studio에 붙여넣지 않습니다. Toris Studio는 각 서비스가 제공한 지원 인터페이스를 호출하며 구독을 임의의 API 사용권으로 바꾸지 않습니다. **AI 작업실**의 연결 확인과 실제 생성 확인은 서로 다른 상태로 표시됩니다. 자세한 로컬 제공자 계약은 [AI 연결 문서](AI_PROVIDERS.md)를 참고하세요.

## 영상과 음성

**트렌드 탐색 → 영상 만들기**, 오버뷰의 영상 버튼 또는 **키워드 탐색 → 영상 스튜디오로 보내기**에서 저장된 소재를 가져올 수 있습니다. 원본과 형식·주제를 확인하고 기본 로컬 초안 또는 연결된 AI의 발췌 대본을 선택하면 출처가 있는 3~5장면의 새 프로젝트를 만듭니다. 기존 영상의 미저장 편집을 보호하고, 새 프로젝트는 저장 후 장면 편집·MP4 출력으로 이어집니다. 자세한 흐름과 현재 출력 범위는 [트렌드·키워드 영상 기획](RESEARCH_VIDEO.md)을 참고하세요.

**영상 스튜디오**의 프로젝트 읽기·편집·슬라이드 이미지 생성·렌더 지시는 Rust에서 처리합니다. MP4 합성에는 별도 설치된 FFmpeg/ffprobe를 사용합니다. 한국어 글꼴과 해당 실행 파일의 설치 여부는 영상 화면에서 확인합니다. Rust 슬라이드 출력은 기존 Remotion 템플릿의 모든 효과를 재현하지 않습니다.

Qwen3-TTS 음성 모델 추론은 별도 로컬 Python/MLX 서비스 `http://127.0.0.1:50010`에서 실행됩니다. Rust가 여기에 요청하고 생성한 WAV를 검증·저장합니다. 모델 추론까지 Rust로 재작성된 것은 아닙니다. Apple Silicon용 MLX TTS를 Windows에서 그대로 실행할 수 있다고 가정하지 마세요. 설치와 모델 다운로드는 [음성 런타임 문서](VOICE.md)를 참고하세요.

## 공개 저장소와 데이터 보관

토큰·API 키·실제 DB 백업·개인 프로젝트·음성·렌더 결과를 소스 변경과 함께 커밋하지 않습니다. `pnpm security:check`로 추적 대상 비밀 정보를 확인하고 `.gitignore`의 로컬 데이터 제외를 유지합니다. OS 저장소 접근을 거부하면 연결을 안전하게 저장할 수 없다는 오류를 표시하며 평문 파일로 대신 저장하지 않습니다.

앱은 입력·저장·로컬 영상 작업을 네트워크 상태와 분리합니다. SNS 로그인, 토큰 갱신과 외부 소스 수집에는 인터넷이 필요하고 DB 작업에는 컨테이너가 실행 중이어야 합니다. 매일 07:00 KST 자동 수집은 앱 실행 중 처리하며 놓친 실행은 앱을 다시 열 때 처리합니다.
