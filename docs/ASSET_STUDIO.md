# 이미지 생성기 · 에셋 보관함

기존 `/Users/toris/projects/toris_studio`의 Tauri 데스크톱 앱에 통합한 로컬 에셋 작업실입니다. 왼쪽 **제작 → 이미지 생성기**에서 엽니다. 다른 영상·SNS 기능과 기존 변경 사항은 유지합니다.

## 지원하는 작업

| 화면 | 기능 |
| --- | --- |
| 새로 만들기 / 이미지 | 이름, 프롬프트, 영상 제작용·프로젝트 에셋 구분, 프로젝트명, 출력 규격, 형식, 맞춤 방식, 1~100개 요청 등록 |
| 새로 만들기 / 3D | 박스·구/타원체·원기둥·평면을 실제 GLB·OBJ·STL로 생성, 크기·곡면 분할 수·GLB 색상 지정 |
| 에셋 보관함 | 이미지 썸네일, 선택한 3D 모델 회전/확대, 검색, 용도/파일 유형 필터, 즐겨찾기, 검토 상태, 태그, 프롬프트와 원본/출력 경로 |
| 크기 변경·내보내기 | 보관함의 이미지 선택 → 프리셋/배경색/맞춤 방식 지정 → 보존 원본에서 새 에셋으로 출력. 기존 파일은 유지 |
| 작업 큐 | 대기 요청 복사, 파일 연결, 취소/다시 대기, 실제 결과 수신 후 완료 처리 |
| 기존 에셋 가져오기 | 네이티브 파일 선택으로 최대 100개 이미지/모델 가져오기. 원래 파일명 보존, 원본은 삭제하지 않음 |
| 용도별 저장 폴더 | 영상용과 프로젝트용 폴더를 따로 지정. 프로젝트/에셋별 하위 폴더 자동 생성 |

출력 규격은 **31개 프리셋 + 사용자 지정**입니다. 새 이미지 요청, 가져오기, 보관함 이미지 재출력에서 같은 규칙을 사용합니다. 프리셋은 픽셀 크기가 같아도 용도와 ID를 구분하며, 가로·세로를 직접 수정하면 `사용자 지정`으로 전환됩니다.

| 규격 그룹 | 제공 크기 (px) |
| --- | --- |
| Play 스토어 | 아이콘 512×512, 그래픽 1024×500, 휴대전화 스크린샷 1080×1920 / 1920×1080, 태블릿 스크린샷 1440×2560 / 2560×1440 |
| 웹 favicon | 16×16, 32×32, 48×48, 64×64, 96×96 |
| 앱 캠페인·풀스크린 | 1200×1200, 1200×628, 1200×1500, 1080×1920 |
| AdMob 배너 | 320×50, 320×100, 300×250, 468×60, 728×90, 480×32 |
| 스마트폰·태블릿 전면 이미지 | 320×480, 480×320, 768×1024, 1024×768 |
| 기존 영상·일반 에셋 | 1920×1080, 1080×1920, 1280×720, 1024×1024, 2048×2048, 1080×1350 |

직접 입력은 각 축 16~8192px, 총 33,554,432픽셀 이하입니다. PNG·JPEG·WebP·ICO로 출력하며, 프리셋별 허용 형식은 제한합니다. `전체 보존`은 여백을 추가하고 `화면 채움`은 중앙을 자릅니다. 투명 배경 유지 또는 지정 색상 합성을 선택할 수 있습니다. JPEG는 항상 선택한 배경색에 합성하며 기본값은 흰색입니다. 확대 출력은 원본 이상의 디테일을 새로 생성하지 않습니다.

### Play 스토어·favicon 파일 규칙

