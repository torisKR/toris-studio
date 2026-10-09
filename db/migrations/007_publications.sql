-- Approved, immutable snapshots only enter the executor. Existing calendar rows
-- become editable drafts and never become executable jobs during migration.
ALTER TABLE social_channels DROP CONSTRAINT IF EXISTS social_channels_platform_check;
ALTER TABLE social_channels ADD CONSTRAINT social_channels_platform_check CHECK (platform IN ('youtube','threads','naver_blog','tiktok','instagram','facebook'));
ALTER TABLE social_content DROP CONSTRAINT IF EXISTS social_content_platform_check;
ALTER TABLE social_content ADD CONSTRAINT social_content_platform_check CHECK (platform IN ('youtube','threads','naver_blog','tiktok','instagram','facebook'));

CREATE TABLE IF NOT EXISTS publications (
  id uuid PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  legacy_content_id uuid UNIQUE REFERENCES social_content(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS publication_jobs (
  id uuid PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  target_id uuid NOT NULL,
  approval_hash varchar(64) NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  mode text NOT NULL CHECK (mode IN ('manual','scheduled','tiktok_inbox')),
  scheduled_at timestamptz,
  status text NOT NULL CHECK (status IN ('queued','scheduled','sending','processing','published','draft_sent','uncertain','needs_confirmation','failed','cancelled')),
  remote jsonb,
  result jsonb,
  error text,
  retryable boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(publication_id, revision, target_id),
  CHECK (mode <> 'scheduled' OR scheduled_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS publication_jobs_due_idx ON publication_jobs(status,scheduled_at);
CREATE INDEX IF NOT EXISTS publication_jobs_publication_idx ON publication_jobs(publication_id);
INSERT INTO publications (id,payload,legacy_content_id,created_at,updated_at)
SELECT id,jsonb_build_object(
 'title',title,'description',body,'tags','[]'::jsonb,'hashtags','[]'::jsonb,
 'videoMediaId',NULL,'thumbnailMediaId',NULL,
 'targets', CASE WHEN platform IN ('youtube','threads','tiktok','instagram','facebook') THEN
   jsonb_build_array(jsonb_build_object('id',id,'platform',platform,'accountId','',
    'accountTitle','기존 콘텐츠: 게시 계정을 다시 선택하세요','mode','manual',
    'overrides','{}'::jsonb,'options','{}'::jsonb)) ELSE '[]'::jsonb END,
 'legacyStatus',status,'legacyScheduledAt',scheduled_at),id,created_at,updated_at
FROM social_content ON CONFLICT DO NOTHING;
GRANT SELECT,INSERT,UPDATE,DELETE ON publications,publication_jobs TO toris_app;
INSERT INTO social_schema_migrations(version) VALUES ('007_publications') ON CONFLICT DO NOTHING;
