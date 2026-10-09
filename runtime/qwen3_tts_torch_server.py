"""Local Linux Qwen3-TTS adapter. Model files must be downloaded explicitly."""
import io
import os
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from qwen_tts import Qwen3TTSModel

MODEL_DIR = os.environ.get("QWEN_TTS_MODEL_DIR", "local-voice/qwen3-tts-model")
if not Path(MODEL_DIR, "config.json").is_file():
    raise RuntimeError("Download Qwen3-TTS CustomVoice into QWEN_TTS_MODEL_DIR first. No automatic model download is performed.")
device = os.environ.get("QWEN_TTS_DEVICE", "cpu")
torch.set_num_threads(int(os.environ.get("QWEN_TTS_THREADS", "2")))
model = Qwen3TTSModel.from_pretrained(
    MODEL_DIR, device_map=device,
    dtype=torch.float32 if device == "cpu" else torch.bfloat16,
    attn_implementation="eager",
    local_files_only=True,
)
app = FastAPI(title="Toris Studio Qwen3-TTS PyTorch Runtime")
lock = threading.Lock()


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    speaker: str = "Sohee"
    language: str = "Korean"
    instruct: str = ""
    temperature: float = Field(default=0.85, ge=0.1, le=1.5)
    top_p: float = Field(default=0.95, ge=0.1, le=1.0)
    top_k: int = Field(default=50, ge=1, le=200)
    repetition_penalty: float = Field(default=1.05, ge=0.8, le=2.0)
    max_tokens: int = Field(default=2048, ge=128, le=4096)


@app.get("/health")
def health():
    return {"ok": True, "provider": "qwen3-tts-torch", "backend": device,
            "model": Path(MODEL_DIR).name, "speaker": "Sohee", "language": "Korean"}


@app.post("/synthesize")
def synthesize(request: SynthesisRequest):
    try:
        with lock, torch.inference_mode():
            # 0.6B CustomVoice supports preset voices but not instruction control.
            kwargs = dict(text=request.text, language=request.language,
                          speaker=request.speaker, temperature=request.temperature,
                          top_p=request.top_p, top_k=request.top_k,
                          repetition_penalty=request.repetition_penalty,
                          max_new_tokens=request.max_tokens)
            if os.environ.get("QWEN_TTS_STYLE_CONTROL") == "1":
                kwargs["instruct"] = request.instruct
            wavs, sample_rate = model.generate_custom_voice(**kwargs)
        audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
        if not audio.size or not np.isfinite(audio).all():
            raise ValueError("Model returned empty or invalid audio")
        peak = float(np.max(np.abs(audio)))
        if peak > 1:
            audio /= peak
        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        return Response(buffer.getvalue(), media_type="audio/wav", headers={
            "X-TTS-Provider": "qwen3-tts-torch", "X-TTS-Speaker": request.speaker,
            "X-Sample-Rate": str(sample_rate),
            "X-Duration-Seconds": str(len(audio) / sample_rate),
        })
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
