-- Add manual channel types without changing any channel/content identities.
ALTER TABLE social_channels DROP CONSTRAINT IF EXISTS social_channels_platform_check;
ALTER TABLE social_channels ADD CONSTRAINT social_channels_platform_check
 CHECK (platform IN ('youtube','threads','naver_blog','tiktok','instagram','facebook','naver_clip','x'));
ALTER TABLE social_content DROP CONSTRAINT IF EXISTS social_content_platform_check;
ALTER TABLE social_content ADD CONSTRAINT social_content_platform_check
 CHECK (platform IN ('youtube','threads','naver_blog','tiktok','instagram','facebook','naver_clip','x'));
INSERT INTO social_schema_migrations(version) VALUES ('011_sns_workspace') ON CONFLICT DO NOTHING;
