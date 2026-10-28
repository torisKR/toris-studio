"""Toris Studio Wan2.1 text-to-video worker (MLX, Apple Silicon).

One process renders one scene and exits, so model memory is always returned to the OS.
Inputs are closed choices and bounded numbers given as JSON on stdin; nothing from a
model reaches a shell, path or filter. Progress is one JSON object per stdout line.

Code: ml-explore/mlx-examples video/wan2.1 (MIT), pinned by the host.
Weights: Wan-AI/Wan2.1-T2V-1.3B (Apache-2.0), loaded from a verified local snapshot.
"""
from __future__ import annotations

import json
import os
import signal
import sys
import time

SIZES = {"832x480": (832, 480), "480x832": (480, 832), "640x368": (640, 368), "368x640": (368, 640), "480x480": (480, 480)}
MAX_PROMPT = 1200
MAX_FRAMES = 81
MIN_FRAMES = 17
FPS = 16


def emit(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse(raw: dict) -> dict:
    """Validate the job. Anything outside the closed set is rejected before MLX loads."""
    allowed = {"prompt", "negativePrompt", "size", "frames", "steps", "guidance", "shift", "seed", "quantize", "teacache", "output", "snapshot", "memoryLimitGb"}
    extra = set(raw) - allowed
    if extra:
        raise ValueError("unknown fields: " + ", ".join(sorted(extra)))
    prompt = str(raw.get("prompt", "")).strip()
    if not prompt or len(prompt) > MAX_PROMPT or any(ord(c) < 32 and c not in "\n\t" for c in prompt):
        raise ValueError("prompt must be 1-1200 printable characters")
    negative = str(raw.get("negativePrompt", "Text, watermarks, blurry image, JPEG artifacts")).strip()[:400]
    size = raw.get("size", "832x480")
    if size not in SIZES:
        raise ValueError("size must be one of " + ", ".join(SIZES))
    frames = int(raw.get("frames", 49))
    if not MIN_FRAMES <= frames <= MAX_FRAMES or (frames - 1) % 4:
        raise ValueError("frames must be 17-81 and 4n+1")
    steps = int(raw.get("steps", 30))
    if not 4 <= steps <= 50:
        raise ValueError("steps must be 4-50")
    guidance = float(raw.get("guidance", 5.0))
    shift = float(raw.get("shift", 5.0))
    if not 1.0 <= guidance <= 10.0 or not 1.0 <= shift <= 10.0:
        raise ValueError("guidance and shift must be 1-10")
    seed = int(raw.get("seed", 0))
    if not 0 <= seed < 2**31:
        raise ValueError("seed out of range")
    quantize = int(raw.get("quantize", 0))
    if quantize not in (0, 4, 8):
        raise ValueError("quantize must be 0, 4 or 8")
    teacache = float(raw.get("teacache", 0.0))
    if not 0.0 <= teacache <= 0.1:
        raise ValueError("teacache must be 0-0.1")
    output = str(raw.get("output", ""))
    snapshot = str(raw.get("snapshot", ""))
    if not os.path.isabs(output) or not output.endswith(".mp4") or not os.path.isdir(os.path.dirname(output)):
        raise ValueError("output must be an absolute .mp4 path in an existing folder")
    if not os.path.isabs(snapshot) or not os.path.isdir(snapshot):
        raise ValueError("snapshot must be an existing absolute folder")
    limit = float(raw.get("memoryLimitGb", 18))
    if not 4 <= limit <= 22:
        raise ValueError("memoryLimitGb must be 4-22")
    return {"prompt": prompt, "negative": negative, "size": SIZES[size], "frames": frames, "steps": steps, "guidance": guidance,
            "shift": shift, "seed": seed, "quantize": quantize, "teacache": teacache, "output": output, "snapshot": snapshot, "limit": limit}


def run(job: dict) -> None:
    # The pinned snapshot is the only weight source: no Hub access during inference.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["WAN_T2V_1_3B"] = os.path.join(job["snapshot"], "diffusion_pytorch_model.safetensors")
    import mlx.core as mx
    import mlx.nn as nn
    from wan import utils as wan_utils
    from wan import WanPipeline
    from wan.utils import save_video

    def local(_repo: str, filename: str) -> str:
        # The bf16 safetensors copy loads as bf16; Apple's .pth path would inflate it to float32 (~23GB).
        if filename == "models_t5_umt5-xxl-enc-bf16.pth":
            converted = os.path.join(job["snapshot"], "models_t5_umt5-xxl-enc-bf16.safetensors")
            if os.path.isfile(converted):
                return converted
        path = os.path.join(job["snapshot"], filename)
        if not os.path.isfile(path):
            raise FileNotFoundError("missing model file: " + filename)
        return path

    wan_utils._hf_download = local
    mx.set_default_device(mx.gpu)
    mx.set_cache_limit(0)
    limit = int(job["limit"] * 1024**3)
    mx.set_memory_limit(limit)
    started = time.monotonic()
    peaks: dict[str, float] = {}

    def check(stage: str) -> None:
        peak = mx.get_peak_memory() / 1024**3
        peaks[stage] = round(peak, 3)
        if peak * 1024**3 > limit:
            raise MemoryError(f"{stage} used {peak:.1f}GB, over the {job['limit']:.0f}GB limit")
        mx.reset_peak_memory()

    emit("stage", stage="load")
    pipeline = WanPipeline("t2v-1.3B")
    if job["quantize"]:
        nn.quantize(pipeline.flow, bits=job["quantize"])
    latents = pipeline.generate_latents(job["prompt"], negative_prompt=job["negative"], size=job["size"], frame_num=job["frames"],
                                        num_steps=job["steps"], guidance=job["guidance"], shift=job["shift"], seed=job["seed"], teacache=job["teacache"])
    emit("stage", stage="encode")
    mx.eval(next(latents))
    check("encode")
    del pipeline.t5
    mx.clear_cache()
    emit("stage", stage="denoise", total=job["steps"])
    x_t = None
    for index, x_t in enumerate(latents, start=1):
        mx.eval(x_t)
        emit("step", done=index, total=job["steps"], seconds=round(time.monotonic() - started, 1))
    check("denoise")
    del pipeline.flow
    mx.clear_cache()
    emit("stage", stage="decode")
    video = pipeline.decode(x_t)
    mx.eval(video)
    check("decode")
    if not save_video(video, job["output"], fps=FPS):
        raise RuntimeError("could not encode the generated frames")
    emit("done", output=job["output"], fps=FPS, frames=job["frames"], width=job["size"][0], height=job["size"][1],
         seconds=round(time.monotonic() - started, 1), peakMemoryGb=peaks)


def main() -> int:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        job = parse(json.loads(sys.stdin.read(64 * 1024) or "{}"))
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        emit("error", kind="invalid", message=str(error))
        return 2
    try:
        run(job)
        return 0
    except MemoryError as error:
        emit("error", kind="memory", message=str(error))
    except FileNotFoundError as error:
        emit("error", kind="model-missing", message=str(error))
    except Exception as error:  # noqa: BLE001 - reported to the host as one line
        message = str(error)
        emit("error", kind="memory" if "memory" in message.lower() or "metal" in message.lower() else "failed", message=message[:600])
    return 1


if __name__ == "__main__":
    sys.exit(main())

