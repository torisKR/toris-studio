#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then echo 'Cloud Linux CPU only; no Mac rendering.' >&2; exit 1; fi
cd "$(dirname "$0")/.."
for tool in node ffmpeg ffprobe fc-match; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw Error("Node 24 required by project engines")'
export REMOTION_BROWSER_EXECUTABLE="${REMOTION_BROWSER_EXECUTABLE:-$(command -v chromium || command -v chromium-browser || true)}"
[[ -x "$REMOTION_BROWSER_EXECUTABLE" ]] || { echo 'Set REMOTION_BROWSER_EXECUTABLE to installed Chromium.' >&2; exit 1; }
[[ "$(fc-match -f '%{family}' 'Noto Sans CJK KR:lang=ko')" == *'Noto Sans CJK'* ]] || { echo 'Install fonts-noto-cjk in the cloud environment.' >&2; exit 1; }
export REMOTION_CONCURRENCY=1
export REMOTION_SCALE=1
sample_dir="$(node --import tsx scripts/prepare-explainer-sample.ts)"
for format in youtube-landscape shorts; do
  node --import tsx scripts/check-explainer-project.ts "$sample_dir/$format.json"
  node --import tsx scripts/render-project.ts "$sample_dir/$format.json" > "$sample_dir/$format-render.json"
  video_path="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).outputLocation)' "$sample_dir/$format-render.json")"
  ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration -of json "$video_path" > "$sample_dir/$format-probe.json"
  for second in 0 1 2 3 4 5; do
    ffmpeg -v error -n -ss "$second" -i "$video_path" -frames:v 1 "$sample_dir/$format-$second.png"
  done
done
echo "Samples and frame evidence: $sample_dir"