- `play-icon`: 정확히 512×512, RGBA 8비트 채널(32비트 PNG), sRGB. 최종 파일이 1,048,576바이트(1,024 KiB)를 넘으면 저장·완료 처리 대신 오류를 표시합니다. 모서리 둥글림과 그림자는 추가하지 않습니다. Android 런처/adaptive icon 생성 기능은 아닙니다.
- `play-feature` 및 네 가지 Play 스크린샷: PNG/JPEG만 허용합니다. 투명 영역과 여백을 지정한 배경색에 합성하고 PNG의 **알파 채널 자체를 제거**하여 RGB 24비트로 저장합니다. 모든 알파 값을 255로 만드는 것과 다릅니다.
- 스크린샷은 권장 비율의 편의 프리셋이며 실제 앱 화면을 사용해야 합니다. 앱/기기별 필수 장수, 콘텐츠 심사, 기타 등록 요건까지 자동 검증하지 않습니다.
- favicon: PNG 또는 **선택 크기 하나를 담은 실제 ICO 컨테이너**로 인코딩합니다. 확장자만 변경하지 않습니다. 사용자 지정 ICO는 16~256px 정사각형으로 제한합니다. 여러 크기를 한 ICO에 담는 아이콘 팩은 포함하지 않습니다.
- 캠페인·AdMob·전면 이미지 크기는 사용자가 제공한 14개 출력 규격입니다. 파일의 px와 AdMob SDK 광고 영역의 dp를 구분하며 광고 지면의 모든 업로드·심사 조건을 충족한다고 표시하지 않습니다.

PNG/JPEG/WebP/ICO 입력을 지원합니다. 입력의 EXIF 방향을 적용한 뒤 크기를 맞춥니다. RGB/회색조 ICC 프로파일이 있으면 정적으로 포함된 LittleCMS로 sRGB 변환하며 알파는 유지합니다. ICC가 없으면 sRGB로 **가정**하고 `details.colorHandling=assumed-srgb`로 기록합니다. 잘못된 ICC나 지원하지 않는 색공간은 조용히 재해석하지 않고 오류로 안내합니다. PNG는 sRGB 청크를, JPEG/WebP는 sRGB ICC를 저장합니다.

공식 규격 확인일: 2026-10-09. 출처:
- https://developer.android.com/distribute/google-play/resources/icon-design-specifications
- https://support.google.com/googleplay/android-developer/answer/9866151?hl=en
- https://developers.google.com/search/docs/appearance/favicon-in-search
- https://developers.google.com/admob/android/banner/fixed-size

### 보관함 이미지 크기 변경

**에셋 보관함 → 이미지 선택 → 크기 변경·내보내기 → 출력 프리셋/배경/맞춤 선택 → 새 파일로 내보내기** 순서로 사용합니다. 프롬프트나 AI 생성 연결 없이 기존 이미지를 처리합니다. 이름, 프로젝트, 영상용/프로젝트용 저장 폴더도 지정할 수 있습니다.

재출력은 선택한 에셋의 `originalPath`를 읽습니다. 예전에 줄이거나 잘라낸 `export` 파일에서 연속으로 크기를 맞추지 않습니다. 원본과 기존 출력은 유지되고, 새 UUID와 `sourceAssetId`를 가진 별도 에셋이 등록됩니다. 화면의 원본 미리보기는 기존 출력의 미리보기이며 실시간 변환 결과로 표시하지 않습니다. 3D 모델에는 이 이미지 크기 변경 작업이 제공되지 않습니다.

3D 형식 지원은 자체 포함 GLB 2.0과 외부 MTL 참조가 없는 OBJ, STL입니다. 외부 URI·희소 접근자 등 일부 GLB 기능은 가져오기 검증에서 제한합니다. 일반 AI text-to-3D 또는 사진의 3D 복원 엔진은 포함하지 않습니다. 가져온 모델의 자동 리토폴로지나 임의 모델 사이의 형식 변환도 하지 않습니다. 크기와 GLB 색상 지정은 로컬에서 생성하는 기본 도형에 적용됩니다. STL 자체에는 단위가 없으므로 다른 프로그램에서 미터 기준으로 해석해야 합니다.

## ChatGPT 연동의 경계

**이 앱은 ChatGPT 이미지 생성 API의 대체 호출기가 아닙니다.** 앱에서 요청을 등록한 뒤 ChatGPT 대화에 전달하고, ChatGPT에서 실제로 만들어진 파일을 로컬 MCP가 수신하는 구조입니다. 해당 대화에서 이미지 생성 도구와 파일 전달이 제공되어야 합니다.

