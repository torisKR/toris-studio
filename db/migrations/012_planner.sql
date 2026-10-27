-- Work items and calendar events for one-person operations. Studio is the source of truth
-- for publication-linked events; Google Calendar sync only touches the app-created calendar.
CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY,
  title varchar(300) NOT NULL CHECK (length(title) > 0),
  notes varchar(20000) NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','dropped')),
  due_at timestamptz,
  product_id uuid,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ops','agent')),
  source_ref varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_items_open_idx ON work_items(status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS work_items_source_ref_idx ON work_items(source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS calendar_events (
  id uuid PRIMARY KEY,
  title varchar(300) NOT NULL CHECK (length(title) > 0),
  notes varchar(8000) NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  -- What the event belongs to. A publication-linked event is owned by Studio (one-way to Google).
  link_kind text NOT NULL DEFAULT 'none' CHECK (link_kind IN ('none','work_item','publication_job')),
  link_id uuid,
  google_id varchar(1024),
  google_etag varchar(200),
  deleted boolean NOT NULL DEFAULT false,
  local_updated_at timestamptz NOT NULL DEFAULT now(),
  remote_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at),
  CHECK ((link_kind = 'none') = (link_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_google_idx ON calendar_events(google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_link_idx ON calendar_events(link_kind, link_id) WHERE link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calendar_events_range_idx ON calendar_events(starts_at) WHERE NOT deleted;

-- One row: the app-created Google calendar and its incremental sync token.
CREATE TABLE IF NOT EXISTS calendar_sync_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  calendar_id varchar(1024),
  sync_token varchar(4096),
  last_synced_at timestamptz,
  last_error varchar(500)
);
INSERT INTO calendar_sync_state(id) VALUES (1) ON CONFLICT DO NOTHING;

-- When both sides changed, the newer one wins; the losing version is kept here for review.
CREATE TABLE IF NOT EXISTS calendar_conflicts (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  winner text NOT NULL CHECK (winner IN ('local','remote')),
  losing jsonb NOT NULL CHECK (jsonb_typeof(losing) = 'object'),
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_conflicts_open_idx ON calendar_conflicts(resolved, created_at);

GRANT SELECT,INSERT,UPDATE,DELETE ON work_items, calendar_events, calendar_sync_state, calendar_conflicts TO toris_app;
INSERT INTO social_schema_migrations(version) VALUES ('012_planner') ON CONFLICT DO NOTHING;
