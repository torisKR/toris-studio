-- Existing 004 installations need an additive constraint: CREATE IF NOT EXISTS
-- does not replace the previous CHECK, and SQL NULL passes a plain CHECK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.opal_research_runs'::regclass
      AND conname = 'opal_research_runs_result_shape'
  ) THEN
    ALTER TABLE public.opal_research_runs
      ADD CONSTRAINT opal_research_runs_result_shape CHECK (COALESCE(
        jsonb_typeof(result) = 'object'
        AND result ? 'keywords'
        AND CASE WHEN jsonb_typeof(result->'keywords') = 'array'
          THEN jsonb_array_length(result->'keywords') BETWEEN 1 AND 10
          ELSE false END
        AND octet_length(result::text) <= 131072,
        false
      )) NOT VALID;
  END IF;

  -- New writes are guarded immediately. Preserve any legacy malformed rows
  -- rather than deleting/editing them or rolling back the new protection.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.opal_research_runs'::regclass
      AND conname = 'opal_research_runs_result_shape' AND NOT convalidated
  ) AND NOT EXISTS (
    SELECT 1 FROM public.opal_research_runs
    WHERE COALESCE(
      jsonb_typeof(result) = 'object'
      AND result ? 'keywords'
      AND CASE WHEN jsonb_typeof(result->'keywords') = 'array'
        THEN jsonb_array_length(result->'keywords') BETWEEN 1 AND 10
        ELSE false END
      AND octet_length(result::text) <= 131072,
      false
    ) IS NOT TRUE
  ) THEN
    ALTER TABLE public.opal_research_runs
      VALIDATE CONSTRAINT opal_research_runs_result_shape;
  END IF;
END;
$$;

INSERT INTO social_schema_migrations (version)
  VALUES ('005_opal_result_shape') ON CONFLICT DO NOTHING;