- 에셋 경로는 Codex CLI, Codex 구독, OpenAI 이미지 API를 호출하지 않습니다.
- 요청 등록은 이미지 생성 완료가 아닙니다. 실제 파일을 수신·검증·저장해야 완료됩니다.
- ChatGPT 계정/모델의 이미지 생성 사용 한도는 그대로 적용됩니다. 무제한·무인 실행이나 제한 우회는 지원하지 않습니다.
- Secure MCP Tunnel은 연결 경로입니다. 이미지 생성 권한·사용 한도를 늘리지 않습니다. 터널용 인증과 워크스페이스 권한은 별도 설정입니다.
- ChatGPT 연결 성공 여부나 남은 이미지 한도를 앱이 읽거나 판정하지 않습니다.
- 2026-10-09 작업에서 로컬 MCP 프로토콜/도구 호출은 검증했습니다. **사용자 ChatGPT 계정에 새 커넥터를 등록하거나 실제 ChatGPT 생성 파일을 전송하는 검증은 수행하지 않았습니다.**

참고한 공식 문서:
- https://developers.openai.com/plugins/reference (파일 파라미터)
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels (로컬 서버 연결)
- https://developers.openai.com/plugins/deploy/connect-chatgpt (커넥터 등록·테스트)

## 실행

### 데스크톱 앱

로컬 macOS 개발용 앱 번들:

```text
/Users/toris/projects/toris_studio/desktop/src-tauri/target/debug/bundle/macos/Toris Studio.app
```

새로 빌드하려면 프로젝트에서 다음을 실행합니다. 프로젝트의 Node.js 계약은 **24.x**입니다.

```sh
pnpm desktop:dev
```

개발용 `.app` 번들만 만들 때는 `desktop` 폴더에서 실행합니다.

```sh
pnpm exec tauri build --debug --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

이번 번들은 개발/검증용입니다. 배포용 서명·공증·GitHub 릴리스 게시·설치된 기존 앱 교체는 하지 않았습니다.

### 에셋 전용 MCP

```sh
cd /Users/toris/projects/toris_studio
pnpm assets:worker:build
pnpm assets:mcp
```

`assets:mcp`는 **stdio 서버**입니다. 콘솔에서 입력을 기다리는 것이 정상입니다. Secure MCP Tunnel 또는 stdio를 지원하는 로컬 MCP 클라이언트가 프로세스를 실행하고 표준 입출력으로 통신해야 합니다. 터널이 프로세스를 실행하도록 설정할 때 작업 폴더를 위 프로젝트로 지정하거나 `pnpm --dir /Users/toris/projects/toris_studio assets:mcp`를 사용합니다.

ChatGPT에서는 공식 안내에 따라 **Plugins → Add custom MCP server → Tunnel**로 등록합니다. 터널 생성/인증과 계정 권한이 먼저 갖추어져야 합니다. `http://127.0.0.1` 주소만 입력해 원격 ChatGPT가 Mac에 직접 접근할 수 있다고 가정하면 안 됩니다.

기존 `pnpm mcp` / `pnpm mcp:stdio`는 영상 도구와 에셋 도구를 함께 제공합니다. 이미지 작업만 연결할 때는 권한 범위가 작은 `pnpm assets:mcp`를 권장합니다. 기존 HTTP 서버를 외부 인터페이스에 바인딩하려면 32자 이상의 `MCP_AUTH_TOKEN`이 필수입니다. 인증 없이 공개 터널을 열지 마세요.

### 제공 도구

| 도구 | 역할 |
| --- | --- |
| `studio_asset_presets` | 31개 출력 규격·허용 형식·알파 정책·아이콘 용량 제한 조회 |
| `studio_asset_resize` | 등록된 이미지 ID와 새 규격으로 원본에서 별도 에셋 재출력. `spec.quantity=1` |
| `studio_asset_list` | 실제 에셋/작업 조회, 작업 ID·대기 상태로 필터링 |
| `studio_asset_request` | 규격을 고정한 이미지 요청 등록 |
| `studio_asset_receive` | ChatGPT 파일 참조와 jobId 수신, 원본 보존·규격화·완료 처리 |
| `studio_asset_create_3d` | 로컬 기본 도형 GLB·OBJ·STL 생성 |
| `studio_asset_review` | 즐겨찾기·검토·태그 변경 |
| `studio_asset_job_status` | 대기/결과 대기/취소 변경. 완료 상태를 임의로 만들 수 없음 |

에셋 전용 도구는 8개입니다. `spec`에는 기존 필드 외에 `presetId`, `backgroundColor`(`#RRGGBB`), `backgroundMode`(`transparent`/`solid`)를 전달합니다. `studio_asset_presets`에서 조회한 ID·가로·세로·허용 형식을 함께 지정하세요. Play 불투명 규칙은 Rust에서도 강제 적용하므로 MCP에서 우회할 수 없습니다. 기존 저장 작업처럼 새 필드가 없는 입력은 사용자 지정·흰색 배경·투명 유지 기본값으로 호환됩니다.

