#!/usr/bin/env bash
set -euo pipefail
# Official release asset and SHA256 from github.com/gitleaks/gitleaks v8.30.1.
task_scanner_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/toris-gitleaks.XXXXXX")"
trap 'rm -rf "$task_scanner_dir"' EXIT
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  --output "$task_scanner_dir/gitleaks.tar.gz"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "$task_scanner_dir/gitleaks.tar.gz" | sha256sum --check
tar -xzf "$task_scanner_dir/gitleaks.tar.gz" -C "$task_scanner_dir" gitleaks
"$task_scanner_dir/gitleaks" git --redact --no-banner --log-opts='--all'
