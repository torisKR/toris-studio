# Local Voice Runtime

## TTS — Qwen3-TTS MLX

Toris Studio의 기본 한국어 TTS는 Apple Silicon에서 로컬 실행하는 Qwen3-TTS입니다.

기본 모델과 화자:

```text
model   mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit
speaker Sohee
lang    Korean
server  http://127.0.0.1:50010
output  24 kHz PCM WAV
```

설치:

```bash
pnpm tts:setup
```

상주 서버 실행:

```bash
pnpm tts:start
```

Studio의 `POST /api/tts`는 로컬 Qwen3-TTS 서버에 narration을 전달하고, 생성된 WAV와 실제 duration을 저장합니다. UI는 이 duration에 짧은 여유를 더해 장면 길이를 자동 조정합니다.

### Voice style

기본 화자 `Sohee`는 한국어 여성 프리셋입니다. 말투는 `QWEN_TTS_INSTRUCT`로 조절합니다.

```dotenv
QWEN_TTS_BASE_URL=http://127.0.0.1:50010
QWEN_TTS_SPEAKER=Sohee
QWEN_TTS_LANGUAGE=Korean
QWEN_TTS_INSTRUCT=따뜻하고 자연스러운 한국 여성 목소리. 실제 사람이 말하듯 편안하고 부드럽게, 광고처럼 과장하지 말고 문장마다 자연스럽게 호흡하며 또렷하게 말한다.
```

광고, 차분한 설명, 브리핑 등 콘텐츠별로 instruction을 바꾸되 화자 이름과 음성 모델은 유지할 수 있습니다.

### Operational notes

- 첫 실행 시 모델 다운로드가 필요합니다.
- 모델을 매 합성마다 다시 로드하지 않고 FastAPI process가 메모리에 유지합니다.
- 서버는 기본적으로 loopback `127.0.0.1`에만 바인딩합니다.
- 기본 구성은 외부 TTS API를 호출하지 않습니다.

## STT

Mac 기본 STT는 whisper.cpp를 사용할 수 있습니다.

```text
POST http://127.0.0.1:8080/inference
response_format=text
```

`whisper-server --convert`를 사용하므로 FFmpeg가 설치되어 있으면 일반 오디오 입력을 서버가 WAV로 변환할 수 있습니다.

ClubLog 광고 검수처럼 일회성 로컬 QA에는 MLX Whisper도 사용할 수 있습니다.

### Alternate OpenAI-compatible local STT

필요하면 아래처럼 바꿀 수 있습니다.

```dotenv
STT_PROVIDER=openai_compatible
STT_BASE_URL=http://127.0.0.1:9000
STT_MODEL=local
STT_API_KEY=
```

이 경우 Toris Studio는 `POST /v1/audio/transcriptions`를 호출합니다.
