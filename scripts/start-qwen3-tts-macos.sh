#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_HOME="${TORIS_RUNTIME_HOME:-$HOME/.local/share/toris-studio}"
QWEN_DIR="$RUNTIME_HOME/qwen3-tts-mlx"
MODEL_DIR="${QWEN_TTS_MODEL_DIR:-$QWEN_DIR/model}"
PORT="${QWEN_TTS_PORT:-50010}"

if [ ! -x "$QWEN_DIR/venv/bin/python" ]; then
  echo "Qwen3-TTS runtime is not installed. Run: bash scripts/setup-qwen3-tts-macos.sh"
  exit 1
fi

if [ ! -f "$MODEL_DIR/config.json" ]; then
  echo "Qwen3-TTS model is missing: $MODEL_DIR"
  exit 1
fi

export QWEN_TTS_MODEL_DIR="$MODEL_DIR"
export QWEN_TTS_SPEAKER="${QWEN_TTS_SPEAKER:-Sohee}"
export QWEN_TTS_LANGUAGE="${QWEN_TTS_LANGUAGE:-Korean}"
export QWEN_TTS_INSTRUCT="${QWEN_TTS_INSTRUCT:-따뜻하고 자연스러운 한국 여성 목소리. 실제 사람이 말하듯 편안하고 부드럽게, 광고처럼 과장하지 말고 문장마다 자연스럽게 호흡하며 또렷하게 말한다.}"

echo "Starting local Qwen3-TTS MLX on http://127.0.0.1:$PORT"
exec "$QWEN_DIR/venv/bin/python" -m uvicorn runtime.qwen3_tts_server:app \
  --app-dir "$SCRIPT_ROOT" --host 127.0.0.1 --port "$PORT"
