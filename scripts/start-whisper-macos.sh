#!/usr/bin/env bash
set -euo pipefail

RUNTIME_HOME="${TORIS_RUNTIME_HOME:-$HOME/.local/share/toris-studio}"
WHISPER_DIR="$RUNTIME_HOME/whisper.cpp"
MODEL="${WHISPER_MODEL:-large-v3-turbo}"
PORT="${WHISPER_PORT:-8080}"

SERVER="$WHISPER_DIR/build/bin/whisper-server"
MODEL_PATH="$WHISPER_DIR/models/ggml-$MODEL.bin"

if [ ! -x "$SERVER" ] || [ ! -f "$MODEL_PATH" ]; then
  echo "whisper.cpp is not installed. Run: bash scripts/setup-whisper-macos.sh"
  exit 1
fi

exec "$SERVER"   -m "$MODEL_PATH"   --host 127.0.0.1   --port "$PORT"   --convert
