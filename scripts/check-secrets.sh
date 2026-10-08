#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v gitleaks >/dev/null || { echo 'Install gitleaks (brew install gitleaks) before publishing.' >&2; exit 1; }
gitleaks git --redact --no-banner --log-opts='--all'
# Scan only files eligible for Git, never local credentials or dependency stores.
scan_dir="$(mktemp -d "${TMPDIR:-/tmp}/toris-secrets.XXXXXX")"
trap 'rm -rf "$scan_dir"' EXIT
python3 - "$scan_dir" <<'PY'
import pathlib, shutil, subprocess, sys
root=pathlib.Path.cwd(); target=pathlib.Path(sys.argv[1])
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z']).decode().split('\0')
for name in paths:
    if not name: continue
    source=root/name
    if not source.is_file() or source.is_symlink(): continue
    destination=target/name; destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(source,destination)
PY
gitleaks dir --redact --no-banner "$scan_dir"
