#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
runtime_dir="${TORIS_RUNTIME_HOME:-$PWD/local-voice}"
export QWEN_TTS_MODEL_DIR="${QWEN_TTS_MODEL_DIR:-$runtime_dir/qwen3-tts-model}"
export HF_HUB_OFFLINE=1
exec "$runtime_dir/venv/bin/python" -m uvicorn runtime.qwen3_tts_torch_server:app \
  --host 127.0.0.1 --port "${QWEN_TTS_PORT:-50010}" --workers 1
