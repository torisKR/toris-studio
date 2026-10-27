-- Products a one-person business runs and read-only status snapshots about them.
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL CHECK (length(name) > 0),
  kind text NOT NULL CHECK (kind IN ('app','web','service')),
  github_repo varchar(200) CHECK (github_repo IS NULL OR github_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  cloudflare_worker varchar(100) CHECK (cloudflare_worker IS NULL OR cloudflare_worker ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  cloudflare_pages varchar(100) CHECK (cloudflare_pages IS NULL OR cloudflare_pages ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  health_url varchar(2048) CHECK (health_url IS NULL OR health_url ~ '^https://'),
  play_package varchar(200) CHECK (play_package IS NULL OR play_package ~ '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_status_snapshots (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('github_ci','github_release','cloudflare','http','play')),
  -- Separate states; "deployed" is never "healthy", "in_review" is never "public".
  state text NOT NULL CHECK (state IN ('passing','failing','running','deployed','deploy_failed','healthy','unhealthy','draft','in_review','public','halted','unknown','error')),
  summary varchar(500) NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_status_latest_idx ON product_status_snapshots(product_id, source, observed_at DESC);

GRANT SELECT,INSERT,UPDATE,DELETE ON products, product_status_snapshots TO toris_app;
INSERT INTO social_schema_migrations(version) VALUES ('010_ops_status') ON CONFLICT DO NOTHING;
