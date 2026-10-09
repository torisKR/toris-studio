#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Linux ]] || { echo 'Linux required' >&2; exit 1; }
runtime_dir="${TORIS_RUNTIME_HOME:-$PWD/local-voice}"
whisper_dir="$runtime_dir/whisper.cpp"
pinned_release="v1.8.3"
for tool in git cmake ffmpeg; do command -v "$tool" >/dev/null; done
mkdir -p "$runtime_dir"
# Pinned release; no implicit pulls of a moving branch.
if [[ ! -e "$whisper_dir/.git" ]]; then
  git clone --branch "$pinned_release" --depth 1 https://github.com/ggml-org/whisper.cpp.git "$whisper_dir"
fi
pinned_commit="$(git -C "$whisper_dir" rev-parse --verify "refs/tags/$pinned_release^{commit}" 2>/dev/null)" || {
  echo "Whisper checkout is missing $pinned_release. Use a fresh TORIS_RUNTIME_HOME or prepare that release manually; this checkout was not changed." >&2
  exit 1
}
if [[ "$(git -C "$whisper_dir" rev-parse HEAD)" != "$pinned_commit" ]]; then
  echo "Whisper checkout must be at $pinned_release. Preserve your changes and switch it manually, or use a fresh TORIS_RUNTIME_HOME; setup will not reset it." >&2
  exit 1
fi
checkout_status="$(git -C "$whisper_dir" status --porcelain --untracked-files=normal)" || {
  echo "Cannot verify Whisper checkout changes. Resolve the Git error or use a fresh TORIS_RUNTIME_HOME; no build was started." >&2
  exit 1
}
if [[ -n "$checkout_status" ]]; then
  echo "Whisper checkout has local changes. Preserve or resolve them manually, or use a fresh TORIS_RUNTIME_HOME; setup requires a clean $pinned_release checkout." >&2
  exit 1
fi
cmake -S "$whisper_dir" -B "$whisper_dir/build" -DGGML_METAL=OFF -DGGML_CUDA=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build "$whisper_dir/build" -j "${TORIS_BUILD_JOBS:-2}"
bash "$whisper_dir/models/download-ggml-model.sh" "${WHISPER_MODEL:-base}"
echo 'Ready. Run bash scripts/start-whisper-linux.sh'
