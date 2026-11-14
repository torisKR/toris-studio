# 프로젝트 채팅 실제 앱 QA (백로그 3차 17번)

Chromium fixture(`verify-project-*-ui.mjs`)에서 통과한 것과 **사용자의 Mac에서 실제 Tauri/WKWebView 앱이 그렇게 동작하는 것**을 분리해 기록한다. 이 문서의 결과는 아래 "실행 기록"에 적은 소스 head와 바이너리에만 해당한다.

## 범위

- 확인: 정상 종료 후 같은 빌드로 재실행했을 때 초안·worktree 정보·미리보기 주소·커밋 영수증 복원, macOS 한글 입력기의 조합 확정 Enter, 같은 바이너리 재호출 시 기존 main 편집 창 유지(단일 편집 창).
- 확인하지 않음: 다중 창 동시 편집 안전성(지원 기능이 아님), 실제 Muse·Dots·Grok 왕복, 실제 Claude/Codex 턴, Windows·Linux, 배포·업데이트 경로.
- 이 PR은 코드(`ProjectChat.tsx`, `project-drafts.ts`, Rust, 권한 파일)를 바꾸지 않는다. 실패는 원인 소유자에게 회귀로 돌려준다.

## 격리 원칙

사용자 앱·데이터와 다른 작업자를 건드리지 않도록 QA 앱을 다음처럼 분리한다.

| 항목 | 제품 앱 | QA 앱 | 근거 |
|---|---|---|---|
| bundle identifier | `kr.toris.studio` | `kr.toris.studio.qa` ([overlay](project-chat-native-qa.tauri.json), `tauri build --config`) | 단일 실행 소켓(`/tmp/<identifier>_si.sock`)과 WebKit `localStorage`(초안)가 identifier별로 갈린다 |
| Rust 저장소(`projects.json`, 대화 기록) | `~/Library/Application Support/kr.toris.studio` | `$QA/home/Library/Application Support/kr.toris.studio` | `config_path()`는 `dirs::config_dir()`(=`$HOME` 기준)이라 QA 실행에만 `HOME=$QA/home`을 준다 |
| 빌드 산출물 | `/Applications/Toris Studio.app` | `$CARGO_TARGET_DIR/debug/bundle/macos/Toris Studio QA.app` | 설치 앱을 덮어쓰거나 배포하지 않는다 |
| UI 서버 | dev는 1420 포트 | 없음(빌드에 UI 포함) | 1420을 쓰는 다른 dev 서버와 충돌하지 않는다 |
| 예약 자동화 | 동작 | `TORIS_MOBILE_QA_NO_AUTOMATION=1` + debug 빌드 | `lib.rs`가 `debug_assertions`+macOS에서만 이 값을 따른다 |

- overlay는 identifier·이름·업데이트 산출물 생성 여부만 바꾼다. 창 정의(`main`), 단일 실행 플러그인, `capabilities/main.json` 권한은 제품과 같다. 따라서 QA 결과는 **같은 코드의 다른 identifier 빌드**에 대한 관찰이고, 서명된 배포본 자체에 대한 관찰은 아니다.
- QA 앱은 사용자 앱이나 다른 작업자의 앱을 종료하지 않는다. 종료는 QA identifier에만 보내는 정상 종료 요청(`osascript -e 'tell application id "kr.toris.studio.qa" to quit'`, Tauri의 종료 요청 경로) 또는 tray의 "완전히 종료"로만 한다. `kill`·강제 종료는 쓰지 않는다. 창 닫기 버튼은 tray로 숨기므로 재시작으로 세지 않는다.
- QA 프로젝트는 `$QA/repos/` 아래 새 Git 저장소만 쓴다. 테스트 커밋은 그 저장소의 Studio 전용 worktree에서만 만든다.
- 스크린샷에는 QA 프로젝트명·테스트 문장만 나와야 한다. 사용자 프로젝트명·초안·계정이 보이면 쓰지 않는다.

## 준비 (읽기 전용 preflight)

```bash
QA=/tmp/toris-native-qa
node scripts/verify-project-chat-native-preflight.mjs --root "$QA" --require c07f494 [--require <16번 head>]
```

[preflight](../../scripts/verify-project-chat-native-preflight.mjs)는 읽기만 한다. 확인하는 항목:

