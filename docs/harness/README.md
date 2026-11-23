# 하네스 엔지니어링

하네스는 "이 변경이 끝났는가"를 사람이나 모델의 말이 아니라 실행 결과로 판정하는 장치입니다. 이 저장소에는 세 겹이 있습니다.

| 겹 | 막는 것 | 위치 |
|---|---|---|
| 저장소 하네스 | 소유자 없는 파일, 동작을 증명하지 못하는 테스트 | `docs/harness/features.json`, `scripts/harness-check.mjs`, `scripts/mutation-check.mjs`, `scripts/verify.mjs` |
| 에이전트 런타임 하네스 | 모델이 실패한 검증을 통과로 뒤집는 것, 승인 없는 파일 쓰기·명령 실행 | `desktop/agent-runtime/src/harness/` |
| CI | 설치 파일과 공개 전 검사 누락 | `.github/workflows/` |

개발에 쓰는 에이전트의 역할과 모델은 [에이전트 팀](AGENT_TEAM.md)에 있습니다. 앱 안 Agent 탭의 LangGraph 에이전트는 제품 기능이며 [Agent 안내](../AGENT.md)에서 설명합니다.

## 완료 판정: `pnpm verify`

`scripts/verify.mjs`가 단계를 차례로 실행하고 첫 실패에서 멈춥니다.

| 명령 | 단계 | 언제 |
|---|---|---|
| `pnpm verify` | 하네스 검사 → 하네스 도구 테스트 → 웹·데스크톱 타입 → 데스크톱 UI 타입 → 에이전트 런타임 타입 → 단위 테스트 → 에이전트 런타임 테스트와 회귀 시나리오 | 모든 변경 뒤 |
| `pnpm verify:full` | 위 단계 + Rust 테스트 → 런타임 변형 → Rust 변형 → Agent UI 검사 → Reason Network UI 검사 → Agent UI 변형 → 플래너 UI 검사 → 운영 UI 검사 → 데스크톱 시작 검사 | Rust·렌더·UI·변형을 바꿨을 때 |

**데스크톱 시작 검사**(`scripts/verify-desktop-startup-smoke.mjs`)는 설치 파일의 네이티브 시작 검사 `--startup-smoke`가 쓰는 `desktop/src-tauri/src/startup_smoke.js`를 그대로 WebKit에서 실행합니다. 화면을 새로 빌드하고 네이티브 CSP를 붙여, 첫 화면과 설정 탭이 부르는 IPC가 모두 그 스크립트의 고정 응답에 있는지, 이미지 같은 자원이 모두 열리는지, 읽기 목록·주 메뉴가 `startup_smoke.rs`와 같은지 확인합니다. 전에는 이 검사가 설치 파일 CI(`prepare-browser-installer.mjs`)에서만 돌았고 다른 UI 검사는 모르는 IPC에 `null`을 돌려주는 자체 고정 응답을 써서, 시작할 때 새 IPC를 부르는 화면을 추가하면 릴리스 빌드에서야 실패했습니다. 시작할 때 새 IPC를 부르게 했다면 `startup_smoke.js`의 고정 응답·`expectedReads`와 `startup_smoke.rs`의 `READS`를 함께 고칩니다.

작업 중에는 전체를 돌리지 말고 바꾼 기능의 `verify` 명령만 돌립니다(아래 기능 지도). 전체는 마지막에 한 번 돌립니다.

**로컬에서 `verify:full`을 돌릴 수 없을 때**(저장공간 부족 등)는 GitHub Actions의 **Full verification (verify:full)** 워크플로(`.github/workflows/verify-full.yml`)를 씁니다. PR에 `verify-full` 라벨을 붙이면 돌고, 이 파일이 기본 브랜치에 들어간 뒤에는 Actions → Run workflow로도 돌릴 수 있습니다. macOS arm64 실행기에서 `desktop.yml`의 `native` 작업과 같은 Rust·Node·Go 버전으로 고정 미디어(`prepare-media`)와 에이전트 런타임 번들을 준비하고, Playwright Chromium·WebKit, 변형 검사가 쓰는 PostgreSQL 17·GNU `timeout`, RAG 라이브 테스트용 ChromaDB(`chromadb==1.5.9`, `setup-python`으로 고정한 Python 3.12, 포트 18765)를 띄운 뒤 브로커·콜백 테스트와 브로커 변형, 그리고 `node scripts/verify.mjs full --keep-going`을 실행합니다. `--keep-going`은 CI 전용으로, 한 단계가 실패해도 나머지 단계를 한 번씩 모두 돌리고 끝에 실패한 단계를 모아 보여 줍니다(로컬 `pnpm verify:full`은 그대로 첫 실패에서 멈춥니다). 실패한 단계와 `SURVIVED`·`invalid` 변형은 실행 요약(Step Summary)에 모입니다. 시크릿을 쓰지 않습니다. Rust 변형만 178개라 몇 시간이 걸릴 수 있고 작업 제한은 350분입니다. 실패하면 UI 검사 산출물이 아티팩트로 남습니다.

