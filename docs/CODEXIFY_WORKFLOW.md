# Codexify 기반 AI 작업실

## 구현 범위

v0.1.16은 등록한 Codexify 연결을 설치 앱 안에서 저장하고 사용하는 기능을 포함합니다. 영상 스튜디오 메뉴와 렌더링 진입 화면을 제거하고, AI 작업실에 실제 수집 자료 기반 주제·키워드 선택을 통합했습니다. 기존 영상 프로젝트/MP4, Rust 렌더러, 게시 QA용 영상 처리기는 삭제하지 않았습니다. 기존 VideoPanel 소스는 현재 앱의 모듈 그래프에 연결하지 않습니다.

AI-first DAG 실행기 전체 구현과는 별개입니다. ChatGPT가 생성과 판단을 수행하고 Codexify가 로컬 도구를 연결합니다. 앱에서 요청을 등록하거나 복사한 것만으로 AI 작업이 시작된 것으로 표시하지 않습니다.

## 주제 발견과 자료 선택

AI 작업실 상단의 ‘오늘의 주제 후보’는 현재 조회한 트렌드에서 수집 시각이 최근인 서로 다른 출처 최대 6개입니다. 인기 순위나 조회수 추정치를 만들지 않습니다. 관련 키워드는 저장된 로컬 키워드 API의 최근 조회 자료 최대 25개에서 가져옵니다. 실제 검색어와 추출 키워드를 각각 최대 8개 표시하며 출처를 구분합니다. 자동 조회는 외부 검색 API나 AI를 호출하지 않습니다.

- 주제로 사용: 선택한 키워드/제목으로 주제를 바꾸고 수동 맥락과 참고자료는 유지합니다.
- 참고자료 추가: 주제를 바꾸지 않고 제목·URL·수집 시각·실제 설명을 연결합니다.
- 함께 사용: 주제와 참고자료를 함께 적용합니다.

같은 자료 ID/원본 URL은 중복 추가하지 않습니다. 자료는 최대 8개이고 실제 제공된 설명/수집된 원문의 발췌는 자료당 최대 1,200자입니다. 직접 입력한 맥락과 직렬화된 참고자료 합계가 6,000자를 넘으면 ChatGPT 요청 복사와 로컬 AI 생성을 차단합니다. 임의로 입력/출처를 잘라내지 않습니다. 초과한 신규 선택은 전체 적용하지 않으며 기존 선택은 유지합니다.

참고자료 해제는 연결만 제거하고 수동 맥락과 원본 DB 자료는 보존합니다. ‘전달할 참고자료 확인’에서 AI에 전달할 내용을 확인할 수 있습니다. 트렌드·키워드 탐색의 기존 영상 만들기 버튼은 ‘AI 작업실에서 사용’으로 대체했습니다.

‘연결된 대화에 보내기’는 선택한 Codexify 대화에 요청을 저장합니다. ‘요청 복사·ChatGPT 열기’는 저장한 ChatGPT 링크를 열어 수동으로 시작할 수 있게 합니다. ‘AI로 작성’은 기존에 선택한 로컬 제공자에게 직접 요청하는 별도 동작입니다. 한 경로의 성공을 다른 경로의 로그인/생성 성공으로 해석하지 않습니다.

## 로딩과 대기 표현

`ActivityStatus`는 실행 중에는 3개 막대, 외부 응답/로그인 대기에는 점의 밝기 변화로 상태를 표현합니다. 실제 시작 시각으로 계산한 경과 시간만 표시하고 진행률은 만들지 않습니다. 기존 결과는 응답이 도착할 때까지 유지합니다. ‘작업 안내’는 접어서 볼 수 있고 ‘효과 멈춤’은 애니메이션만 멈춥니다. 진행 중인 실제 요청을 취소하는 버튼이 아닙니다.

화면 밖/백그라운드 상태에서는 애니메이션을 일시정지하며 모션 감소 설정은 움직임 없이 동일한 상태를 보여줍니다. 상태 갱신은 포커스나 스크롤을 이동시키지 않습니다. 이미지 큐의 ‘ChatGPT 결과 대기’에는 요청 전달/ChatGPT 열기 동작을 제공합니다. 큐에 대기한 기간을 실제 이미지 생성 소요 시간으로 표시하지 않습니다.

## 설치 앱에서 연결하기

1. **연결·게시 QA → ChatGPT · Codexify**에서 로컬 MCP 주소, 등록한 ChatGPT 플러그인 링크, 실제 프로젝트 절대 경로를 저장합니다. 대화 링크는 선택 사항입니다.
2. 기존 Codexify 설정에 **Codexify direct 설정 복사**의 조각을 병합하고 다시 실행합니다. 기존 인증·터널·다른 MCP 서버 설정은 유지합니다. 조각은 설치된 Studio 실행 파일과 `agentChat.enabled=true`를 포함합니다.
3. 등록한 ChatGPT 플러그인의 도구 목록을 새로고침하고 새 대화를 시작합니다. 앱에서 **대화 시작 안내 복사**로 안내를 가져와 ChatGPT에 붙여넣습니다.
4. 앱의 대화 목록을 새로고침하고 이 프로젝트의 대화를 직접 선택해 저장합니다. 앱 안의 채팅, AI 작업실, 이미지 작업 큐에서 요청을 보낼 수 있습니다.
5. 이미지 요청은 Studio 파일 수신 도구가 확인된 경우에만 전송합니다. 실제 파일이 수신·변환·저장되면 작업 큐와 에셋 보관함에 반영됩니다.

