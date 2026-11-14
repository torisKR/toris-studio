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

## 준비 중 확인한 실행 제약 (c07f494 빌드, 실증 아님)

- **격리 동작:** QA 앱은 `open -n --env HOME=… --env TORIS_MOBILE_QA_NO_AUTOMATION=1 "<QA.app>"`로 띄웠을 때 프로세스 환경에 두 변수가 모두 들어갔다(`ps eww`). 단일 실행 소켓은 `/tmp/kr_toris_studio_qa_si.sock`만 생겼고, 프로젝트 목록은 비어 있었다(사용자 데이터 미노출). 직접 실행 파일 실행도 같은 결과였지만, 창이 활성화되지 않아 `open`을 쓴다.
- **정상 종료:** `osascript -e 'tell application id "kr.toris.studio.qa" to quit'` 후 프로세스와 QA 소켓이 사라졌다.
- **조작 경로:** 앱 창은 접근성 트리로 클릭·입력할 수 있다. `type_text`는 2벌식이 선택된 상태에서도 영문 경로를 그대로 넣었으므로 입력기를 거치지 않는 것으로 본다. 따라서 D의 근거로 쓰지 않는다.
- **OS 확인 창 제약:** 부모 창 없는 rfd 메시지 창(`reason_native::confirm`)은 macOS에서 `CFUserNotification`으로 뜨고, 앱이 아닌 UserNotificationCenter 프로세스가 그린다. 이번 실행 환경의 화면 조작 도구는 이 창을 대상으로 잡지 못한다. CLI에는 화면 녹화 권한이 없어 화면 전체 캡처도 실패했다. 그래서 프로젝트 추가·Studio worktree 생성·선택 커밋처럼 OS 확인이 필요한 단계는 **사람이 직접 확인 버튼을 눌러야** 진행된다. 내용을 볼 수 없는 시스템 알림에 키를 보내지 않는다.
- **우회와 그 한계:** B·D·E에서 쓸 QA 프로젝트는 QA `HOME`의 `projects.json`에 QA 저장소 한 개를 직접 기록해 준비할 수 있다. 사용자의 실제 저장소와는 무관하고, 프로젝트 추가 확인 흐름 자체는 검증 대상이 아니다. C(worktree 정보·커밋 영수증)는 실제 OS 확인을 거쳐야 하므로 사람이 확인 버튼을 누르지 않으면 **미검증**으로 남긴다. 영수증·worktree 기록을 파일로 꾸며 넣지 않는다.

## 실행 기록

- **소스 head:** `11c060c` = #33 `c07f494`(통합) + #34 `698772c`(15번) + #35 `f79876c`(16번)을 이 브랜치에 일반 merge. 추적 파일 깨끗함.
- **바이너리:** `Toris Studio QA.app/Contents/MacOS/toris-studio-desktop`, debug, sha256 `2f606beb88c20dca8ed5fd3b7d6dc5d6d007d017fba9cb744203814e5b369345`(빌드 08:33:51Z). 실행 전후 preflight로 같은 값을 확인했다.
- **실행 환경:** 사용자의 MacBook(macOS 27.2.1), 입력 소스 2벌식. 실행할 때마다 `ps eww`로 `HOME=/tmp/toris-native-qa/home`, `TORIS_MOBILE_QA_NO_AUTOMATION=1`이 들어갔는지 확인했다. 설치 앱은 실행 중이 아니었고 건드리지 않았다. 1420 포트는 쓰지 않았다.
- **QA 프로젝트:** `$QA/repos/qa-notes`(새 git 저장소, 커밋 2개). OS 확인 창 제약 때문에 QA `projects.json`에 직접 등록했다(위 "준비 중 확인한 실행 제약" 참고).

