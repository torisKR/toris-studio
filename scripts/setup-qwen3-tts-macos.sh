#!/usr/bin/env bash
set -euo pipefail

RUNTIME_HOME="${TORIS_RUNTIME_HOME:-$HOME/.local/share/toris-studio}"
QWEN_DIR="$RUNTIME_HOME/qwen3-tts-mlx"
MODEL_ID="${QWEN_TTS_MODEL:-mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit}"

mkdir -p "$QWEN_DIR"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install uv first."
  exit 1
fi

if [ ! -d "$QWEN_DIR/venv" ]; then
  uv venv --python 3.12 "$QWEN_DIR/venv"
fi

uv pip install --python "$QWEN_DIR/venv/bin/python" \
  "mlx-audio>=0.3.0" \
  "fastapi>=0.115" \
  "uvicorn>=0.34" \
  "python-multipart>=0.0.20" \
  "soundfile>=0.13" \
  "huggingface-hub[hf_xet]>=0.29"

mkdir -p "$QWEN_DIR/model"
"$QWEN_DIR/venv/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('$MODEL_ID', local_dir='$QWEN_DIR/model')"

echo
echo "Qwen3-TTS MLX ready."
echo "  runtime: $QWEN_DIR"
echo "  model:   $MODEL_ID"
echo "Start with:"
echo "  bash scripts/start-qwen3-tts-macos.sh"