## 기능 지도: `features.json`

기능마다 어떤 파일을 소유하고 무엇이 그 동작을 증명하는지 적습니다.

| 필드 | 뜻 |
|---|---|
| `id`, `label` | 기능 이름 |
| `paths` | 이 기능이 소유한 파일의 glob. `**`는 폴더를 넘고 `*`는 한 폴더 안에서만 맞습니다 |
| `verify` | 이 기능이 동작한다는 증거가 되는 명령 |
| `mutants` | 이 기능의 변형 목록 파일 |

`pnpm harness:check`는 다음 경우에 실패합니다.

- 바뀌었거나 새로 생긴 파일(`git diff HEAD`와 추적하지 않는 파일)을 소유한 기능이 없을 때. `--all`을 붙이면 추적 중인 모든 파일을 검사합니다.
- 변형의 `find` 문자열이 대상 파일에 정확히 한 번 나오지 않을 때.
- 변형 검사가 진행 중일 때(`.mutation-check.lock`이 있음).

파일을 추가하면 그 파일을 소유할 기능의 `paths`에 glob을 넣습니다. 맞는 기능이 없으면 새 기능을 만들고 `verify`를 채웁니다.

## 변형(뮤테이션) 검사

변형은 동작 하나를 일부러 깨뜨린 코드입니다. 변형을 넣은 채 테스트가 통과하면(`SURVIVED`) 그 테스트는 그 동작을 증명하지 못한 것입니다. 실패하면 `killed`입니다.
`invalid`는 그 변형이 아무것도 증명하지 못했다는 뜻입니다. `find`가 정확히 한 번 나오지 않았거나, 테스트 명령을 시작하지 못한 경우(프로그램 없음, `timeout`·pnpm 스크립트 같은 감싼 명령의 종료 코드 126·127)입니다. `invalid`도 전체 결과를 실패로 만듭니다.

```json
{
  "id": "fs.traversal-allowed",
  "file": "desktop/agent-runtime/src/tools/fs.ts",
  "find": "if (clean === \"..\" || clean.startsWith(\"../\")) throw",
  "replace": "if (false) throw",
  "test": "desktop/agent-runtime/test/tools.test.ts"
}
```

`test` 대신 `cmd`(argv 배열)와 `timeoutMs`를 쓸 수 있습니다. Rust 변형은 `cmd`로 `cargo test`를 지정합니다.

| 목록 | 실행 |
|---|---|
| `desktop/agent-runtime/test/mutants.json` | `pnpm agent:mutation` |
| `desktop/agent-runtime/test/ui-mutants.json` | `pnpm agent:mutation:ui` (화면 검증 스크립트를 쓰므로 느림) |
| `desktop/src-tauri/tests/mutants.json` | `pnpm agent:mutation:rust` |
| `android/companion/mutants.json` | Android 리모컨 변형 목록 |

변형 하나만 확인하려면 ID 앞부분을 넘깁니다: `node scripts/mutation-check.mjs desktop/src-tauri/tests/mutants.json rs.reason-`.

변형 검사는 실행하는 동안 소스 파일을 실제로 바꿔 씁니다. 그래서 다음을 지킵니다.

- 한 번에 하나만 실행합니다. 잠금 파일이 있으면 두 번째 실행은 바로 끝납니다.
- 검사가 도는 동안 같은 작업 폴더에서 빌드·테스트·편집을 하지 않습니다. 변형된 소스를 보게 됩니다.
- 중단 신호(SIGINT·SIGTERM)를 받으면 실행 중인 테스트를 끝내고 원본을 복원한 뒤 잠금을 풉니다. `scripts/mutation-check.test.mjs`가 이 동작을 확인합니다.
- 강제 종료나 전원 차단처럼 신호를 받지 못하고 끝났다면 `git diff`로 변형이 남았는지 확인한 뒤 `.mutation-check.lock`을 지웁니다.

