# Linux cloud production

Validated on 2026-10-01: x86_64 Debian, Node 24.19.0, pnpm 11.19.0, system Chromium 151, FFmpeg, Noto Sans CJK KR. Base commit `ae3d38db6fe512b947e4bf611817efaa10d763ed`.

## Install and run

Use a separate toris-studio checkout. No Mac home directory, credentials, or voice service is required for editing and rendering. On a fresh Debian/Ubuntu image, provision Chromium, FFmpeg, fontconfig and `fonts-noto-cjk` through the image's normal package installation process. Setup below checks these dependencies without changing system permissions.

```bash
bash scripts/setup-linux.sh
export REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
export REMOTION_CONCURRENCY=2
export XDG_CACHE_HOME="$PWD/.toris-studio/cache"
pnpm build
pnpm start --hostname 127.0.0.1
```

Keep `.toris-studio/`, `public/generated/`, `public/assets/` (legacy uploads), `public/renders/` and `local-voice/` on persistent storage. Git ignores runtime outputs. Back these up with project JSONs: JSON alone does not contain the media. Retain a single Next.js writer for the JSON repository; the in-process write queue is not a multi-process or distributed lock. Use the database repository before scaling to multiple writers. Serve this unauthenticated local MVP only on a private/loopback interface.

Each render creates and removes a temporary bundle, with a live public-directory symlink on Linux. It sees media added since the previous render and avoids duplicating existing MP4s. Do not overwrite a referenced asset during an active render. Remotion's bundler cache still accelerates compilation.

```bash
pnpm typecheck
pnpm test
pnpm render:project -- .toris-studio/devday/shorts.json
pnpm render:project -- --id b2150d8a-f2ec-4be4-bfa9-0981c63b9c01
```

`REMOTION_SCALE=0.5` is for small verification renders; omit it for full-resolution exports. `REMOTION_CONCURRENCY` is bounded to 1–16, defaults to 2. A long video can take several minutes on a small CPU worker. `pnpm render:project` and `/api/render` call the same `renderProject()` function and `News-*` compositions used by the editor's preview. No separate FFmpeg slideshow is used.

## Korean voice

MLX itself now documents Linux CUDA and CPU packages. That **does not validate this repository's `mlx_audio` Qwen voice runtime on Linux**. The existing Mac setup and `GGML_METAL=ON` Whisper scripts remain Mac-specific. Official references: https://github.com/ml-explore/mlx and https://github.com/QwenLM/Qwen3-TTS (checked 2026-10-01).

The working no-API path here is importing prepared narration through **준비된 내레이션 연결**. The editor measures the file duration, uploads it into ignored generated assets, and sets scene length with a short tail. Update the narration text and caption cues to match the recording. Existing tracked DevDay WAVs are reusable source assets, not evidence that new synthesis worked in this container.

An **optional, not yet synthesis-validated** PyTorch adapter is included for an ordinary Linux CPU machine:

```bash
pnpm tts:setup:linux
# Set HF_REVISION to the reviewed immutable commit of the official model.
# Downloading a public model is not a paid inference API.
export HF_REVISION=YOUR_REVIEWED_MODEL_COMMIT
local-voice/venv/bin/python - <<'PYMODEL'
import os
from huggingface_hub import snapshot_download
snapshot_download("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
                  revision=os.environ["HF_REVISION"],
                  local_dir="local-voice/qwen3-tts-model")
PYMODEL
pnpm tts:start:linux
```

The package entry versions are pinned; setup writes a resolved dependency inventory into `local-voice/requirements-resolved.txt`. This is not a fully locked or tested Python environment yet. CPU synthesis may be slow; validate one short sentence first. The runtime is loopback-only and loads only local model files. It returns the same `/health` and `/synthesize` interface as the Mac service; the editor displays the actual reported provider. 0.6B CustomVoice does not support style instructions; `QWEN_TTS_STYLE_CONTROL=1` is only for a compatible model such as 1.7B CustomVoice. Set `QWEN_TTS_DEVICE` explicitly if using a separately provisioned compatible accelerator environment.

At execution time model downloads from Hugging Face failed at the network proxy with HTTP 403. No new model, paid service, OAuth grant, or secret was acquired. Python syntax and shell syntax were checked; synthesis and model quality remain unverified.

## Optional STT

```bash
bash scripts/setup-whisper-linux.sh
bash scripts/start-whisper-linux.sh
```

This pins whisper.cpp v1.8.3, builds with `GGML_METAL=OFF` and `GGML_CUDA=OFF`, uses the multilingual `base` model, and binds port 8080 to loopback. Increase model size explicitly if accuracy requires it. Model download and STT transcription were not completed in the restricted environment; they are not prerequisites for importing prepared narration.

## DevDay production inputs

```bash
pnpm devday:prepare
# Capture your actual Studio screen as public/generated/devday/studio-screen.png
# (or use scripts/verify-studio.py against the running local application).
pnpm render:project -- .toris-studio/devday/shorts.json
pnpm render:project -- .toris-studio/devday/vertical.json
pnpm render:project -- .toris-studio/devday/youtube-landscape.json
```

Preparation normalizes tracked WAVs locally and records source hashes in `.toris-studio/devday/input-manifest.json`. It writes all three editable project JSONs. It does not import an externally rendered video. Shorts and Reels use the same 59.43-second story in distinct projects. The 191.43-second long-form is explicitly a **review draft**: its six new explanation scenes need narration. Caption times are text-weighted estimates, not forced alignment. Add approved narration and review timing before publication.

For browser verification, install Python Playwright in your test environment, start Studio, then run `python3 scripts/verify-studio.py`. This saves the prepared projects, exercises playback/save/reload/audio import, and writes screenshots under `.toris-studio/devday/evidence/`. Capture a selected project at a useful frame to `public/generated/devday/studio-screen.png` before rendering the long-form. The screenshot is an explicit required input, not automatically fabricated.
