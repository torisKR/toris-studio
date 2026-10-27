# Agent 탭 · 멀티 에이전트 개발 환경

`~/projects`의 프로젝트를 골라 작업을 지시하면 LangGraph 그래프의 Supervisor가 Frontend·Backend Expert에게 작업을 나눠 맡깁니다. 두 Expert는 동시에 일하고, 둘 다 끝나면 QA Reviewer가 빌드·테스트로 확인해 문제가 있는 Expert에게만 돌려보냅니다. 파일 쓰기와 명령 실행은 **사용자 승인 후**에만 일어납니다.

같은 모델 설정이 AI 작업실·영상 초안·SNS 문구·이미지 생성기에도 쓰입니다. Codexify·ChatGPT 대화 연결은 제거되었습니다.

## 구조

```
┌──────────────── Tauri WebView (desktop/src) ────────────────┐
│ AgentPanel ─ AgentRunView(레인·진행 바·승인 카드·기록)        │
│            └ AgentSettingsCard(모델·API 키·임베딩)            │
│ AI 작업실 / 영상 / SNS / 이미지 생성기 ─ ai-client.ts          │
└───────┬───────────────────────────────▲─────────────────────┘
        │ invoke(agent_call, ai_generate…)│ event "agent-event"
┌───────▼──── Rust (desktop/src-tauri) ──┴─────────────────────┐
│ agent_native.rs   명령 허용 목록 · 승인된 창만 호출            │
│ agent_runtime.rs  Node 자식 프로세스 · JSONL stdin/stdout      │
│                   API 키: OS 키체인 → configure로만 전달       │
│ ops::start_vector_db  docker compose (ChromaDB 1.5.9)         │
└───────┬──────────────────────────────────────────────────────┘
        │ stdin/stdout JSONL (열린 포트 없음)
┌───────▼──── Node 에이전트 런타임 (desktop/agent-runtime) ─────┐
│ graph/   LangGraph StateGraph · 레인별 승인 대기(Promise)      │
│ llm/     API 5종 + 구독 CLI 5종 (텍스트 전용 실행)             │
│ tools/   fs 샌드박스 · 명령 허용 목록 · diff                   │
│ rag/     청크·임베딩 → ChromaDB REST (프로젝트별 컬렉션)        │
└───────┬──────────────────────────────┬───────────────────────┘
        │ 파일·명령 (승인 후)             │ http://127.0.0.1:18765
   ~/projects/<프로젝트>              ChromaDB 컨테이너
```

UI와 런타임 사이에 WebSocket·SSE 포트를 열지 않습니다. Rust가 런타임의 stdout 이벤트를 Tauri 이벤트로 전달하므로, 다른 로컬 프로세스가 에이전트에 접속할 수 없습니다.

## 에이전트 그래프

```
START → supervisor ─▶ experts ┌ frontend 레인 ┐ ─▶ qa ─▶ finalize ─▶ END
                              └ backend 레인  ┘     │ 검증 명령 동시 실행
                         ▲                         │
                         └── fail: rework 레인만 (최대 2회 반려)
```

| 노드 | 하는 일 |
|---|---|
| supervisor | 프로젝트 스택·scripts·벡터 검색 결과를 보고 레인(담당 Expert와 맡을 범위), 계획, 독립 검증 명령(최대 3개)을 고릅니다. |
| experts | 레인을 동시에 실행합니다. 읽기 도구는 바로 실행하고, `edit_file`·`write_file`·`run_command`는 그 레인 안에서 승인을 기다립니다. 한 레인이 승인을 기다려도 다른 레인은 계속 일합니다. |
| qa | 검증 명령을 동시에 실행하고, diff·로그·각 Expert 요약으로 통과·반려를 정합니다. 반려 시 `rework`에 적힌 Expert만 다시 일합니다. |
| finalize | 결과 요약과 바뀐 파일 목록을 남깁니다. |

승인 요청은 동시에 여러 건 열릴 수 있고, 화면에 카드가 하나씩 뜹니다. 순서와 관계없이 하나씩 결정하면 그 요청을 낸 레인만 이어집니다.

한 작업 안에서 이미 승인한 명령(같은 argv)은 다시 묻지 않고 실행합니다. 명령이 실행할 내용을 바꾸는 파일(`package.json`, `Cargo.toml`, `*.config.*`, `tsconfig*.json` 등)이 바뀌면 이 기억을 지우고 다시 승인받습니다. 실패한 검증 명령(exit ≠ 0)은 모델이 통과라고 해도 실패로 판정합니다.

모델 출력은 매 단계 JSON 액션 하나입니다. 그래서 도구 호출을 지원하지 않는 구독 CLI도 같은 그래프를 씁니다.

## 운영 워크플로

코드 작업 외에 프로젝트 폴더 없이 Studio의 로컬 DB 자료만 읽는 워크플로가 두 개 있습니다. Agent 탭의 **운영 워크플로**에서 시작합니다.

| 워크플로 | 입력 | 결과 |
|---|---|---|
| `weekly-content` 주간 콘텐츠 초안 | 등록 채널, 기존 콘텐츠 제목, 수집한 트렌드, 이번 주 일정·작업 | 승인한 초안을 콘텐츠 플래너에 `초안` 상태로 저장 |
| `ops-triage` 운영 점검 | 운영 상태 탭에 저장된 최신 상태(새 네트워크 요청 없음) | 승인한 항목을 일정·작업에 열기 (같은 제품·소스는 한 건만) |

