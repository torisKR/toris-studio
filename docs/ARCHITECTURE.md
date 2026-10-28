# Architecture

## Local-first MVP

```text
ChatGPT / MCP client
        |
        v
Toris Studio MCP  :3100
        |
        v
Next.js API       :3000
  |      |       |       |
  |      |       |       +--> YouTube Data API v3
  |      |       |
  |      |       +----------> Remotion renderer -> FFmpeg -> MP4
  |      |
  |      +------------------> Qwen3-TTS MLX :50010
  |
  +-------------------------> whisper.cpp :8080
                    OR MLX Whisper (local CLI)

Persistence
  local .toris-studio/projects.json
       OR
  Supabase Postgres + Storage
```

## Desktop AI video production

```text
React 영상·모션 탭 (desktop/src/production)
        | IPC production_* (input 하나)
        v
Rust production.rs ── job.json (단계별 원자 저장, 캐시 키, 재개·재시도)
  |  plan      -> Node LangGraph "video-production" (스토리보드 데이터만, Zod 검증)
  |  scenes    -> video_runtime.rs -> runtime/wan_t2v_worker.py (Wan2.1 1.3B MLX, 장면 1개씩, 메모리 상한)
  |  voice     -> media::generate_voice -> Qwen3-TTS MLX :50010
  |  subtitles -> 음성 길이 기반 SRT
  |  edit      -> FFmpeg (cover, 앱이 그린 자막 PNG, 페이드, 코드 합성 BGM)
  |  qa        -> ffprobe + blackframe, 실패 단계만 1회 재실행
  v
final.mp4 · subtitles.srt · storyboard.json · metadata.json · provenance.json · edit-project.json
```

장면 생성과 편집기 MP4 출력은 같은 영상 잠금을 씁니다. 장면 생성 중에는 앱이 켠 음성 서버를 멈췄다가 다시 켜고, 앱 밖에서 켠 음성 서버는 그대로 두고 메모리 상한을 낮춥니다. 계약은 [VIDEO_PRODUCTION.md](VIDEO_PRODUCTION.md)를 따릅니다.

## Why local-first

초기 단계에서 가장 먼저 검증해야 하는 것은 결제나 멀티테넌시가 아니라 다음 네 가지입니다.

1. 대본에서 완성 영상까지 걸리는 실제 작업량
2. 반복 제작 가능한 템플릿 품질
3. TTS 품질과 장면 길이 자동화 가능성
4. 사용자에게 돈을 받을 만큼 편집 시간을 줄이는지

그래서 외부 모델 API가 없어도 편집, 한국어 TTS, 렌더를 로컬에서 검증할 수 있도록 구성합니다.

## Voice boundary

기본 한국어 TTS는 Apple Silicon용 Qwen3-TTS MLX 런타임입니다.

- model: mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit
- speaker: Sohee
- language: Korean
- endpoint: 127.0.0.1:50010
- output: 24 kHz PCM WAV

모델은 로컬 FastAPI process에 한 번 로드하고 Next.js는 HTTP로 합성 요청만 전달합니다. 장면마다 Python/model process를 새로 시작하지 않으므로 반복 제작 latency를 줄입니다.

## Render engine boundary

`lib/render/engine.ts`는 렌더러를 교체하기 위한 경계입니다.

현재:
- Remotion: active

후보:
- HyperFrames: HTML/CSS 중심 템플릿과 대량 생성 실험용
- Revideo: timeline/video composition 대안 실험용

세 엔진을 동시에 운영하지 않습니다. 품질/속도/라이선스/운영비 측정 후 필요할 때만 추가합니다.

## SaaS render architecture

MVP의 `POST /api/render`는 요청 안에서 렌더합니다.

실서비스에서는 다음 구조로 교체합니다.

```text
Web
 -> create render job
 -> Postgres queue / queue service
 -> renderer worker
 -> object storage
 -> render status
 -> download / YouTube publish
```

브라우저 요청 timeout과 메모리 경쟁을 피하기 위해 렌더 worker와 TTS worker는 Next.js web process와 분리합니다.

## Billing-ready usage

`usage_events`의 기본 meter:

- render_second
- tts_character
- stt_second
- youtube_upload

처음부터 구독 플랜을 코드에 하드코딩하지 않고 사용량을 기록한 뒤 실제 원가와 사용자 행동을 보고 플랜을 결정합니다.
