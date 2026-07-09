-- ============================================================
-- Two-step job completion handshake.
--
-- The provider marks the job done first (sets provider_completed_at); only
-- then can the homeowner confirm completion (tender → completed, transaction →
-- completed) or open a dispute. This mirrors the standard marketplace flow:
-- the worker signals done, the payer confirms or disputes.
-- See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
-- ============================================================

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS provider_completed_at TIMESTAMP WITH TIME ZONE;
