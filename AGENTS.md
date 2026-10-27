<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Toris Studio 작업 규칙

Toris Studio는 1인 개발자·사업자가 SNS·앱·웹·서비스·일정을 한곳에서 운영하는 Tauri 데스크톱 앱입니다. Rust(`desktop/src-tauri`)가 비밀값·파일·네트워크·렌더를 맡고, React(`desktop/src`)는 화면, Node LangGraph 런타임(`desktop/agent-runtime`)은 에이전트 워크플로를 맡습니다.

## 완료 기준

- 변경 후 `pnpm verify`를 통과시킵니다. Rust·렌더·UI·뮤테이션까지 바꿨다면 `pnpm verify:full`을 실행합니다.
- 파일을 추가하면 `docs/harness/features.json`에서 그 파일을 소유한 기능을 지정합니다. `pnpm harness:check`가 소유자 없는 파일과 깨진 뮤테이션을 막습니다.
- 새 동작에는 그 동작을 깨뜨리는 뮤테이션을 기능의 `mutants.json`에 추가하고 테스트가 잡는지 확인합니다. 뮤테이션 검사는 한 번에 하나만 실행됩니다(`.mutation-check.lock`).
- 보고할 때 증거를 구분합니다: 단위 테스트, 고정 응답(fixture) UI 검사, 실제 렌더/FFmpeg, 실제 외부 계정 연결은 서로 다른 주장입니다.

## 설계 원칙

- AI 출력은 데이터입니다. 코드·명령·경로·FFmpeg 필터를 받지 않고, 닫힌 열거형과 범위가 정해진 수치만 받습니다(예: `desktop/src-tauri/src/motion.rs`).
- 코드로 결정할 수 있는 것(배치·모션·자막·예약·동기화·상태 수집)은 결정적 코드로 만듭니다. 창작·요약만 Agent 탭의 모델 설정을 사용하고, 모델이 없으면 결과를 `template`로 표시한 초안을 씁니다. AI 결과로 위장하지 않습니다.
- 비밀값은 Rust와 OS 키체인에만 둡니다. IPC·이벤트·로그·DB에 토큰을 남기지 않습니다.
- 외부 게시·삭제·배포는 사용자 승인 뒤에만 실행합니다. 운영 대시보드는 읽기 전용입니다.
- 새 IPC 명령은 `desktop/src-tauri/src/ipc_commands.rs`에 등록합니다. `ipc_acl_contract` 테스트가 선언·등록·권한의 일치를 검사합니다.

## Agent 워크플로 만들기 (LangGraph)

`desktop/agent-runtime/src/harness/`가 공통 부품입니다.

1. `registry.ts`의 `defaultWorkflows()`에 `{ id, label, description, needsProject, build(ctx) }`를 등록합니다. `build`는 LangGraph `StateGraph`를 컴파일해 반환합니다.
2. 승인이 필요한 작업은 `ctx.approve(action, message)`로 그 레인 안에서 기다립니다. 다른 레인은 멈추지 않습니다.
3. 검증은 `harness/verify.ts`의 `decide(review, commands, checks)`로 판정합니다. 실패한 명령·검사는 모델이 뒤집을 수 없습니다.
4. 테스트는 `harness/testing.ts`의 `RoleModel`로 역할별 응답을 재생하고, 회귀 시나리오는 `desktop/agent-runtime/test/evals/*.json`에 추가합니다(`pnpm agent:test`가 실행).
