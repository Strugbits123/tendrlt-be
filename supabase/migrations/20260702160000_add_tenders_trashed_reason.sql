-- Admin-supplied reason shown to the homeowner when a tender is removed
-- (soft-deleted via trashed_at). NULL when the tender is live or restored.
ALTER TABLE public.tenders ADD COLUMN IF NOT EXISTS trashed_reason TEXT;
