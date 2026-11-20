# AI 모델 연결

데스크톱 앱의 AI 기능(문구, 영상 스토리보드, 주간 콘텐츠, 운영 점검, 코드 에이전트, 앱·게임 팩토리, 이미지 생성)은 모두 **Agent 탭의 모델 설정**을 씁니다. 공급자 목록, 자동 지정, 로그인 버튼은 [Agent 안내](AGENT.md#모델-공급자)에 있습니다.

## 요약

| 방식 | 필요한 것 | 비고 |
|---|---|---|
| 구독 CLI (Claude Code·Codex·Gemini·Cursor·Kiro) | 그 CLI에 사용자가 직접 로그인 | 모델이 비어 있으면 앱이 로그인된 CLI를 자동으로 지정합니다. 각 사용자는 자기 구독으로 돌립니다. |
| API (Anthropic·OpenAI·Gemini·OpenRouter) | API 키 | OS 키체인 `kr.toris.studio.agent.v1`에만 저장합니다. |
| 로컬 (Ollama) | `http://127.0.0.1` 의 Ollama | |
| 이미지 생성 | OpenAI 또는 Gemini API 키 | 구독 CLI로는 만들 수 없습니다. |

모델이 없으면 AI를 쓰는 워크플로는 `[템플릿]`으로 표시한 초안을 만들고 AI 출력이라고 표시하지 않습니다.

## 구독 계정 사용 원칙

- 구독 계정은 공식 CLI를 통해서만 씁니다. 앱은 CLI의 토큰 파일을 읽거나 옮기지 않고, 로그인·로그아웃을 대신하지 않습니다. 로그인 버튼은 시스템 터미널에서 그 CLI의 공식 로그인 명령을 열 뿐입니다.
- CLI는 빈 임시 폴더에서 도구 없이 텍스트만 생성하도록 실행합니다(`desktop/agent-runtime/src/llm/cli.ts`). API 키·프록시 환경은 자식 프로세스에 넘기지 않아 구독이 유료 API로 바뀌지 않습니다.
- 공식 인증 안내: [Claude Code 인증](https://code.claude.com/docs/en/authentication), [Codex 인증](https://developers.openai.com/codex/auth), [Gemini CLI 인증](https://geminicli.com/docs/get-started/authentication/). Anthropic의 [법률·규정 안내](https://code.claude.com/docs/en/legal-and-compliance)는 사용자가 자기 구독으로 수정하지 않은 Claude Code에 로그인하는 것을 허용하고, 제3자 개발자가 사용자 대신 구독 자격으로 요청을 보내는 것은 금지합니다. Toris Studio는 각 사용자 기기의 CLI를 그 사용자의 로그인으로만 실행합니다.

## 예전 웹 서버 설정 (데스크톱에서는 쓰지 않음)

예전 Next.js 서버(`/manage`)는 OpenCodex(`OPENCODEX_*`), TeamClaude(`TEAMCLAUDE_*`), `CLAUDE_CLI_*` 환경 변수로 모델을 골랐습니다. 데스크톱 앱은 이 값을 읽지 않습니다(`desktop/src-tauri/src/config.rs`에는 예전 설정 파일을 읽기 위한 필드만 남아 있고 사용하지 않습니다). 데스크톱에서 OpenCodex·TeamClaude를 설정할 화면이나 경로는 없습니다.

서버 쪽 계약(상태 `GET /api/ai/status`, 생성 `POST /api/ai/generate`, 요청 제한)은 `lib/ai/**`와 `tests/ai-*.test.ts`에 있습니다.

```bash
pnpm exec tsx --test tests/ai-*.test.ts
```
