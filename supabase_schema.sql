-- ============================================================================
-- EDU CORE — DARUL HUDA BENGAL CAMPUS
-- Supabase PostgreSQL Schema & Row Level Security (RLS) Setup
--
-- INSTRUCTIONS:
-- 1. Open Supabase Dashboard -> Project "isgfeegychnqacdcwkbk" -> SQL Editor
-- 2. Click "New query", paste this entire script, and click "Run"
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.educore_records (
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_educore_records_collection
  ON public.educore_records (collection);

CREATE OR REPLACE FUNCTION public.educore_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_educore_records_updated_at ON public.educore_records;
CREATE TRIGGER trg_educore_records_updated_at
  BEFORE UPDATE ON public.educore_records
  FOR EACH ROW
  EXECUTE FUNCTION public.educore_set_updated_at();

ALTER TABLE public.educore_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "educore_public_access" ON public.educore_records;
CREATE POLICY "educore_public_access"
  ON public.educore_records
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

GRANT ALL ON TABLE public.educore_records TO anon, authenticated;
