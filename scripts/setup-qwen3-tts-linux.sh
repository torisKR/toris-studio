#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Linux ]] || { echo 'Linux required' >&2; exit 1; }
runtime_dir="${TORIS_RUNTIME_HOME:-$PWD/local-voice}"
python3 -m venv "$runtime_dir/venv"
"$runtime_dir/venv/bin/python" -m pip install 'torch==2.14.1' 'torchaudio==2.14.1' --index-url https://download.pytorch.org/whl/cpu
"$runtime_dir/venv/bin/python" -m pip install -r runtime/requirements-linux.txt
"$runtime_dir/venv/bin/python" -m pip freeze > "$runtime_dir/requirements-resolved.txt"
echo 'Dependencies installed. Download the official CustomVoice model separately; see docs/LINUX.md.'
