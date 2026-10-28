import io
import os
import sys
import threading

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from mlx_audio.tts.utils import load_model

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import narration  # noqa: E402  (sibling module, works for runpy and uvicorn --app-dir)

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
LICENSE = {
    "model": "Qwen3-TTS-12Hz-1.7B-CustomVoice (Apache-2.0)",
    "runtime": "mlx-audio, mlx (MIT) · FastAPI (MIT) · uvicorn (BSD-3-Clause)",
    "commercialUse": True,
}


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


class NarrationRequest(BaseModel):
    """MLX-Narration style script: [톤] [화자] [쉼:ms] tags and **강조** markup."""
    script: str = Field(min_length=1, max_length=8000)
    speaker: str = DEFAULT_SPEAKER
    language: str = DEFAULT_LANGUAGE
    style: str = "natural"
    emphasis: str = "normal"
    quality: str = "stable"
    pause_ms: int = Field(default=300, ge=0, le=narration.MAX_PAUSE_MS)
    extra: str = Field(default="", max_length=350)
    max_tokens: int = Field(default=4096, ge=128, le=8192)

    @field_validator("speaker")
    @classmethod
    def known_speaker(cls, value):
        if value not in narration.SPEAKERS:
            raise ValueError("unknown speaker")
        return value

    @field_validator("style")
    @classmethod
    def known_style(cls, value):
        if value not in narration.STYLES:
            raise ValueError("unknown style")
        return value

    @field_validator("emphasis")
    @classmethod
    def known_emphasis(cls, value):
        if value not in narration.EMPHASIS:
            raise ValueError("unknown emphasis")
        return value

    @field_validator("quality")
    @classmethod
    def known_quality(cls, value):
        if value not in narration.QUALITY:
            raise ValueError("unknown quality")
        return value


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
        "narration": narration.VERSION,
        "speakers": list(narration.SPEAKERS),
        "styles": list(narration.STYLES),
        "license": LICENSE,
    }


def _audio(results):
    chunks = [np.asarray(item.audio, dtype=np.float32).reshape(-1) for item in results]
    chunks = [chunk for chunk in chunks if chunk.size]
    if not chunks:
        raise RuntimeError("Qwen3-TTS returned no audio.")
    audio = np.concatenate(chunks)
    if not np.isfinite(audio).all():
        raise RuntimeError("Qwen3-TTS returned non-finite samples.")
    return audio


def _wav_response(audio, speaker, extra_headers=None):
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.98:
        audio = audio * (0.98 / peak)
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    duration = len(audio) / sample_rate
    return Response(
        content=buffer.getvalue(),
        media_type="audio/wav",
        headers={
            "X-TTS-Provider": "qwen3-tts-mlx",
            "X-TTS-Speaker": speaker,
            "X-Sample-Rate": str(sample_rate),
            "X-Duration-Seconds": f"{duration:.6f}",
            **(extra_headers or {}),
        },
    )


@app.post("/narrate")
def narrate(request: NarrationRequest):
    try:
        segments = narration.parse(request.script, request.speaker, request.style, request.pause_ms)
        params = narration.sampling(request.quality)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    try:
        pieces = []
        with generation_lock:
            for index, segment in enumerate(segments):
                pieces.append(_audio(model.generate_custom_voice(
                    text=segment.text,
                    speaker=segment.speaker,
                    language=request.language,
                    instruct=narration.instruction(segment, request.emphasis, request.extra),
                    max_tokens=request.max_tokens,
                    verbose=False,
                    **params,
                )))
                if index + 1 < len(segments) and segment.pause_ms:
                    pieces.append(np.zeros(round(sample_rate * segment.pause_ms / 1000), dtype=np.float32))
        return _wav_response(np.concatenate(pieces), request.speaker, {"X-Narration-Segments": str(len(segments))})
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


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
        return _wav_response(_audio(results), request.speaker)
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
