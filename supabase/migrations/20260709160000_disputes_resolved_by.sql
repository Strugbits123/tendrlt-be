-- ============================================================
-- disputes: record which admin resolved the case.
--
-- The admin Dispute Management console resolves a dispute with an outcome
-- (refund / release / split) + a note. We already store status/resolution/
-- resolution_notes/resolved_at; add resolved_by so the resolution history can
-- attribute the decision to a real admin instead of a generic label.
-- See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
-- ============================================================

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL;
