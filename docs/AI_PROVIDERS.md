# 로컬 AI 연결

Studio의 `/manage`에서 AI 초안을 작성합니다. 생성 결과는 사람이 확인하고 저장하는 초안이며 자동 게시하지 않습니다. 공개 GitHub 저장소에는 로그인 토큰, API 키, 계정 파일을 넣지 않습니다.

## OpenCodex

기본 연결은 이미 실행 중인 `http://127.0.0.1:10100/v1`입니다. 대시보드 주소 `http://localhost:10100/#dashboard`를 API 주소로 넣지 마세요. 서버는 `/models`를 조회하고, 생성 시 `/chat/completions`에 도구 없는 텍스트 요청을 보냅니다.

```dotenv
AI_DEFAULT_PROVIDER=opencodex
OPENCODEX_BASE_URL=http://127.0.0.1:10100/v1
OPENCODEX_MODEL=gpt-6.1-sol
OPENCODEX_ALLOWED_MODELS=gpt-6.1-sol
# 게이트웨이가 접근 키를 요구하는 경우에만 서버의 .env.local에 설정
# OPENCODEX_API_KEY=
AI_TIMEOUT_MS=75000
```

기본 허용 모델은 하나입니다. OpenCodex 전체 목록에 표시되는 Cursor, Google, 유료 API 등의 모델을 Studio가 자동 사용하지 않습니다. 추가 모델은 운영자가 게이트웨이 계정과 청구 경로를 확인한 후 `OPENCODEX_ALLOWED_MODELS`에 명시합니다. 실패 시 Studio는 다른 모델, 계정 또는 유료 API로 재시도하지 않습니다. 게이트웨이 자체의 라우팅·백업 설정은 OpenCodex에서 확인해야 합니다.

2026-10-08 로컬 검사에서 기존 OpenCodex `/v1/models`가 응답했고, `gpt-6.1-sol`의 도구 없는 짧은 생성 요청이 `TORIS_AI_OK`를 반환했습니다. 이 검사는 다른 모델이나 Claude 구독의 인증 증거가 아닙니다. 앱 상태는 실행 중인 서버에서 성공한 생성만 기록하므로 서버 재시작 후 생성 확인 상태가 초기화됩니다.

`configured`는 서버 설정 존재, `reachable`은 게이트웨이 응답, `available`은 허용 모델 목록 확인, `authenticated`는 인증 확인 결과, `generationVerified`는 이 서버에서 실제 생성 성공입니다. 모델 목록 조회 성공만으로 upstream 구독 로그인을 확인했다고 표시하지 않습니다. API 키와 호스트 주소는 상태 응답에 포함하지 않습니다.

## Claude 구독과 공식 CLI