| # | 결과 | 관찰 |
|---|---|---|
| A 빌드↔소스 | **통과** | 위 head·sha256, debug. 세 번의 실행이 모두 같은 바이너리였다. |
| B 재시작 초안 | **통과** | 대화 1(`한QA 초안 A (저장된 대화 1)`), 대화 2(`2 QA 대화 시작`), "새 대화"(`ㅊ QA 초안 C (새 대화)`)에 서로 다른 초안을 넣었다. Apple Event로 정상 종료한 뒤(08:39:57Z, PID 42855 소멸, QA 소켓 삭제) 같은 바이너리로 재실행(PID 56993)했고, 다시 한 번 종료·재실행(PID 62142)했다. 두 번 모두 세 초안이 각자 자리에 복원됐다. 재실행 후 앱의 자식 프로세스는 0개였고, 새 대화나 요청도 생기지 않았다(자동 전송·CLI 실행 없음). page reload나 tray 숨김은 재시작으로 세지 않았다. |
| C 재시작 메타데이터 | **부분** | 미리보기 주소 `http://127.0.0.1:4719/qa`를 대화 2에 저장했다. 재시작 후 대화 2에만 "사용자가 연결한 주소 · 이 대화의 서버인지 확인하지 않음"과 함께 복원됐고, 대화 1에는 없었다(서버는 띄우지 않았고 "미리보기 열기"도 누르지 않았다). **Studio worktree 정보와 커밋 영수증은 미검증이다.** 둘 다 OS 확인 창(CFUserNotification)을 거쳐야 하는데 이 환경에서 그 창을 조작할 수 없었고, 기록을 파일로 꾸며 넣지도 않았다. 저장 계층의 재열기는 R의 `project_git_commit_receipt_survives_reopen`, `project_chat_stores_projects_threads_and_items`로만 확인했다(native 재시작의 대체가 아니다). |
| D 한글 입력기 | **실패**(15번 회귀) → `54f610e`에서 **재시험 통과**(아래) | 실제 2벌식 입력기에 실제 키 이벤트(`g`→"ㅎ", `k`→"하", `s`→"한", 조합 중 밑줄)를 보냈다. 조합 중에 Enter를 누르자(08:35:40Z) 전송이 실행됐다. `project_chat_thread_create`로 새 대화가 생겼고, Muse 요청은 "Reason Network에 연결된 뒤…" 오류로 끝났으며, 입력창에는 "한"이 남았다. CLI는 실행되지 않았다. Shift+Enter는 줄바꿈만 넣었다(`한\n`, 통과). "조합 확정 뒤 다음 Enter는 1회 전송"은 앞의 실패로 대화가 이미 생긴 상태라 따로 판정하지 않았다(미판정). 원인 추정: WKWebView가 확정 Enter keydown을 keyCode 229가 아닌 값·`isComposing=false`로 보내 `isSendEnter`를 통과한다. 다만 이벤트 필드는 캡처하지 않아 **가설**이다. 15번 소유자에게 재현 절차·빌드 SHA·시각과 함께 넘겼다. 수정 후 같은 절차로 다시 시험해야 한다. |
| E 단일 편집 창 | **통과** | PID 42855가 실행 중일 때(08:39:27Z) 같은 `.app`을 `open -n`으로 한 번 더 실행했다. 두 번째 프로세스(PID 55425)는 0.5~1초 안에 사라졌고 원래 PID 42855는 유지됐다. 전후 모두 QA 프로세스의 화면 창은 1개(창 번호 3923, 1380×900)였다. 접근성 트리에도 창 1개, 메시지 입력창 1개만 있었고, 입력 중이던 초안 C가 그대로 남아 있었다. 다중 창 동시 편집 안전성은 주장하지 않는다. |
| F 증거 | **통과** | QA 창만 캡처했고(QA 프로젝트명·테스트 문장만 보임) 직접 확인했다. 로그는 `$QA/logs/`(run1~3, B, B2, E)에 있다. |

### D 재시험 (#35 `54f610e`, 15번 수정 반영)

- **소스 head:** `d30b567` = 이 브랜치에 #35 `54f610e`(#34 `3618ab1` 한글 확정 Enter 수정 포함)를 일반 merge. 추적 파일 깨끗함. 같은 overlay·`CARGO_TARGET_DIR`로 다시 빌드했다.
- **바이너리:** debug, sha256 `283645ab6c683e61636f5d6a564e7d95865343c6ea213c2737354a57320b85fa`(빌드 09:04:03Z). 실행 전후 preflight(`--require 54f610e --require 3618ab1`) 통과. 이전 빌드 기록은 `$QA/build-11c060c.json`.
- **실행:** PID 13032, `ps eww`로 `HOME=/tmp/toris-native-qa/home`, `TORIS_MOBILE_QA_NO_AUTOMATION=1` 확인. 설치 앱·1420 포트는 쓰지 않았다. 정상 종료(Apple Event) 후 QA 프로세스·소켓이 사라졌다. 로그 `$QA/logs/D2.log`.
- **절차:** "새 대화"에서 받는 쪽을 Muse로 바꾸고 입력창을 비운 뒤, 2벌식 입력기에 실제 키 `g`→"ㅎ", `k`→"하", `s`→"한"(조합 중 밑줄)을 보냈다.

| 단계 | 결과 | 관찰 |
|---|---|---|
| 조합 중 Enter | **통과** | 전송 없음. 화면·접근성 트리 변화 없음, 입력창은 "한" 그대로, 줄바꿈도 들어가지 않았다. 2초 뒤 QA `projects.json`에 새 대화가 없었다(파일 수정 시각 변화 없음). |
| 이어서 별도 Enter | **통과** | 전송 1회. 새 대화 1개(`79844961…`, createdAt 09:06:36.493Z)가 생겼고, Muse 요청은 이전과 같이 "Reason Network에 연결된 뒤…" 오류로 끝났다(이 QA 환경은 Reason Network에 연결하지 않는다). 입력창에는 실패한 요청의 초안 "한"이 남았다. CLI는 실행되지 않았다. |