`studio_asset_receive`의 최상위 `file`은 OpenAI 파일 파라미터입니다. `download_url`과 `file_id`가 필수이며 `mime_type`, `file_name`은 스키마에 선언하되 선택 값입니다. 모델이 base64나 로컬 경로를 이 파라미터에 직접 넣는 방식이 아닙니다. 승인된 파일 참조는 호스트 런타임이 전달합니다.

파일은 최대 32 MiB입니다. 기본적으로 OpenAI 파일 전달 호스트(`oaiusercontent.com` 및 하위 도메인)의 HTTPS만 허용하며 사용자정보가 포함된 URL, 대체 포트, 리디렉션은 거절합니다. 다른 공식 전달 호스트가 필요한 경우 로컬 관리자가 `TORIS_ASSET_FILE_HOSTS`에 정확한 호스트명을 등록한 뒤 테스트해야 합니다. 임시 다운로드 URL은 저장하거나 로그에 남기지 않습니다.

## 저장 구조와 보존

색인 기본 위치는 `~/.toris-studio/asset-library/library.json`입니다. PostgreSQL이나 Next.js 서버가 없어도 에셋 기능은 동작합니다.

```text
선택한 영상용/프로젝트용 폴더/
  프로젝트명/
    에셋이름_UUID/
      original.<입력 확장자>
      export.<출력 확장자>
      preview.jpg                 # 이미지 미리보기
```

요청을 만들 때 저장 루트를 고정합니다. 폴더를 변경해도 기존 파일과 이미 대기 중인 요청은 이동하지 않습니다. 새 요청부터 새 폴더를 사용합니다. 보관함의 `크기 변경·내보내기`는 새 저장 작업이므로 현재 선택한 용도별 폴더를 사용합니다. 원본과 출력 경로는 상세 화면에서 확인하거나 Finder에서 열 수 있습니다.

가져오기는 선택한 파일만 처리하며 임의 폴더를 재귀적으로 스캔하지 않습니다. 이미지는 현재 가져오기 설정의 규격으로 출력하되 원본도 별도로 보존합니다. 보관함에서 `가져오기 설정 변경`으로 용도·프로젝트·규격을 먼저 바꿀 수 있습니다. 과거 ChatGPT/Drive 파일 전체를 자동 수집하는 기능은 아닙니다.

색인은 프로세스 간 파일 잠금과 임시 파일 교체로 저장합니다. 잘못된 JSON 색인은 조용히 초기화하지 않고 오류를 반환합니다. 같은 jobId에 같은 파일을 다시 보내면 기존 완료 에셋을 반환하고, 다른 파일로 완료 작업을 덮어쓰지 않습니다.

## 검증

```sh
pnpm assets:test
pnpm assets:audit
pnpm assets:verify:ui
pnpm assets:verify:mcp
pnpm typecheck
pnpm exec tsc --project desktop/tsconfig.json --noEmit
```

UI 검증은 Playwright Chromium에서 Tauri IPC 테스트 어댑터를 사용하되, 파일 처리·색인·메시 생성은 실제 Rust 코드로 수행합니다. 파일 선택 창은 명시적인 테스트 파일 선택으로 대체합니다. 이 테스트만으로 실제 macOS 파일 선택 창이나 WKWebView의 모든 동작을 검증했다고 주장하지 않습니다.

검증 자료는 `docs/review/asset-studio/`에 있습니다. 느린 조회·오류 복구·키보드·최신 검색 응답 보호·파일 유실·잘못된 STL 입력의 추가 감사는 `docs/review/functional-audit/REPORT.md`와 `pnpm assets:audit`에서 확인합니다. 스크린샷의 로고 이미지와 모델은 **검증용 자료**이며 AI 이미지 생성 실적이 아닙니다. 실제 사용자 보관함과 별도 임시 폴더에서 테스트하고 임시 데이터는 종료 시 정리합니다.

GLB 네 가지 기본 도형은 Khronos glTF Validator로 별도 검증합니다. WebGL/Three.js는 3D 상세 화면을 열 때만 로드하며 유휴 애니메이션 루프를 돌리지 않습니다. 3D 청크 크기 경고와 lucide-react의 `use client` 번들 경고는 남아 있습니다.
