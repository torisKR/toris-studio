-- Handoffs are durable review tasks, never executable upload jobs.
ALTER TABLE publication_jobs DROP CONSTRAINT IF EXISTS publication_jobs_mode_check;
ALTER TABLE publication_jobs ADD CONSTRAINT publication_jobs_mode_check
  CHECK (mode IN ('manual','scheduled','tiktok_inbox','manual_handoff'));
ALTER TABLE publication_jobs DROP CONSTRAINT IF EXISTS publication_jobs_status_check;
ALTER TABLE publication_jobs ADD CONSTRAINT publication_jobs_status_check
  CHECK (status IN ('queued','scheduled','sending','processing','published','draft_sent','uncertain','needs_confirmation','needs_human_publish','failed','cancelled'));
ALTER TABLE publication_jobs DROP CONSTRAINT IF EXISTS publication_jobs_handoff_check;
ALTER TABLE publication_jobs ADD CONSTRAINT publication_jobs_handoff_check
  CHECK ((mode <> 'manual_handoff' OR (status IN ('needs_human_publish','published','cancelled') AND scheduled_at IS NULL))
    AND (status <> 'needs_human_publish' OR mode = 'manual_handoff'));
INSERT INTO social_schema_migrations(version) VALUES ('008_publication_handoffs') ON CONFLICT DO NOTHING;