## 에이전트 런타임 하네스

`desktop/agent-runtime/src/harness/`는 Agent 탭 워크플로의 공통 부품입니다.

| 파일 | 역할 |
|---|---|
| `registry.ts` | `defaultWorkflows()`에 워크플로를 등록합니다. 지금은 `coding`, `weekly-content`, `ops-triage`, `video-production`, `game-factory`, `app-factory`입니다 |
| `workflow.ts` | `WorkflowSpec`(`id`, `label`, `description`, `needsProject`, `build(ctx)`)과 레지스트리 |
| `verify.ts` | `decide(review, commands, checks)`. 실패한 명령(exit ≠ 0)이나 실패한 검사가 하나라도 있으면 리뷰 모델이 통과라고 해도 `fail`입니다 |
| `testing.ts` | `RoleModel`. 역할별로 준비한 모델 응답을 순서대로 재생해 실제 모델 없이 그래프를 테스트합니다 |
| `eval.ts` | 회귀 시나리오 실행기. `desktop/agent-runtime/test/evals/*.json`을 임시 프로젝트에서 실제 워크플로로 재생합니다 |
| `trace.ts` | 실행 기록 |
| `hub.ts`, `production.ts` | 운영 워크플로와 영상 스토리보드 워크플로 |

회귀 시나리오 파일의 필드는 `name`, `workflow`(생략하면 `coding`), `task`, `input`, `files`(임시 프로젝트에 만들 파일), `script`(역할별 모델 응답), `decisions`(승인 요청 순서대로 `approve`·`reject`), `expect`(`phase`, `changes`, `messages`, `maxModelCalls`)입니다. `pnpm agent:test`가 모두 실행합니다.

워크플로를 새로 만드는 순서는 `AGENTS.md`의 "Agent 워크플로 만들기"를 따릅니다.

## 새 동작을 넣는 순서

1. 바꿀 파일을 소유한 기능을 `features.json`에서 찾습니다. 새 파일이면 `paths`에 넣습니다.
2. 실패하는 테스트를 먼저 쓰고 실패를 확인합니다.
3. 테스트가 통과하는 최소한을 구현합니다.
4. 그 동작을 깨는 변형을 기능의 `mutants.json`에 추가하고 `killed`인지 확인합니다.
5. 기능의 `verify` 명령을 돌린 뒤 `pnpm verify`를 돌립니다. Rust·렌더·UI·변형을 바꿨으면 `pnpm verify:full`을 돌립니다.
6. 증거 수준을 구분해 보고합니다.

## 증거 수준

아래 넷은 서로 다른 주장입니다. 보고할 때 어느 것인지 적고, 실행하지 않은 것을 확인했다고 쓰지 않습니다.

| 수준 | 뜻 | 예 |
|---|---|---|
| 단위 테스트 | 함수·모듈이 계약대로 동작 | `pnpm test`, `cargo test … --lib motion_ai::` |
| 고정 응답 UI 검사 | IPC·AI 응답을 고정해 둔 화면이 동작 | `node scripts/verify-agent-ui.mjs`, `node scripts/verify-production-ui.mjs`, `node scripts/verify-desktop-readiness.mjs` |
| 실제 렌더 | 번들 FFmpeg로 실제 파일을 만들어 프레임을 확인 | `pnpm motion:verify:media`, 설치 검사 `--motion-smoke` |
| 실제 외부 계정 | 등록한 클라이언트와 실제 계정으로 로그인·조회 | `pnpm qa:live:oauth`, `pnpm qa:live:preflight` (사용자가 실행을 승인했을 때만) |

## 설계 원칙을 지키는 검사

| 원칙 | 지키는 장치 |
|---|---|
| 새 IPC 명령은 `desktop/src-tauri/src/ipc_commands.rs`에 등록 | `ipc_acl_contract` 테스트가 선언·등록·권한의 일치를 검사 |
| AI 출력은 데이터 | 닫힌 열거형과 범위 검증(예: `motion.rs`, `motion_ai.rs`, `harness/production.ts`의 Zod 스키마) |
| 비밀값은 Rust와 OS 키체인에만 | `pnpm security:check`(`scripts/check-secrets.sh`), 공개 전 gitleaks |
| 모델이 없으면 `template` 초안 | 회귀 시나리오 `*-template.json` |