그래프는 `plan → check → propose → finalize`입니다. 모델 초안은 규칙 검사를 거칩니다. 트렌드 목록에 없는 링크는 빼고, 이미 있는 제목과 14일 밖의 제안 시각은 거부합니다. 운영 점검은 실패 목록에 없는 제품·상태를 빼고, 모델이 빠뜨린 실패는 템플릿 작업으로 채웁니다. 통과한 초안이 없으면 한 번 다시 쓰게 하고, 그래도 없거나 모델이 없으면 `[템플릿]` 초안을 만듭니다. 템플릿은 AI 출력이라고 표시하지 않습니다.

런타임에는 DB가 없습니다. Rust 호스트(`hub_start`)가 DB에서 입력을 모아 넘기고, 승인 카드(`save_draft`)를 승인하면 호스트(`hub_decide`)가 런타임이 보여 준 바로 그 내용을 저장한 다음 런타임을 이어 갑니다. 화면은 입력이나 저장 내용을 직접 넘길 수 없고, `agent_call`로 이 워크플로를 시작하거나 승인할 수 없습니다. 에이전트 초안은 예약·게시 상태로 저장되지 않습니다.

## 모델 공급자

| 종류 | 공급자 | 인증 |
|---|---|---|
| 구독 CLI | Claude Code, Codex CLI, Gemini CLI, Cursor CLI, Kiro CLI | 각 CLI의 로그인. 빈 임시 폴더에서 도구 없이 텍스트만 생성합니다. |
| API | Anthropic, OpenAI, Google Gemini, OpenRouter | Agent 탭에 저장한 키 (OS 키체인) |
| 로컬 | Ollama | `http://127.0.0.1` 주소만 허용 |

이미지 생성은 OpenAI 또는 Gemini API 키가 필요합니다. 임베딩은 키 없이 쓰는 로컬 해시(이름 기반)부터 OpenAI·Gemini·Ollama까지 고를 수 있습니다.

## 안전 장치

- 경로는 프로젝트 기준 상대 경로만 받습니다. 프로젝트 밖을 가리키는 심볼릭 링크, `.env`·키 파일·`.git`은 읽거나 쓸 수 없습니다.
- 파일 변경은 승인 카드에 diff로 보여 줍니다. 승인 후 파일이 그사이 바뀌었으면(다른 레인이 먼저 고친 경우 포함) 적용하지 않고, 그 Expert가 다시 읽고 고칩니다.
- 명령은 셸 없이 argv로 실행합니다. 빌드·테스트·린트(`pnpm run …`, `cargo test` 등)만 허용하고 설치·게시·`npx`·`make`는 승인해도 실행하지 않습니다. 10분 제한, 로그 200KB 제한.
- 자식 프로세스에는 API 키와 앱 비밀값이 전달되지 않습니다. 로그와 오류에서 키 형태 문자열을 가립니다.
- 한 프로젝트에서 동시에 한 작업만 실행합니다.

주의: `npm run <script>`는 `package.json`에 적힌 스크립트를 실행합니다. 에이전트가 `package.json`을 바꾸는 diff는 특히 확인하세요.

## 사용

1. Agent 탭 → **벡터 DB 실행** (Docker/OrbStack 필요, 처음엔 이미지 다운로드).
2. **모델 설정**에서 에이전트 모델을 고르고 저장합니다. 구독 CLI는 터미널에서 먼저 로그인합니다 (`claude`, `codex login`, `gemini` 등).
3. 프로젝트를 고르고 **코드 색인 만들기**. 이후엔 바뀐 파일만 다시 색인합니다.
4. 작업을 적고 **에이전트 시작**. 승인 카드가 뜨면 diff나 명령을 보고 승인·거절합니다.

작업 기록은 최근 30개까지 저장됩니다. 앱이 꺼질 때 진행 중이던 작업은 이어지지 않으니 다시 시작하세요.

## 개발

```bash
pnpm agent:typecheck   # 런타임 타입 검사
pnpm agent:test        # 그래프·도구·RAG 테스트 (Chroma가 없으면 RAG 실측 테스트는 건너뜀)
pnpm agent:build       # desktop/src-tauri/resources/agent-runtime/agent.mjs 생성
pnpm desktop:dev       # 번들을 만든 뒤 Tauri 개발 실행
node scripts/verify-agent-ui.mjs   # Agent 탭 UI 검증 (IPC 모의)
pnpm agent:mutation       # 동작을 일부러 깨뜨려 테스트가 실패하는지 확인 (런타임·UI 클라이언트)
pnpm agent:mutation:ui    # 같은 확인을 화면 검증 스크립트로 (느림)
pnpm agent:mutation:rust  # Rust 호스트·벡터 DB 구성
```

새 동작은 실패하는 테스트를 먼저 쓰고(`mutants.json`에 그 동작을 깨는 변형도 추가) 실패를 확인한 뒤 구현합니다. 변형이 살아남으면 그 테스트는 동작을 증명하지 못한 것입니다.

설치 파일은 앱에 포함된 Node(Studio 브라우저용)로 런타임을 실행합니다. 없으면 사용자 PATH의 Node 22 이상을 찾습니다.
