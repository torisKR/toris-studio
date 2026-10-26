# Agent 탭 · 멀티 에이전트 개발 환경

`~/projects`의 프로젝트를 골라 작업을 지시하면 LangGraph 그래프의 Supervisor가 Frontend 또는 Backend Expert에게 배정합니다. Expert가 코드를 바꾸면 QA Reviewer가 빌드·테스트로 확인하고, 실패하면 Expert에게 돌려보냅니다. 파일 쓰기와 명령 실행은 **매번 사용자 승인 후**에만 일어납니다.

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
│ graph/   LangGraph StateGraph + MemorySaver + interrupt()     │
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
START → supervisor ─▶ worker(frontend|backend) ─┬─▶ approval ─▶ worker
                          ▲                     ├─▶ qa ─▶ approval ─▶ qa_review
                          │                     └─▶ finalize ─▶ END
                          └──── qa_review(fail, 최대 2회 반려) ◀┘
```

| 노드 | 하는 일 |
|---|---|
| supervisor | 프로젝트 스택·scripts·벡터 검색 결과를 보고 담당 워커, 계획, 검증 명령을 고릅니다. |
| worker | `list_dir`·`read_file`·`search_code`·`grep`은 바로 실행합니다. `edit_file`·`write_file`·`run_command`는 승인 대기로 넘깁니다. |
| approval | `interrupt()`로 멈추고 UI의 승인/거절을 받습니다. 거절 의견은 워커에게 전달됩니다. |
| qa / qa_review | 검증 명령을 승인받아 실행하고, diff와 로그로 통과·반려를 정합니다. |
| finalize | 결과 요약과 바뀐 파일 목록을 남깁니다. |

모델 출력은 매 단계 JSON 액션 하나입니다. 그래서 도구 호출을 지원하지 않는 구독 CLI도 같은 그래프를 씁니다.

## 모델 공급자

| 종류 | 공급자 | 인증 |
|---|---|---|
| 구독 CLI | Claude Code, Codex CLI, Gemini CLI, Cursor CLI, Kiro CLI | 각 CLI의 로그인. 빈 임시 폴더에서 도구 없이 텍스트만 생성합니다. |
| API | Anthropic, OpenAI, Google Gemini, OpenRouter | Agent 탭에 저장한 키 (OS 키체인) |
| 로컬 | Ollama | `http://127.0.0.1` 주소만 허용 |

이미지 생성은 OpenAI 또는 Gemini API 키가 필요합니다. 임베딩은 키 없이 쓰는 로컬 해시(이름 기반)부터 OpenAI·Gemini·Ollama까지 고를 수 있습니다.

## 안전 장치

- 경로는 프로젝트 기준 상대 경로만 받습니다. 프로젝트 밖을 가리키는 심볼릭 링크, `.env`·키 파일·`.git`은 읽거나 쓸 수 없습니다.
- 파일 변경은 승인 카드에 diff로 보여 줍니다. 승인 후 파일이 그사이 바뀌었으면 적용하지 않습니다.
- 명령은 셸 없이 argv로 실행합니다. 빌드·테스트·린트(`pnpm run …`, `cargo test` 등)만 허용하고 설치·게시·`npx`·`make`는 승인해도 실행하지 않습니다. 10분 제한, 로그 200KB 제한.
- 자식 프로세스에는 API 키와 앱 비밀값이 전달되지 않습니다. 로그와 오류에서 키 형태 문자열을 가립니다.
- 한 프로젝트에서 동시에 한 작업만 실행합니다.

주의: `npm run <script>`는 `package.json`에 적힌 스크립트를 실행합니다. 에이전트가 `package.json`을 바꾸는 diff는 특히 확인하세요.

## 사용

1. Agent 탭 → **벡터 DB 실행** (Docker/OrbStack 필요, 처음엔 이미지 다운로드).
2. **모델 설정**에서 에이전트 모델을 고르고 저장합니다. 구독 CLI는 터미널에서 먼저 로그인합니다 (`claude`, `codex login`, `gemini` 등).
3. 프로젝트를 고르고 **코드 색인 만들기**. 이후엔 바뀐 파일만 다시 색인합니다.
4. 작업을 적고 **에이전트 시작**. 승인 카드가 뜨면 diff나 명령을 보고 승인·거절합니다.

진행 중인 작업 기록은 런타임 메모리에만 있습니다. 앱이나 런타임이 다시 시작되면 사라집니다.

## 개발

```bash
pnpm agent:typecheck   # 런타임 타입 검사
pnpm agent:test        # 그래프·도구·RAG 테스트 (Chroma가 없으면 RAG 실측 테스트는 건너뜀)
pnpm agent:build       # desktop/src-tauri/resources/agent-runtime/agent.mjs 생성
pnpm desktop:dev       # 번들을 만든 뒤 Tauri 개발 실행
node scripts/verify-agent-ui.mjs   # Agent 탭 UI 검증 (IPC 모의)
```

설치 파일은 앱에 포함된 Node(Studio 브라우저용)로 런타임을 실행합니다. 없으면 사용자 PATH의 Node 22 이상을 찾습니다.