- checkout head·추적 파일 깨끗함·필수 커밋 포함
- overlay identifier가 제품과 다름
- `$QA/build.json`의 head·sha256과 실제 바이너리 일치, debug 빌드
- QA 저장소의 프로젝트가 모두 `$QA` 안에 있음
- 1420 포트·설치 앱·소켓·한글 입력기 상태 보고

시작·종료·삭제·전송은 하지 않는다.

## 빌드와 소스 연결

```bash
export CARGO_TARGET_DIR=~/projects/toris_studio/desktop/src-tauri/target-wt8
pnpm --dir desktop exec tauri build --debug --bundles app --config "$PWD/docs/review/project-chat-native-qa.tauri.json"
```

빌드 직후 `$QA/build.json`에 `sourceHead`(`git rev-parse HEAD`), `sourceDirty`(추적 파일 변경 여부), `profile: "debug"`, `binary`(`…/Toris Studio QA.app/Contents/MacOS/<실행 파일>`), `binarySha256`, `builtAt`을 적는다. 실행 전과 끝난 뒤에 preflight로 같은 바이너리인지 다시 확인한다. 설치 앱의 버전 문자열이나 `cargo check` 성공은 근거로 쓰지 않는다.

## 실행

```bash
env HOME="$QA/home" TORIS_MOBILE_QA_NO_AUTOMATION=1 "<binary>" > "$QA/logs/run-N.log" 2>&1 &
```

- 같은 실행 파일을 직접 실행한다(`open`은 환경 변수를 넘기지 않는다).
- 실행마다 시각, PID(`ps -o pid,lstart,command`), 프로세스 환경에 두 변수가 있는지(`ps eww`)를 기록한다.

## 절차와 수락 기준

| # | 확인 | 방법 | 통과 조건 |
|---|---|---|---|
| A | 빌드↔소스 | preflight 전·후 | head·sha256 일치, debug |
| B | 재시작 초안 | QA 프로젝트의 대화 2개와 "새 대화"에 서로 다른 테스트 문장을 입력 → 메뉴로 정상 종료(PID 소멸 확인) → 같은 바이너리 재실행 | 세 초안이 각자 자리에 복원, `project_chat_send`·CLI 프로세스(`claude`/`codex` 자식) 없음 |
| C | 재시작 메타데이터 | 같은 재시작에서 Studio 전용 worktree 정보, 저장한 미리보기 주소, 테스트 커밋 영수증을 다시 열기 | 영수증 SHA가 QA 저장소 `git rev-parse` 결과와 같음 |
| D | OS 한글 입력기 | 입력 소스를 "2벌식"으로 두고 실제 키 입력으로 조합 → 조합 중 Enter / 다음 Enter / Shift+Enter | 조합 Enter는 전송 없음, 다음 Enter는 1회 전송, Shift+Enter는 줄바꿈. 붙여넣기·합성 이벤트는 통과로 세지 않음 |
| E | 단일 편집 창 | 실행 중 같은 바이너리를 한 번 더 실행 | 두 번째 PID가 곧 종료, 처음 PID 유지, 창 목록·접근성 트리에 프로젝트 composer 1개 |
| F | 증거 | 각 단계 스크린샷을 직접 확인 | QA 이름만 보임 |

D에서 실제로 보내는 "다음 Enter"는 받는 쪽을 호스팅 기획자(`hosted:*`)로 둔다. 이 대상은 요청 카드만 기록하고 네트워크 전송이나 에이전트 CLI를 시작하지 않으므로, 전송 횟수를 대화 기록의 요청 카드 수로 셀 수 있다. 앱의 자식 프로세스 목록도 함께 기록한다.

## 실행 기록

준비 단계: 아직 실제 앱 QA를 실행하지 않았다. 16번(`feature/orphan-draft-recovery`)의 PR이 나온 뒤 그 head를 통합한 빌드로 실행하고 여기에 결과를 적는다.

| # | 결과 | 소스 head / 바이너리 | 증거 |
|---|---|---|---|
| A | 미실행 | | |
| B | 미실행 | | |
| C | 미실행 | | |
| D | 미실행 | | |
| E | 미실행 | | |
| F | 미실행 | | |
