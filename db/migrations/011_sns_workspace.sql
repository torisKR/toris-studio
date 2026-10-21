-- Add manual channel types without changing any channel/content identities.
ALTER TABLE social_channels DROP CONSTRAINT IF EXISTS social_channels_platform_check;
ALTER TABLE social_channels ADD CONSTRAINT social_channels_platform_check
 CHECK (platform IN ('youtube','threads','naver_blog','tiktok','instagram','facebook','naver_clip','x'));
ALTER TABLE social_content DROP CONSTRAINT IF EXISTS social_content_platform_check;
ALTER TABLE social_content ADD CONSTRAINT social_content_platform_check
 CHECK (platform IN ('youtube','threads','naver_blog','tiktok','instagram','facebook','naver_clip','x'));
-- Manual report identities survive OAuth rebinding. An identity's first local
-- owner is retained so reusing an OAuth account cannot expose another channel's reports.
CREATE TABLE IF NOT EXISTS analytics_report_owners (
 platform text NOT NULL, account_id text NOT NULL,
 -- Retain the original owner UUID as a tombstone after channel deletion. A
 -- cascading FK would let a later bind claim that identity's retained imports.
 channel_id uuid NOT NULL,
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(platform,account_id)
);
CREATE INDEX IF NOT EXISTS analytics_report_owners_channel ON analytics_report_owners(channel_id);
INSERT INTO analytics_report_owners(platform,account_id,channel_id)
 SELECT platform,id::text,id FROM social_channels ON CONFLICT DO NOTHING;
INSERT INTO analytics_report_owners(platform,account_id,channel_id)
 SELECT platform,account_id,channel_id FROM social_channel_connections ORDER BY verified_at,channel_id ON CONFLICT DO NOTHING;
GRANT SELECT,INSERT,UPDATE,DELETE ON analytics_report_owners TO toris_app;
-- Repair early feature installations that already recorded migration010 without grants.
GRANT SELECT,INSERT,UPDATE,DELETE ON analytics_settings,analytics_sources,analytics_previews,analytics_observations,analytics_jobs TO toris_app;
INSERT INTO social_schema_migrations(version) VALUES ('011_sns_workspace') ON CONFLICT DO NOTHING;
