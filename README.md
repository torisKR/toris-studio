# Toris Studio

## 데스크톱 시작

설치 프로그램은 [macOS · Windows 다운로드](https://toriskr.github.io/toris-studio/) 또는 [공식 GitHub 릴리스](https://github.com/torisKR/toris-studio/releases/latest)에서 받을 수 있습니다. macOS는 Apple Silicon과 Intel 파일을 구분하고, Windows는 x64 설치 프로그램을 선택하세요. 설치 후 **연결 설정 → 앱 업데이트**에서 새 버전을 확인하고 설치할 수 있습니다. 같은 배포 파일은 개발자용 [GitHub Packages](https://github.com/torisKR?tab=packages)에도 보관합니다.

```bash
pnpm install --frozen-lockfile
pnpm desktop:dev
# 설치 프로그램 생성
pnpm desktop:build
```

앱의 **로컬 설정**에서 OrbStack/Docker PostgreSQL을 준비하고, **SNS 로그인**에서 각 플랫폼의 OAuth 앱 정보를 등록합니다. OAuth 토큰과 저장한 API 키는 macOS Keychain / Windows 자격 증명 관리자에 보관합니다. YouTube 공개 채널·영상 조회와 트렌드 수집은 YouTube Data API 키를 사용합니다. 로컬 AI 작업실은 기존 OpenCodex / teamclaude 또는 로그인한 Claude CLI에 연결합니다.

채널·콘텐츠·발행 계획은 로컬 DB에서 관리합니다. 발행 계획 저장은 SNS 자동 게시 실행을 의미하지 않으며, 각 플랫폼의 게시 권한과 기능은 별도 구현 대상입니다. 기본 브라우저의 로그인 쿠키를 이용하고 OAuth 연결을 갱신합니다. 상세한 실행·검증 범위는 [데스크톱 가이드](docs/DESKTOP.md), 앱 등록과 갱신 제한은 [OAuth 가이드](docs/OAUTH.md)를 참고하세요.

**키워드 탐색**에서 키워드로 수집 콘텐츠를 찾고, 콘텐츠별 실제 검색어와 추출 단어를 확인할 수 있습니다. 선택한 공개 원문은 로컬 Crawl4AI 컨테이너로 수집합니다. 공식 API 범위와 검색 근거·10개 도구의 적용 상태는 [키워드 탐색 설계](docs/KEYWORD_EXPLORER.md)에 정리했습니다. 기존 Opal 탐색은 이 화면으로 교체하며 개인 설정과 과거 DB 기록은 보존합니다.


로컬에서 먼저 직접 쓰고 검증한 뒤 구독형 SaaS로 확장하기 위한 프로그램 기반 영상 제작 스튜디오입니다.

현재 MVP는 **Next.js + Remotion + Qwen3-TTS MLX + whisper.cpp/MLX Whisper + YouTube Data API v3 + MCP + Supabase-ready schema** 조합입니다.

## 구현된 흐름

1. ChatGPT/MCP 또는 Studio UI에서 영상 기획과 대본을 작성
2. 장면별 headline / 화면 설명 / narration / 출처 / 미디어를 편집
3. 같은 프로젝트를 YouTube 16:9, Vertical 9:16, Shorts 9:16으로 전환
4. Remotion Player에서 즉시 미리보기
5. Qwen3-TTS MLX의 한국어 Sohee 음성으로 장면별 자연스러운 로컬 내레이션 생성
6. whisper.cpp 로컬 STT로 음성 파일을 대본으로 변환
7. Remotion + FFmpeg로 H.264/AAC MP4 렌더
8. YouTube Data API v3로 업로드
9. Supabase 연결 전에는 로컬 JSON 저장, 연결 후에는 Supabase 저장

## 기술 선택

### Web / 편집기
- Next.js 16
- React 19
- TypeScript
- Remotion Player

### 렌더
- 기본 엔진: Remotion
- 확장 인터페이스: Remotion / HyperFrames / Revideo
- 현재 실제 구현은 Remotion만 사용

Remotion을 기본으로 선정한 이유는 편집 UI와 렌더 템플릿을 React/TypeScript 하나로 유지할 수 있고, 동적 장면·오디오·애니메이션·미리보기·서버 렌더링 기능이 충분히 성숙했기 때문입니다.

### Voice
- TTS: Qwen3-TTS 1.7B CustomVoice 8-bit + MLX
- 기본 한국어 음성: `Sohee` (따뜻한 한국 여성 음색)
- STT: whisper.cpp 또는 MLX Whisper
- TTS 추론은 Apple Silicon에서 로컬 실행

> 기본 TTS 경로는 클라우드 음성 API를 사용하지 않습니다. 모델을 한 번 내려받은 뒤에는 `127.0.0.1:50010`의 로컬 MLX 런타임에서 합성합니다.

### 저장
- 초기 검증: `.toris-studio/projects.json`
- SaaS 전환: Supabase Postgres + Storage
- 스키마: `supabase/schema.sql`

### 기획/대본
- 별도 OpenAI API 호출 없음
- `npm run mcp` 또는 `npm run mcp:stdio`로 Toris Studio 도구를 노출
- ChatGPT/MCP 클라이언트가 기획·대본을 수행하고 Studio에 프로젝트를 저장

즉, LLM 추론 비용을 Toris Studio 서버가 별도 API 키로 부담하는 구조가 아닙니다.

## Linux 클라우드 제작

Linux 설치·브라우저·한국어 폰트·CLI 렌더·기존 음성 가져오기 절차는 [docs/LINUX.md](docs/LINUX.md)를 참고하세요. DevDay 클라우드 제작본의 출처와 제한은 [docs/DEVDAY2026_CLOUD.md](docs/DEVDAY2026_CLOUD.md)에 기록했습니다. 롱폼은 새 설명 장면의 음성이 없는 편집 검토본입니다.

## 시작

### 1. Node 패키지 설치

```bash
cd /Users/toris/projects/toris_studio
pnpm install
cp .env.example .env.local
```

### 2. 개발 서버

```bash
pnpm dev
```

브라우저:

```text
http://localhost:3000
```

환경변수를 넣지 않아도 영상 기획 편집, Remotion 미리보기, 로컬 프로젝트 저장은 동작하도록 설계되어 있습니다.

## 실제 사용법

가장 단순한 사용 순서는 아래와 같습니다.

1. `pnpm dev`로 Studio를 실행합니다.
2. 브라우저에서 `http://localhost:3000`을 엽니다.
3. 출력 포맷에서 `YouTube 16:9`, `Vertical 9:16`, `YouTube Shorts` 중 하나를 선택합니다.
4. `Reference Briefing` 템플릿을 적용하거나 기존 프로젝트를 불러옵니다.
5. `ChatGPT 기획` 버튼으로 현재 프로젝트용 기획 프롬프트를 복사합니다.
6. ChatGPT에서 대본/장면 JSON을 만든 뒤 `JSON 가져오기`로 Studio에 반영합니다.
7. 각 Scene에서 headline, body, narration, role, layout, sourceUrl을 수정합니다.
8. `이미지 / 영상 업로드`로 실제 제품 화면, 스크린샷, B-roll을 연결합니다.
9. 필요하면 `Qwen3-TTS · Sohee 음성 생성`으로 장면별 한국어 WAV narration을 만듭니다.
10. Preview 아래의 `QUALITY CHECK`에서 Hook, 미디어, 출처, 내레이션 밀도, 길이를 확인합니다.
11. `렌더` 버튼으로 H.264 MP4를 만듭니다.
12. YouTube OAuth가 연결되어 있으면 `YouTube` 버튼으로 비공개 업로드합니다.

### 포맷별 권장 사용

| 포맷 | 해상도 | 권장 용도 |
| --- | --- | --- |
| YouTube 16:9 | 1920×1080 | 제품 설명, 리서치, 3~10분 롱폼 |
| Vertical 9:16 | 1080×1920 | 릴스, 틱톡, 세로형 설명 영상 |
| YouTube Shorts | 1080×1920 | 60초 이하 쇼츠 |

Shorts는 롱폼 장면을 단순히 세로로 바꾸지 않고 전용 60초 이하 구조를 사용합니다.

### 장면 Role과 Layout

`reference-briefing` 템플릿은 장면 의미와 시각 구성을 분리합니다.

| Role | 권장 Layout | 용도 |
| --- | --- | --- |
| hook | hero | 첫 5~8초에 시청 이유 제시 |
| point | split | 핵심 기능/주장 + B-roll |
| proof | media-focus | 공식 화면, 문서, 제품 UI 강조 |
| reaction | reaction-grid | 기대/우려/사용자 반응 정리 |
| cost | split | 가격, 제한, 조건 |
| action | action-card | 사용자가 바로 할 행동 |
| outro | hero | 한 문장 결론 |

### ChatGPT와 MCP로 기획하기

Studio와 함께 MCP 서버를 실행합니다.

```bash
pnpm mcp
```

개발 서버와 MCP가 이미 실행 중이라면 ChatGPT에 다음처럼 요청하면 됩니다.

```text
시니어클럽 앱 홍보용 유튜브 쇼츠를 기획해서
Toris Studio 프로젝트로 저장해줘.
실제 앱 스크린샷을 사용하고 45초 이내로 만들어줘.
```

MCP를 사용할 수 없는 환경에서는 `ChatGPT 기획` → JSON 생성 → `JSON 가져오기` 흐름을 사용합니다.

### Quality Check 기준

Studio는 다음 항목을 자동 검사합니다.

- 첫 장면이 8초 이내 Hook인지
- 여러 Layout을 사용해 화면 반복감이 낮은지
- 실제 이미지/영상/B-roll이 충분히 연결됐는지
- 근거 장면에 `sourceUrl`이 있는지
- narration 분량이 장면 길이에 비해 너무 빠르거나 느리지 않은지
- Hook → 근거 → 반응 → Action 구조가 있는지
- Shorts가 60초를 넘지 않는지

디자인이 예쁘더라도 실제 미디어와 출처가 비어 있으면 Quality 점수가 낮게 나오는 것이 정상입니다.

### 렌더 결과 위치

UI 또는 CLI로 렌더한 파일은 기본적으로 아래에 저장됩니다.

```text
public/renders/
```

CLI 렌더:

```bash
pnpm remotion:render -- youtube-landscape
pnpm remotion:render -- vertical
pnpm remotion:render -- shorts
```

### Qwen3-TTS가 비활성화될 때

Apple Silicon Mac에서 로컬 TTS 런타임과 모델을 한 번 설치합니다.

```bash
pnpm tts:setup
```

그 다음 별도 터미널에서 상주 서버를 실행합니다.

```bash
pnpm tts:start
```

기본 endpoint는 `http://127.0.0.1:50010`이며 Studio의 `/api/health`가 서버 상태를 확인합니다. 기본 한국어 화자는 `Sohee`입니다.

### Remotion/webpack 캐시 오류

의존성 버전을 바꾼 뒤 다음과 같은 로그가 반복될 수 있습니다.

```text
webpack.cache.PackFileCacheStrategy
Restoring failed ... Expected end of object
```

이는 기존 Remotion webpack 캐시와 현재 모듈 그래프가 맞지 않을 때 발생할 수 있습니다. 개발 서버와 Remotion Studio를 종료한 뒤 다음을 실행합니다.

```bash
pnpm remotion:clean
pnpm typecheck
pnpm remotion:studio
```

그래도 지속되면 `node_modules` 전체를 바로 삭제하기 전에 먼저 `pnpm install`로 lockfile과 설치 상태를 맞춘 뒤 다시 `pnpm remotion:clean`을 실행합니다.

## 한국어 TTS: Qwen3-TTS MLX

설치:

```bash
pnpm tts:setup
```

서버:

```bash
pnpm tts:start
```

동작 순서:

```text
장면 narration
  → 로컬 Qwen3-TTS 1.7B CustomVoice 8-bit
  → Sohee 한국어 여성 음성 + 스타일 instruction
  → 24kHz WAV
  → 장면 길이 자동 반영
  → Remotion
```

기본 모델은 `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit`입니다. 모델은 약 3GB이고 Apple Silicon MLX로 실행됩니다. 기본 `Sohee`는 한국어가 native인 따뜻한 여성 음색이며, `.env.local`의 instruction으로 광고·브리핑·차분한 설명 등 말투를 조절합니다.

`.env.local`:

```dotenv
QWEN_TTS_BASE_URL=http://127.0.0.1:50010
QWEN_TTS_SPEAKER=Sohee
QWEN_TTS_LANGUAGE=Korean
QWEN_TTS_INSTRUCT=따뜻하고 자연스러운 한국 여성 목소리. 실제 사람이 말하듯 편안하고 부드럽게, 광고처럼 과장하지 말고 문장마다 자연스럽게 호흡하며 또렷하게 말한다.
```

첫 모델 로딩에는 수 초가 걸리므로 매 장면마다 프로세스를 새로 실행하지 않고 로컬 FastAPI 서버를 상주시킵니다.

## 로컬 STT: whisper.cpp

설치:

```bash
bash scripts/setup-whisper-macos.sh
```

서버:

```bash
bash scripts/start-whisper-macos.sh
```

기본값은 `large-v3-turbo`, localhost:8080, 공식 whisper.cpp `/inference` endpoint입니다.

```dotenv
STT_PROVIDER=whisper_cpp
STT_BASE_URL=http://127.0.0.1:8080
```

## Remotion 테스트

Remotion Studio:

```bash
pnpm remotion:studio
```

샘플 MP4:

```bash
pnpm remotion:render -- youtube-landscape
pnpm remotion:render -- vertical
pnpm remotion:render -- shorts
```

완성 파일은 `public/renders/`에 저장됩니다.

### 현재 제작 완료 예제

OpenAI DevDay 2026 GeekNews 요약을 기반으로 한 자체 제작 쇼츠:

```text
Composition: DevDay2026-Shorts
Output: public/renders/openai-devday-2026-shorts.mp4
Guide: docs/DEVDAY2026_VIDEO.md
```

외부 발표 슬라이드를 복제하지 않고, Dots·Sol/Ultrafast·Codex Cloud·MCP Events·Space/Pages를 설명하는 SVG 에셋을 프로젝트 안에서 직접 제작해 사용합니다.

## ChatGPT / MCP 연결

Next.js 서버를 먼저 실행한 상태에서 MCP bridge를 띄웁니다.

HTTP:

```bash
pnpm mcp
```

endpoint:

```text
http://127.0.0.1:3100/mcp
```

stdio:

```bash
pnpm mcp:stdio
```

현재 제공 도구:

- `studio_list_projects`
- `studio_create_template_project`
- `studio_get_project`
- `studio_save_project`
- `studio_generate_scene_voice`
- `studio_render_project`

ChatGPT에게 영상 주제와 조사 범위를 전달하고 `studio_save_project`를 사용하도록 지시하면, 별도 OpenAI API 호출 없이 대본 결과가 Studio 프로젝트로 들어오는 구조입니다.

ChatGPT에서 현재 full MCP의 쓰기/수정 작업을 사용할 수 있는 범위는 플랜과 워크스페이스에 따라 다릅니다. 또한 ChatGPT는 localhost MCP에 직접 연결하지 않고 원격 MCP를 사용하므로, 개발 머신의 MCP를 ChatGPT에 연결할 때는 지원되는 Secure MCP Tunnel 같은 경로가 필요합니다.

그래서 Toris Studio에는 MCP와 별개로 **ChatGPT 기획 프롬프트 복사 → ChatGPT가 VideoProject JSON 생성 → Studio의 JSON 가져오기** fallback도 넣었습니다. 이 경로는 모델 API 키가 필요 없습니다.

중요: 이 구성은 본인이 ChatGPT를 대화형 기획 도구로 사용하는 개인 검증 워크플로입니다. 향후 Toris Studio를 구독형 SaaS로 판매할 때 고객의 요청을 서버가 사용자의 개인 ChatGPT 구독으로 임의 대행하는 구조로 취급하지 않습니다. 상용화 단계에서는 고객의 ChatGPT 앱/MCP 연결 또는 별도 모델 API 등 정식 서버 추론 경로를 선택해야 합니다.

## YouTube 업로드

Google Cloud에서 YouTube Data API v3를 활성화하고 OAuth Client를 만든 뒤 서버 환경변수를 채웁니다.

```dotenv
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=
YOUTUBE_REFRESH_TOKEN=
```

MVP 업로드 기본값은 `private`입니다. 렌더 완료 후 Studio의 **YouTube** 버튼으로 업로드합니다.

OAuth client secret과 refresh token은 절대 브라우저 코드나 `NEXT_PUBLIC_*` 변수에 넣지 않습니다.

## Supabase

Supabase가 설정되지 않았으면 자동으로 로컬 저장소를 씁니다.

연결 후:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SECRET_KEY=
```

준비된 스키마:

```text
supabase/schema.sql
```

포함 테이블:

- `video_projects`
- `video_renders`
- `usage_events`
- `subscriptions`

Storage bucket:

- `toris-studio-assets` (private)

SaaS 단계에서는 사용자 인증 후 `owner_id` 기반 RLS로 전환합니다. 서버용 secret key는 브라우저에 노출하지 않습니다.

## 현재 템플릿

### `reference-briefing`

리서치·뉴스·제품 발표용입니다. Hook → 핵심 포인트 → 공식 근거 → 반응 → 조건/비용 → Action → Takeaway 구조를 사용합니다.

### `adaptive-promo`

앱·서비스·브랜드 홍보용입니다. 출력 포맷에 따라 장면 구조 자체가 달라집니다.

- **Shorts 9:16**: Hook → Benefit → 실제 Product → Payoff → CTA, 약 40~50초
- **Vertical 9:16**: Hook → Problem → Solution → Feature → Result → CTA → Brand, 약 60~90초
- **YouTube 16:9 Long-form**: Hook → Context → Problem → Solution/Demo → Feature → Proof → 조건/반론 → Action → Takeaway, 약 3~4분 기본 골격

Studio에서 템플릿 버튼을 눌러 적용할 수 있고, MCP에서는 `studio_create_template_project`로 ChatGPT가 포맷에 맞는 골격을 직접 만들 수 있습니다. 장면 내용은 `studio_save_project`로 다시 작성해 서비스별 템플릿처럼 사용할 수 있습니다.

## SaaS 전환 순서

1. 직접 사용하며 템플릿과 렌더 품질 검증
2. Supabase Auth + 프로젝트/에셋 저장 연결
3. 렌더 job queue와 worker 분리
4. 사용량 계측: render second / TTS character / STT second
5. 결제 provider 연결 및 플랜 제한
6. YouTube OAuth를 사용자 계정 단위 암호화 저장
7. 렌더 worker autoscaling
8. 템플릿 marketplace / 예약 업로드 / 채널별 재가공

## Remotion 라이선스 체크

1인 개발자 또는 최대 3인 조직은 현재 Remotion Free License 범위에서 상업적 사용과 자동화/SaaS가 허용됩니다. 조직 규모가 4명 이상이 되면 Remotion의 당시 라이선스 조건을 다시 확인해야 합니다.

## 디렉터리

```text
app/
  api/
components/
lib/
  render/
  storage/
  stt/
  tts/
  video/
  youtube/
mcp/
remotion/
scripts/
supabase/
```