일반 OpenAI/Claude API 키와 ChatGPT/Claude 구독은 별도 인증 경로입니다. Studio가 임의 OAuth 클라이언트를 만들거나 공식 CLI의 계정 토큰을 읽어서 외부 API에 보내지 않습니다. ChatGPT 구독은 [공식 Codex 인증](https://developers.openai.com/codex/auth), Claude 구독은 [공식 Claude Code 인증](https://code.claude.com/docs/en/authentication)을 통해 사용합니다.

OpenCodex의 `cursor/claude-*` 모델은 Cursor 경로입니다. Claude 계정 구독으로 직접 사용했다고 표시하지 않습니다. 공식 Claude Code CLI는 선택 설정입니다.

```dotenv
CLAUDE_CLI_ENABLED=true
CLAUDE_CLI_PATH=/Users/your-user/.local/bin/claude
CLAUDE_CLI_MODEL=sonnet
# Claude CLI를 기본으로 선택하려면:
# AI_DEFAULT_PROVIDER=claude-cli
```

운영자가 터미널에서 `claude auth status`로 공식 구독 로그인을 먼저 확인합니다. 필요한 로그인은 공식 `claude auth login` 또는 CLI의 `/login`에서 사람이 수행합니다. Studio는 로그인, 로그아웃, 키체인 변경을 자동 실행하지 않습니다. 로그인되어 있지 않으면 생성 요청을 차단합니다.

Claude 실행은 `shell: false`, 별도 임시 작업 폴더, `--safe-mode`, `--restricted`, 빈 `--tools`, 빈 MCP 설정과 `--strict-mcp-config`, `--disable-slash-commands`, 빈 `--setting-sources`, `--permission-mode dontAsk`, `--no-session-persistence`를 사용합니다. 입력은 표준 입력으로 보내며 쉘 명령에 넣지 않습니다. 모델 도구를 통해 프로젝트 파일을 읽거나 수정할 수 없습니다. 자식 프로세스에는 API 키·Bedrock·Vertex·proxy 환경을 전달하지 않아 구독에서 유료 API로 변경되지 않도록 합니다. 관리자가 설치한 공식 CLI 자체의 인증 갱신·진단 동작은 CLI가 관리합니다.

설치된 CLI가 이 옵션을 지원하지 않으면 실행 실패로 표시합니다. 안전 옵션을 제거하거나 위험한 권한 우회로 자동 복구하지 않습니다. 공식 Codex CLI는 이번 통합에서 실행하지 않습니다. 현재 버전에서 모든 파일·셸 도구를 확실히 제거하는 인터페이스를 확인하지 못했기 때문입니다.

## TeamClaude

현재 이 컴퓨터에서 `teamclaude` 실행 파일이나 확인 가능한 전용 API 계약을 발견하지 못했습니다. TeamClaude가 OpenAI 호환 로컬 게이트웨이를 제공한다면 다음 서버 설정으로 연결합니다. 전용 프로토콜이 다른 경우 이 설정만으로 지원된다고 볼 수 없습니다.

```dotenv
TEAMCLAUDE_BASE_URL=http://127.0.0.1:YOUR_PORT/v1
TEAMCLAUDE_MODEL=YOUR_EXISTING_MODEL
TEAMCLAUDE_ALLOWED_MODELS=YOUR_EXISTING_MODEL
# TEAMCLAUDE_API_KEY=
```

기본 상태는 미설정입니다. Studio는 TeamClaude 프로세스나 로그인 설정을 임의로 만들지 않습니다.

## Orb 컨테이너

Next.js를 macOS 호스트에서 실행하고 DB만 Orb에 두면 기본 OpenCodex 주소 그대로 사용합니다. Studio 서버까지 컨테이너에 둘 경우 `127.0.0.1`은 해당 컨테이너를 의미합니다. 기존 OpenCodex를 호스트에서 사용할 때는 명시적으로 아래 설정을 사용합니다.

```dotenv
AI_ALLOW_CONTAINER_HOST=true
OPENCODEX_BASE_URL=http://host.docker.internal:10100/v1
```

허용되는 컨테이너 호스트 이름은 `host.docker.internal`, `host.orb.internal`입니다. 외부 호스트, URL 사용자 정보, 쿼리, 해시, 리다이렉트는 차단합니다. OpenCodex가 호스트 loopback에만 바인딩되어 있으면 컨테이너에서 접근되지 않을 수 있습니다. 그 경우 Studio는 호스트에서 실행하고 DB 컨테이너를 이용하세요. 기존 OpenCodex 바인딩이나 접근 키를 Studio가 변경하지 않습니다.

## API와 제한

- `GET /api/ai/status`: 비밀 정보 없는 제공자 상태와 `defaultProvider`.
- `POST /api/ai/generate`: `{provider?, platform, topic, context?, model?}` → `{text, provider, model}`.
- 플랫폼: `youtube`, `threads`, `naver_blog`, `tiktok`, `instagram`.
- 주제 600자, 참고자료 6000자, JSON 본문 24 KiB, 수신 5초, 출력 40,000자 제한.
- 생성 분당 5회, 동시에 2회, 요청 timeout 최대 90초. 로컬 단일 프로세스 기준입니다.
- 로컬 Host·Origin 검사를 먼저 수행합니다. 공개 서버나 다중 사용자 인증을 대신하지 않습니다.
- 오류는 제한된 코드와 한국어 안내만 반환하며 upstream 원문, 토큰, CLI stderr를 노출하지 않습니다.
- 프롬프트는 출처와 실시간 인기 순위를 꾸며내지 않도록 요구하며 개인정보 추측과 집단 편견을 피하도록 안내합니다. 실제 게시 전 사람의 사실·표현 검토가 필요합니다.

검증: `pnpm exec tsx --test tests/ai-*.test.ts`. 인증/요청 제한/리다이렉트 차단/허용 모델/도구 없는 CLI 인자/입력 크기/다섯 플랫폼 계약을 mock provider로 검증합니다. 실제 구독 생성 검사는 사람의 기존 로컬 계정과 실행 중인 게이트웨이에 의존하며 mock 테스트와 별개입니다.
