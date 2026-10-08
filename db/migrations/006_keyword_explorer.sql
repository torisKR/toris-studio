-- Additive explorer data. Opal records and all existing social/OAuth data are retained.
CREATE TABLE IF NOT EXISTS keyword_search_runs (
  id uuid PRIMARY KEY,
  query varchar(100) NOT NULL CHECK (length(btrim(query)) BETWEEN 1 AND 100),
  source text NOT NULL CHECK (source IN ('all','youtube','naver_blog','google_trends')),
  searched_at timestamptz NOT NULL,
  result_count integer NOT NULL CHECK (result_count BETWEEN 0 AND 100),
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) <= 100 AND octet_length(results::text) <= 262144)
);
CREATE INDEX IF NOT EXISTS keyword_search_runs_time_idx ON keyword_search_runs (searched_at DESC,id);

-- A position records our source response order, never a global search/SEO rank.
-- Only actual YouTube/Naver API searches produce these observations.
CREATE TABLE IF NOT EXISTS keyword_search_observations (
  run_id uuid NOT NULL REFERENCES keyword_search_runs(id),
  query varchar(100) NOT NULL,
  source text NOT NULL CHECK (source IN ('youtube','naver_blog')),
  url varchar(2048) NOT NULL CHECK (url ~ '^https://'),
  title varchar(300) NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (run_id,source,position)
);
CREATE INDEX IF NOT EXISTS keyword_search_observations_url_idx ON keyword_search_observations (url,observed_at DESC);
CREATE INDEX IF NOT EXISTS keyword_search_observations_query_idx ON keyword_search_observations (query,observed_at DESC);

CREATE TABLE IF NOT EXISTS keyword_documents (
  id uuid PRIMARY KEY,
  url varchar(2048) NOT NULL CHECK (url ~ '^https://'),
  engine text NOT NULL CHECK (engine IN ('crawl4ai','firecrawl')),
  title varchar(300) NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  observed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS keyword_documents_url_idx ON keyword_documents (url,observed_at DESC,id);

-- The application role cannot silently revise or remove historical observations.
GRANT SELECT,INSERT ON keyword_search_runs,keyword_search_observations,keyword_documents TO toris_app;
INSERT INTO social_schema_migrations (version) VALUES ('006_keyword_explorer') ON CONFLICT DO NOTHING;
