#!/usr/bin/env bash
set -euo pipefail

RUNTIME_HOME="${TORIS_RUNTIME_HOME:-$HOME/.local/share/toris-studio}"
WHISPER_DIR="$RUNTIME_HOME/whisper.cpp"
MODEL="${WHISPER_MODEL:-large-v3-turbo}"

for command_name in git cmake ffmpeg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing dependency: $command_name"
    exit 1
  fi
done

mkdir -p "$RUNTIME_HOME"

if [ ! -d "$WHISPER_DIR/.git" ]; then
  git clone https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
else
  git -C "$WHISPER_DIR" pull --ff-only
fi

cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DGGML_METAL=ON
cmake --build "$WHISPER_DIR/build" -j --config Release

if [ ! -f "$WHISPER_DIR/models/ggml-$MODEL.bin" ]; then
  bash "$WHISPER_DIR/models/download-ggml-model.sh" "$MODEL"
fi

echo
echo "whisper.cpp ready:"
echo "  repo:  $WHISPER_DIR"
echo "  model: $MODEL"
echo "Start it with:"
echo "  bash scripts/start-whisper-macos.sh"
