-- Identity-bound mapping only. Tokens/client secrets remain in the OS vault.
CREATE TABLE IF NOT EXISTS social_channel_connections (
  channel_id uuid PRIMARY KEY REFERENCES social_channels(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  platform text NOT NULL,
  account_id varchar(200) NOT NULL CHECK (length(account_id)>0),
  verified_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (channel_id, platform) REFERENCES social_channels(id, platform)
);
CREATE INDEX IF NOT EXISTS social_channel_connections_grant_idx
 ON social_channel_connections(connection_id, platform, account_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_channel_connections TO toris_app;
-- Preserve legacy snapshots and successes. Unbound executable approvals require
-- fresh explicit review; migration never guesses an account or republishes.
UPDATE publication_jobs SET status='needs_confirmation',retryable=false,
 error='기존 작업의 계정 연결을 다시 선택하고 승인하세요. 자동 재게시하지 않습니다.',updated_at=now()
 WHERE mode<>'manual_handoff' AND status IN ('queued','scheduled','failed')
 AND COALESCE(snapshot->>'connectionId','')='';
INSERT INTO social_schema_migrations(version) VALUES ('009_oauth_connections') ON CONFLICT DO NOTHING;
