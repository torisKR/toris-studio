import io
import os
import threading

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from mlx_audio.tts.utils import load_model

MODEL_DIR = os.environ.get(
    "QWEN_TTS_MODEL_DIR",
    os.path.expanduser("~/.local/share/toris-studio/qwen3-tts-mlx/model"),
)
DEFAULT_SPEAKER = os.environ.get("QWEN_TTS_SPEAKER", "Sohee")
DEFAULT_LANGUAGE = os.environ.get("QWEN_TTS_LANGUAGE", "Korean")
DEFAULT_INSTRUCT = os.environ.get(
    "QWEN_TTS_INSTRUCT",
    "따뜻하고 자연스러운 한국 여성 목소리. 실제 사람이 말하듯 편안하고 부드럽게, "
    "광고처럼 과장하지 말고 문장마다 자연스럽게 호흡하며 또렷하게 말한다.",
)

app = FastAPI(title="Toris Studio Qwen3-TTS MLX Runtime")
model = load_model(MODEL_DIR)
if not callable(getattr(model, "generate_custom_voice", None)):
    raise RuntimeError("The selected model does not support Qwen3-TTS CustomVoice.")
if getattr(model, "tokenizer", None) is None:
    raise RuntimeError(f"Qwen3-TTS text tokenizer failed to load: {MODEL_DIR}")
if getattr(model, "speech_tokenizer", None) is None:
    raise RuntimeError(
        f"Qwen3-TTS speech tokenizer failed to load: {MODEL_DIR}/speech_tokenizer. "
        "Complete the speech_tokenizer files from the same model repository."
    )
sample_rate = int(getattr(model, "sample_rate", 24000))
generation_lock = threading.Lock()


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    speaker: str = DEFAULT_SPEAKER
    language: str = DEFAULT_LANGUAGE
    instruct: str = DEFAULT_INSTRUCT
    temperature: float = Field(default=0.85, ge=0.1, le=1.5)
    top_p: float = Field(default=0.95, ge=0.1, le=1.0)
    top_k: int = Field(default=50, ge=1, le=200)
    repetition_penalty: float = Field(default=1.05, ge=0.8, le=2.0)
    max_tokens: int = Field(default=4096, ge=128, le=8192)


@app.get("/health")
def health():
    return {
        "ok": True,
        "provider": "qwen3-tts-mlx",
        "model": os.path.basename(MODEL_DIR.rstrip("/")),
        "model_path": os.path.realpath(MODEL_DIR),
        "pid": os.getpid(),
        "speaker": DEFAULT_SPEAKER,
        "language": DEFAULT_LANGUAGE,
        "sample_rate": sample_rate,
        "backend": "mlx",
    }


@app.post("/synthesize")
def synthesize(request: SynthesisRequest):
    try:
        with generation_lock:
            results = list(
                model.generate_custom_voice(
                    text=request.text.strip(),
                    speaker=request.speaker,
                    language=request.language,
                    instruct=request.instruct.strip() or None,
                    temperature=request.temperature,
                    max_tokens=request.max_tokens,
                    top_k=request.top_k,
                    top_p=request.top_p,
                    repetition_penalty=request.repetition_penalty,
                    verbose=False,
                )
            )

        if not results:
            raise RuntimeError("Qwen3-TTS returned no audio.")

        chunks = [np.asarray(item.audio, dtype=np.float32).reshape(-1) for item in results]
        audio = np.concatenate(chunks)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 1.0:
            audio = audio / peak

        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        duration = len(audio) / sample_rate

        return Response(
            content=buffer.getvalue(),
            media_type="audio/wav",
            headers={
                "X-TTS-Provider": "qwen3-tts-mlx",
                "X-TTS-Speaker": request.speaker,
                "X-Sample-Rate": str(sample_rate),
                "X-Duration-Seconds": f"{duration:.6f}",
            },
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
