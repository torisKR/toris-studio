#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
runtime_dir="${TORIS_RUNTIME_HOME:-$PWD/local-voice}"
exec "$runtime_dir/whisper.cpp/build/bin/whisper-server" \
  -m "$runtime_dir/whisper.cpp/models/ggml-${WHISPER_MODEL:-base}.bin" \
  --host 127.0.0.1 --port "${WHISPER_PORT:-8080}" -l ko
