-- ============================================================
-- disputes: add an evidence image column.
--
-- Homeowners can raise a dispute on an in-progress job with a written
-- description of what went wrong plus an optional photo of the work. The photo
-- is stored in Supabase Storage (tender-media bucket, disputes/ prefix); we
-- keep its storage path here and build the public URL when needed.
-- See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
-- ============================================================

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS image_path TEXT;
