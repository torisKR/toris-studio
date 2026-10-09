CREATE TABLE IF NOT EXISTS social_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_channels (
  id uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('youtube','threads','naver_blog','tiktok','instagram')),
  name varchar(120) NOT NULL CHECK (length(name) > 0),
  handle varchar(200) NOT NULL DEFAULT '',
  url varchar(2048) NOT NULL CHECK (url ~ '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, platform)
);

CREATE TABLE IF NOT EXISTS social_content (
  id uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('youtube','threads','naver_blog','tiktok','instagram')),
  channel_id uuid,
  title varchar(300) NOT NULL CHECK (length(title) > 0),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 30000),
  status text NOT NULL CHECK (status IN ('draft','ready','scheduled','published')),
  scheduled_at timestamptz,
  url varchar(2048) CHECK (url IS NULL OR url ~ '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (channel_id, platform) REFERENCES social_channels(id, platform),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CHECK (status <> 'published' OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS social_content_updated_idx ON social_content (updated_at DESC);
CREATE INDEX IF NOT EXISTS social_content_schedule_idx ON social_content (scheduled_at) WHERE status='scheduled';
CREATE INDEX IF NOT EXISTS social_content_channel_idx ON social_content (channel_id);

CREATE TABLE IF NOT EXISTS social_trends (
  id varchar(40) PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('google_trends','youtube','naver_blog')),
  keyword varchar(100) NOT NULL,
  title varchar(300) NOT NULL,
  url varchar(2048) NOT NULL CHECK (url ~ '^https://'),
  metric varchar(200),
  region varchar(2) NOT NULL DEFAULT 'KR' CHECK (region = 'KR'),
  published_at timestamptz,
  fetched_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source,url,keyword)
);
CREATE INDEX IF NOT EXISTS social_trends_fetched_idx ON social_trends (fetched_at DESC);
CREATE INDEX IF NOT EXISTS social_trends_keyword_idx ON social_trends (keyword);

-- First real observation per Korean calendar day; comparisons state their actual timestamp.
CREATE TABLE IF NOT EXISTS social_trend_snapshots (
  source text NOT NULL CHECK (source IN ('google_trends','youtube','naver_blog')),
  url varchar(2048) NOT NULL,
  observed_day date NOT NULL,
  observed_at timestamptz NOT NULL,
  view_count bigint NOT NULL CHECK (view_count >= 0),
  PRIMARY KEY (source,url,observed_day)
);

INSERT INTO social_schema_migrations (version) VALUES ('001_social') ON CONFLICT DO NOTHING;
GRANT USAGE ON SCHEMA public TO toris_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON social_channels,social_content,social_trends,social_trend_snapshots TO toris_app;
GRANT SELECT ON social_schema_migrations TO toris_app;