앱 설정은 OS의 앱 설정 폴더에 있는 `kr.toris.studio/codexify-connection.json`에 저장합니다. 사용자별 플러그인 URL·대화 ID·프로젝트 경로는 공개 소스 기본값에 포함하지 않습니다. 이 파일은 API 키를 저장하는 기존 키체인 설정과 분리됩니다.

## 앱 채팅의 실행 조건

Codexify v1.7의 owner chat은 **이미 실행 중인 ChatGPT 대화**가 `chat_read`/`chat_await`를 호출할 때 앱 요청을 전달하고 `chat_write` 응답을 보여줍니다. 종료된 ChatGPT 턴을 앱이 다시 시작하는 API는 제공하지 않습니다. 앱은 서버가 확인한 대기 시간과 메시지 커서를 사용해 **저장됨 → 전달됨 → 읽음**을 구분합니다. 최근 도구 호출이나 메시지 저장을 이미지 생성 성공으로 표시하지 않습니다.

Owner chat은 Codexify가 별도로 연 `127.0.0.1` 포트에서 실행됩니다. 앱의 Rust 백엔드가 `~/.codexify/owner-chat.json`의 로컬 토큰을 읽어 요청하며, 토큰은 React·클립보드·도구 출력·Git에 전달하지 않습니다. 웹 페이지를 iframe으로 넣거나 브라우저 쿠키/비공개 ChatGPT API를 사용하지 않습니다.

로컬 MCP 연결 확인은 `initialize`와 `tools/list`로 Studio 도구 및 파일 수신 스키마를 확인합니다. 이는 ChatGPT 로그인·구독 한도·이미지 생성의 검증과 구분됩니다. 파일 생성에는 연결된 ChatGPT 환경의 이미지 생성 기능과 사용 한도가 적용됩니다.

## direct 계약

Codexify direct는 각 도구를 `<server>__<tool>` 이름으로 노출합니다. 이 설정에서는 `studio__studio_asset_receive` 등 9개가 표시됩니다. 도구 이름을 추측하기보다 실제 연결 목록을 확인합니다. 수신 도구의 다음 계약을 보존해야 합니다.

```json
{"_meta":{"openai/fileParams":["file"]}}
```

`file`에는 실제 host 파일 참조만 전달합니다. JSON 필드는 `download_url`, `file_id`가 필수이고 `mime_type`, `file_name`은 선택입니다. file 인자에 이미지 base64나 임의의 로컬 파일 경로를 넣지 않습니다. catalog/gateway의 일반 dispatcher로 파일 수신을 대체하지 않습니다.

실행 흐름은 ChatGPT 실제 이미지 생성 → direct 수신 도구 호출 → 원본 보존/규격 변환 → 에셋 저장입니다. 생성 도구가 없거나 사용 한도/계정 권한 문제로 막히면 대기로 남깁니다. 도구 왕복 시각은 ChatGPT 계정 신원·이미지 생성·파일 수신의 증거를 대신하지 않습니다.

프로젝트 경로 선택은 Codexify 파일 도구의 작업 기준입니다. AI 초안과 에셋 요청은 이미 연결된 프로젝트를 그대로 사용하며 프로젝트 전환을 요청하지 않습니다. Studio의 영상용/프로젝트용 출력 폴더는 별개로 유지합니다. Codexify의 명령 실행 기능을 OS 보안 sandbox로 간주하지 않고 허용한 프로젝트와 데이터만 사용합니다.

## 검증 명령과 확인 범위

```sh
pnpm ai:test
pnpm ai:verify:ui
pnpm codexify:verify
pnpm assets:audit
pnpm assets:verify:ui
pnpm integrations:verify:ui
pnpm integrations:verify:mcp
```

`codexify:verify`는 실제 설치된 Codexify와 실제 Rust MCP를 임시 HOME/프로젝트/에셋 저장소에서 연결합니다. 인증 없는 HTTP 거부, 9개 도구/파일 _meta/annotation 보존, 6개 동시 요청의 누락 없는 저장, 3개 동시 ICO 변환, 안전하지 않은 파일 URL 거부를 검사합니다. 끝나면 해당 프로세스와 임시 데이터를 정리합니다. 테스트 출력을 실제 ChatGPT 생성 파일로 표시하지 않습니다.

UI 테스트는 Chromium과 명시적인 IPC fixture를 사용합니다. 실제 macOS WKWebView/네이티브 파일 선택창이나 ChatGPT 로그인/이미지 생성/파일 전송을 검증한 것은 아닙니다. 실제 생성 파일의 end-to-end 수신과 운영 환경 장시간 부하는 별도 검증이 필요합니다.

로컬 앱은 아래처럼 빌드합니다. 첫 기본 debug build에서 업데이트 서명 private key가 없다는 오류를 확인했으므로 기존 preview-config 도구로 **업데이트 배포 산출물 생성만** 끕니다. 설치된 앱의 업데이트 서명 검증 설정은 바꾸지 않습니다.

```sh
node scripts/release-assets.mjs preview-config /tmp/toris-studio-ai-preview.json
pnpm --dir desktop exec tauri build --debug --bundles app --config /tmp/toris-studio-ai-preview.json
```

공개 release/tag/GitHub Packages는 이번 변경으로 갱신하지 않았습니다. 기존 설치 앱도 덮어쓰지 않았습니다. 변경은 로컬 개발 빌드입니다.

공식 참고 자료(2026-10-09 확인):
- https://github.com/devnoname120/codexify
- https://github.com/devnoname120/codexify/blob/main/docs/REFERENCE.md
- https://github.com/devnoname120/codexify/releases/tag/v1.7.0
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