따라서 위 D 실패(08:35:40Z, `11c060c` 빌드)는 `54f610e` 빌드에서 재현되지 않았고, "조합 확정 뒤 다음 Enter 1회 전송"도 이번에 판정했다. Shift+Enter는 아래 "나머지 확인"에서 같은 빌드로 다시 확인했다. 원인 가설(확정 Enter keydown의 필드 값)은 여전히 이벤트를 캡처하지 않았으므로 검증하지 않았다.

![17 D 재시험 54f610e: 조합 중 Enter 전송 없음, 다음 Enter 1회 전송](https://api.reasonmachines.com/media/pr-screenshots/14d2b11e-e951-42da-9e76-c1c2cbb36ec8/b2bb95904648de060d195f882d112a8c/17-d-retest-54f610e.jpg#w=1280&h=835)

### 같은 빌드(`283645ab…`)의 나머지 확인 (09:11~09:14Z, PID 26880, 로그 `$QA/logs/F.log`)

실행 소스는 위와 같은 `d30b567` 빌드다. 그 뒤 checkout은 문서만 바꾼 `46bfcc9`라 preflight의 head 비교는 그 차이 때문에만 실패했고, 바이너리 sha256 일치·QA 격리 항목은 통과했다.

| 단계 | 결과 | 관찰 |
|---|---|---|
| Shift+Enter(일반 상태) | **통과** | 받는 쪽 Muse, 조합되지 않는 `1` 입력 뒤 Shift+Enter → 입력창 `1\n`, 전송 없음 |
| Shift+Enter(조합 중) | **통과** | 이어서 `g k s` → "한" 조합 중 Shift+Enter → "한"이 확정되고 줄이 바뀜(`1\n한\n`), 전송 없음. QA `projects.json`의 수정 시각(09:06:36Z)·대화 수 변화 없음 |
| C worktree 정보 재시작 복원 | **미검증** | "격리된 새 대화" → 계획(QA 저장소 `qa-notes-worktrees/ea53ee93`, `studio/ea53ee93`, HEAD `e629624`) → "만들기"까지 진행했다. 그다음 OS 확인 창이 `UserNotificationCenter` 프로세스 창으로 떴다. 이 환경의 화면 조작 도구는 그 창을 목록에 보여 주지 않고, 접근성 권한도 없어(`AXIsProcessTrusted()=false`) 내용을 읽거나 누를 수 없다. 사람의 승인 단계를 스크립트로 우회하지도 않았다. 앱을 정상 종료했고 worktree는 생기지 않았다(`git worktree list`에 main만 있음). |
| C 커밋 영수증 재시작 복원 | **미검증** | Studio worktree가 있어야 커밋할 수 있고, 커밋도 같은 OS 확인 창을 거친다. 위 이유로 실행하지 못했다. |

남은 정리: 화면에 `UserNotificationCenter` 확인 창 4개가 남아 있다. 이번 것 1개(QA worktree 만들기)와 앞선 QA 실행에서 남은 것으로 보이는 3개다. 요청한 QA 앱은 이미 종료됐으므로 사람이 "취소"로 닫으면 된다. 내용을 읽을 수 없어 출처를 확정하지는 못했다.

![17 D Shift+Enter 54f610e: 일반·조합 중 모두 줄바꿈만, 전송 없음](https://api.reasonmachines.com/media/pr-screenshots/14d2b11e-e951-42da-9e76-c1c2cbb36ec8/d0d1ee6f3f872705e5d316a514be6006/17-d-shift-enter-54f610e.jpg#w=1280&h=835)

### 증거

![17 B 재시작 후 대화별 초안 복원](https://api.reasonmachines.com/media/pr-screenshots/b83b959a-9dff-47f8-bd71-368b9b7bf504/3a5d9a3a2a0aabab862cf84cb286117a/17-b-restart-drafts.jpg#w=1280&h=835)

![17 C 재시작 후 미리보기 주소 복원 대화 2만](https://api.reasonmachines.com/media/pr-screenshots/b83b959a-9dff-47f8-bd71-368b9b7bf504/1ad94609917420b86d7383e34fa21f4f/17-b-restart-preview.jpg#w=1280&h=835)

### 남은 일

- ~~15번 수정 후 D 재시험~~: `54f610e` 빌드(소스 `d30b567`)에서 통과(위 "D 재시험").
- C의 worktree·커밋 영수증은 사람이 OS 확인 버튼을 눌러 줄 수 있을 때 같은 절차(격리된 새 대화 → 만들기 → OS 확인 → 선택 커밋 → OS 확인 → 정상 종료·재실행)로 실행한다. `283645ab…` 빌드에서도 미검증.
