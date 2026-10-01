#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Linux ]]; then echo 'This script is for Linux.' >&2; exit 1; fi
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$PWD/.toris-studio/cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$PWD/.toris-studio/data}"
mkdir -p "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
for tool in node pnpm ffmpeg ffprobe fc-match; do
  command -v "$tool" >/dev/null || { echo "Missing dependency: $tool" >&2; exit 1; }
done
browser="${REMOTION_BROWSER_EXECUTABLE:-$(command -v chromium || command -v chromium-browser || true)}"
if [[ -z "$browser" || ! -x "$browser" ]]; then
  echo 'Install Chromium and set REMOTION_BROWSER_EXECUTABLE to its executable.' >&2; exit 1
fi
"$browser" --version
font="$(fc-match -f '%{family}' 'Noto Sans CJK KR:lang=ko')"
if [[ "$font" != *'Noto Sans CJK'* ]]; then
  echo 'Install fonts-noto-cjk; Korean glyphs are required.' >&2; exit 1
fi
echo "Korean font: $font"
pnpm install --frozen-lockfile --store-dir "$XDG_DATA_HOME/pnpm-store"
pnpm typecheck
echo "Run with REMOTION_BROWSER_EXECUTABLE=$browser XDG_CACHE_HOME=$XDG_CACHE_HOME"
