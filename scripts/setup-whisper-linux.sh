#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Linux ]] || { echo 'Linux required' >&2; exit 1; }
runtime_dir="${TORIS_RUNTIME_HOME:-$PWD/local-voice}"
whisper_dir="$runtime_dir/whisper.cpp"
for tool in git cmake ffmpeg; do command -v "$tool" >/dev/null; done
mkdir -p "$runtime_dir"
# Pinned release; no implicit pulls of a moving branch.
if [[ ! -d "$whisper_dir/.git" ]]; then
  git clone --branch v1.8.3 --depth 1 https://github.com/ggml-org/whisper.cpp.git "$whisper_dir"
fi
cmake -S "$whisper_dir" -B "$whisper_dir/build" -DGGML_METAL=OFF -DGGML_CUDA=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build "$whisper_dir/build" -j "${TORIS_BUILD_JOBS:-2}"
bash "$whisper_dir/models/download-ggml-model.sh" "${WHISPER_MODEL:-base}"
echo 'Ready. Run bash scripts/start-whisper-linux.sh'
