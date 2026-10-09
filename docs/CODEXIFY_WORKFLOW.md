# Codexify 기반 AI 작업실

## 구현 범위

이 체크아웃은 v0.1.14 이후의 로컬 변경입니다. 영상 스튜디오 메뉴와 렌더링 진입 화면을 제거하고, AI 작업실에 실제 수집 자료 기반 주제·키워드 선택을 통합했습니다. 기존 영상 프로젝트/MP4, Rust 렌더러, 게시 QA용 영상 처리기는 삭제하지 않았습니다. 기존 VideoPanel 소스는 현재 앱의 모듈 그래프에 연결하지 않습니다.

AI-first DAG 실행기 전체 구현과는 별개입니다. ChatGPT가 생성과 판단을 수행하고 Codexify가 로컬 도구를 연결합니다. 앱에서 요청을 등록하거나 복사한 것만으로 AI 작업이 시작된 것으로 표시하지 않습니다.

## 주제 발견과 자료 선택

AI 작업실 상단의 ‘오늘의 주제 후보’는 현재 조회한 트렌드에서 수집 시각이 최근인 서로 다른 출처 최대 6개입니다. 인기 순위나 조회수 추정치를 만들지 않습니다. 관련 키워드는 저장된 로컬 키워드 API의 최근 조회 자료 최대 25개에서 가져옵니다. 실제 검색어와 추출 키워드를 각각 최대 8개 표시하며 출처를 구분합니다. 자동 조회는 외부 검색 API나 AI를 호출하지 않습니다.

- 주제로 사용: 선택한 키워드/제목으로 주제를 바꾸고 수동 맥락과 참고자료는 유지합니다.
- 참고자료 추가: 주제를 바꾸지 않고 제목·URL·수집 시각·실제 설명을 연결합니다.
- 함께 사용: 주제와 참고자료를 함께 적용합니다.

같은 자료 ID/원본 URL은 중복 추가하지 않습니다. 자료는 최대 8개이고 실제 제공된 설명/수집된 원문의 발췌는 자료당 최대 1,200자입니다. 직접 입력한 맥락과 직렬화된 참고자료 합계가 6,000자를 넘으면 ChatGPT 요청 복사와 로컬 AI 생성을 차단합니다. 임의로 입력/출처를 잘라내지 않습니다. 초과한 신규 선택은 전체 적용하지 않으며 기존 선택은 유지합니다.

참고자료 해제는 연결만 제거하고 수동 맥락과 원본 DB 자료는 보존합니다. ‘전달할 참고자료 확인’에서 AI에 전달할 내용을 확인할 수 있습니다. 트렌드·키워드 탐색의 기존 영상 만들기 버튼은 ‘AI 작업실에서 사용’으로 대체했습니다.

‘ChatGPT 요청 복사’는 Codexify가 연결된 ChatGPT 대화에 붙여넣을 요청을 만듭니다. ‘AI로 작성’은 기존에 선택한 로컬 제공자에게 직접 요청하는 별도 동작입니다. 한 경로의 성공을 다른 경로의 로그인/생성 성공으로 해석하지 않습니다.

## 로딩과 대기 표현

`ActivityStatus`는 실행 중에는 3개 막대, 외부 응답/로그인 대기에는 점의 밝기 변화로 상태를 표현합니다. 실제 시작 시각으로 계산한 경과 시간만 표시하고 진행률은 만들지 않습니다. 기존 결과는 응답이 도착할 때까지 유지합니다. ‘작업 안내’는 접어서 볼 수 있고 ‘효과 멈춤’은 애니메이션만 멈춥니다. 진행 중인 실제 요청을 취소하는 버튼이 아닙니다.

화면 밖/백그라운드 상태에서는 애니메이션을 일시정지하며 모션 감소 설정은 움직임 없이 동일한 상태를 보여줍니다. 상태 갱신은 포커스나 스크롤을 이동시키지 않습니다. 이미지 큐의 ‘ChatGPT 결과 대기’에는 요청 전달/ChatGPT 열기 동작을 제공합니다. 큐에 대기한 기간을 실제 이미지 생성 소요 시간으로 표시하지 않습니다.

## 실제 Mac 설치와 준비한 설정

2026-10-09 공식 Codexify v1.7.0 macOS arm64 archive를 다운로드했고 GitHub Release의 SHA-256과 대조했습니다. Apple Developer ID 서명 구조도 `codesign --verify --strict`로 확인했습니다. OS 보안 검사/격리 속성을 제거하지 않았고 공증 여부를 별도 검증했다고 주장하지 않습니다.

- 실행 파일: `/Users/toris/.codexify/bin/codexify`
- 개인 설정: `/Users/toris/.codexify/codexify.config.json`
- 작업 프로젝트: `/Users/toris/projects/toris_studio`
- Studio 실행 파일: 이번 로컬 `.app`의 `Contents/MacOS/toris-studio-desktop`
- Studio 인자: `--studio-mcp`
- 서버 이름/방식: `studio` / `direct`
- Codex MCP 자동 발견과 Codex CLI 발견: 모두 해제

설정은 기존 파일이 없는 것을 확인하고 배타적 생성으로 새로 만들었습니다. 새 로컬 HTTP bearer는 난수로 생성해 권한 0600의 사용자 설정에만 보관하며 문서/도구 로그/Git에 기록하지 않습니다. 기본 포트는 43157, Host 허용 목록은 localhost/127.0.0.1입니다. **Codexify 일반 서버의 소켓 바인딩을 loopback-only로 가정하지 않습니다.** 인증과 Host 검사를 유지하고, 공개 무인증 터널을 만들지 않습니다. 실제 서비스/자동 시작 항목은 설치·기동하지 않았습니다.

현재 설정에는 OpenAI 터널 인증이 없습니다. 초기 계정 연결은 사용자가 공식 wizard에서 완료해야 합니다.

```sh
/Users/toris/.codexify/bin/codexify quickstart --work-dir /Users/toris/projects/toris_studio
```

이 명령은 설정과 계정 연결 절차를 시작합니다. 기존 단일 프로젝트 모드를 유지하고, 본인 터널과 ChatGPT 워크스페이스를 연결하세요. 터널 runtime 키는 wizard의 숨겨진 입력으로만 전달하고 채팅이나 Git에 붙여넣지 않습니다. 서비스 설치/시작 여부는 wizard에서 선택합니다. wizard가 기존 Studio 서버 설정을 유지하는지 확인한 뒤 앱 도구 목록을 갱신하세요.

앱의 ‘연결·게시 QA → Codexify direct 설정 복사’는 **비밀키가 없는 설정 조각**을 복사합니다. 다른 Mac/Windows 또는 다른 앱 설치 위치에서는 이 기능으로 현재 실행 파일의 경로를 가져오세요. 조각으로 전체 사용자 설정을 덮어쓰지 말고 기존 openaiTunnel/openaiTunnels·인증·다른 서버 항목을 보존해 병합합니다. 일반 config get 전체 출력에는 로컬 인증 정보가 포함될 수 있으므로 공유하지 않습니다.

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
