# 프로젝트 채팅 (Orca식 앱 폴더 + 에이전트 채팅)

[Orca](https://github.com/stablyai/orca)처럼 앱 폴더를 프로젝트로 넣고, 그 폴더에서 Claude Code·Codex와 **채팅으로** 기획하고 구현한다. 주 메뉴 맨 위 **프로젝트**에서 연다.

```
┌ 프로젝트 ───────┬ 대화 ─────────────────────────────┬ 변경 사항 ────────┐
│ pocket-app      │ 로그인 화면을 만들어줘    [기획|편집] │ ?? src/Login.tsx  │
│  ├ 새 대화      │  > Write src/Login.tsx  (펼치면 결과) │  M README.md      │
│  └ 로그인 …     │  > Bash pnpm test       (실패 표시)   │ diff (+/- 색 구분) │
│ other-app       │  완료 · 22초 · $0.65                 │                   │
│                 │ [메시지 ………………] [받는 에이전트 ▾] 보내기 │                   │
└─────────────────┴───────────────────────────────────┴───────────────────┘
```

## 사용법

1. 왼쪽 **프로젝트 추가**에서 `~/projects/my-app` 같은 전체 경로를 넣거나 **폴더 선택**을 누른다. Studio가 폴더를 실제 경로로 확인하고(홈 폴더 전체, 시스템·설정 폴더는 거부) **OS 확인 창**에서 **추가**를 눌러야 목록에 들어간다.
2. 메시지를 쓰고 Enter(줄바꿈은 Shift+Enter). 첫 메시지가 새 대화를 만들고 제목이 된다.
3. **받는 에이전트**
   - **Claude Opus 5.5 · medium** (기본): 그 폴더에서 `claude -p --output-format stream-json`으로 실행. 모델은 `claude-opus-5-5`, `CLAUDE_CODE_EFFORT_LEVEL=medium`으로 고정한다.
   - **Codex**: `codex exec --json`으로 실행.
   - **기획 · Reason Network**: 연결된 피어(Muse·OpenAI Dots를 추천으로 맨 위에 표시)에게 요청을 보낸다. Studio가 폴더에서 읽은 프로젝트 현황(구성, 최상위 항목, package.json 요약, README 앞부분)을 자료로 붙인다. 답장(그 요청에 대한 회신이며 보낸 피어에게서 온 것만)은 같은 대화에 기획 카드로 나타나고, **이 기획으로 구현**을 누르면 모드를 편집으로 바꾸고 Claude에게 보낼 구현 요청을 입력창에 채운다. 보내기는 직접 누른다.
   - **기획 · 호스팅 어시스턴트 (Muse · OpenAI Dots · Grok Bot)**: 이들은 Reason MCP(`list_team`, `send_message`, `check_inbox`)로만 Network에 붙고, 피어 목록에 나타나지 않으며 이름으로 메시지를 받지 못한다. 그래서 Studio는 아무것도 보내지 않고 **전달문**을 만든다. 전달문에는 요청, 프로젝트 현황, Studio 주소(`selfId`), 대화마다 새로 만든 코드(`TS-XXXXXXXXXX`)가 들어간다. **전달문 복사** 후 그 앱에 붙여넣으면, 어시스턴트가 `send_message`로 Studio에 기획을 보낸다. 첫 줄에 그 코드가 있는 메시지만 해당 대화에 기획 카드로 붙는다(대소문자 무시, 다른 대화의 코드는 무시).
   - 코드 없이 온 기획은 머리의 **받은 기획 가져오기**에서 직접 골라 붙인다. 화면은 메시지 ID만 넘기고, 보낸 사람과 본문은 Studio가 받은 메시지함에서 다시 읽는다.
   - 기획 카드의 **답장**은 그 기획을 보낸 주소에게만 `reply_to`를 달아 보낸다. 호스팅 어시스턴트는 사용자가 그 앱에서 다시 말을 걸 때 `check_inbox`로 받는다. 그 답에 대한 회신은 일반 회신 경로로 같은 대화에 붙는다.
   - 기획을 받거나 붙여도 아무것도 실행하지 않는다. 구현은 **이 기획으로 구현**으로 입력창을 채운 뒤 직접 보낸다.
4. **모드**: **기획**은 읽기 전용(Claude `--permission-mode plan`, Codex `read-only` 샌드박스), **편집**은 파일 수정(Claude `acceptEdits`, Codex `workspace-write`). 전체 권한(`bypassPermissions`, `danger-full-access`)은 어떤 경우에도 쓰지 않는다. 승인이 필요한 명령은 거부되고 그 사실이 대화에 표시된다.
5. 답하는 동안 도구 호출이 한 줄씩 쌓인다. 줄을 펼치면 입력과 결과를 본다. **중지**는 그 대화의 프로세스 그룹에 TERM, 3초 뒤 KILL을 보낸다.
6. 오른쪽 **변경 사항**은 그 폴더의 `git status`와 `git diff HEAD`를 읽기 전용으로 보여 주며, 대화의 한 턴이 끝날 때마다 다시 읽는다.
7. 다음 메시지는 같은 CLI 대화를 이어 간다(Claude `--resume`, Codex `exec resume`). 대화를 시작한 뒤에는 에이전트를 바꿀 수 없고, 새 대화를 연다.

## 동작과 안전장치

- 한 턴 = CLI 프로세스 하나, 자기 프로세스 그룹. 입력한 문장은 **stdin**으로만 전달하고 명령줄에 넣지 않는다.
- 한 대화에 한 턴씩, 전체 동시 실행은 4개까지. Studio를 종료하면 실행 중인 턴을 멈춘다.
- 실행 직전마다 폴더가 확인한 그 경로 그대로인지(심볼릭 링크로 바뀌지 않았는지) 다시 검사한다.
- 에이전트 출력은 신뢰하지 않는 자료다. 정해진 항목(메시지, 생각, 도구 호출·결과, 완료·오류)으로만 정리해 길이를 제한하고, 보이지 않는 문자를 지우고, HTML이 아닌 텍스트로 표시한다. 훅 출력이나 토큰 카운터는 표시하지 않는다.
- 기록은 `~/Library/Application Support/kr.toris.studio/project-chat/`(macOS)에 저장한다. 목록에서 프로젝트를 지우면 그 대화 기록만 지우고 폴더는 건드리지 않는다.

## 검증

```bash
node --import tsx --test tests/project-chat-client.test.ts
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --test project_chat_contract
node scripts/verify-project-chat-ui.mjs   # Chromium + 고정 IPC 응답, 스크린샷은 /private/tmp/toris-project-chat-ui
# 실제 Claude Code로 임시 폴더에서 한 턴 (비용 발생)
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --test project_chat_contract -- --ignored live --nocapture
```
