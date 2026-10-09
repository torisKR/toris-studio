#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p .toris-studio/backups
destination=".toris-studio/backups/social-$(date +%Y%m%dT%H%M%S).dump"
temporary="${destination}.partial"
trap 'if [[ -f "$temporary" ]]; then rm -f "$temporary"; fi' EXIT
docker compose --env-file .env.db.local exec -T postgres pg_dump --username=toris_owner --dbname=toris_studio --format=custom > "$temporary"
mv "$temporary" "$destination"
echo "로컬 DB 백업 저장: $destination"
