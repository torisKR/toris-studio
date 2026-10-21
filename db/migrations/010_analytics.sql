-- Explicitly applied additive analytics storage. Does not rewrite channels, content or credentials.
CREATE TABLE IF NOT EXISTS analytics_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), paused boolean NOT NULL DEFAULT false
);
INSERT INTO analytics_settings(singleton) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS analytics_sources (
  id uuid PRIMARY KEY, source_kind text NOT NULL CHECK(source_kind IN ('api','import')),
  platform text NOT NULL, account_id text NOT NULL, connection_id text,
  label text NOT NULL, filename text, digest text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','replaced','removed')),
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz,
  UNIQUE(source_kind,platform,account_id,digest)
);
CREATE TABLE IF NOT EXISTS analytics_previews (
  id uuid PRIMARY KEY, payload jsonb NOT NULL, digest text NOT NULL, can_commit boolean NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS analytics_observations (
  id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES analytics_sources(id) ON DELETE CASCADE,
  record_key text NOT NULL, metric text NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
  payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,record_key),
  CHECK(period_start <= period_end)
);
CREATE INDEX IF NOT EXISTS analytics_observations_period ON analytics_observations(period_start,period_end);
CREATE TABLE IF NOT EXISTS analytics_jobs (
  connection_id text NOT NULL, platform text NOT NULL, account_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending', last_sync_at timestamptz, next_sync_at timestamptz NOT NULL DEFAULT now(),
  cursor jsonb NOT NULL DEFAULT '{}', coverage jsonb NOT NULL DEFAULT '{}', message text NOT NULL DEFAULT '',
  lease_until timestamptz, lease_token uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,platform,account_id)
);
INSERT INTO social_schema_migrations(version) VALUES ('010_analytics') ON CONFLICT DO NOTHING;
