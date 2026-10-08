-- Additive only: existing channels, credentials and trend observations are unchanged.
CREATE TABLE IF NOT EXISTS opal_research_runs (
  id uuid PRIMARY KEY,
  topic varchar(200) NOT NULL CHECK (length(topic) > 0),
  region varchar(2) NOT NULL CHECK (region = 'KR'),
  lookback_days smallint NOT NULL CHECK (lookback_days = 7),
  generated_at timestamptz NOT NULL,
  result jsonb NOT NULL CONSTRAINT opal_research_runs_result_shape CHECK (COALESCE(
    jsonb_typeof(result) = 'object'
    AND result ? 'keywords'
    AND CASE WHEN jsonb_typeof(result->'keywords') = 'array'
      THEN jsonb_array_length(result->'keywords') BETWEEN 1 AND 10
      ELSE false END
    AND octet_length(result::text) <= 131072,
    false
  ))
);
CREATE INDEX IF NOT EXISTS opal_research_runs_generated_idx
  ON opal_research_runs (generated_at DESC, id);
INSERT INTO social_schema_migrations (version)
  VALUES ('004_opal_research') ON CONFLICT DO NOTHING;
GRANT SELECT, INSERT ON opal_research_runs TO toris_app;
