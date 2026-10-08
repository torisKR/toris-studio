#!/usr/bin/env bash
set -euo pipefail
: "${TORIS_DB_APP_PASSWORD:?Set a strong app database password}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --set=app_password="$TORIS_DB_APP_PASSWORD" <<'SQL'
CREATE ROLE toris_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
