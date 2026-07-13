-- ============================================================
-- Platform fee: effective-date scheduling + creation-time snapshots.
--
-- See documentation/PAYMENTS_AND_JOB_WORKFLOW.md
-- ("Platform fee scheduling & creation-time snapshots").
--
-- Two changes:
--  1. platform_fee_config gains a PENDING slot per side. A fee change with a
--     future effective date is parked here and does NOT alter the live rate
--     until the daily activation job (00:05 Jamaica / 05:05 UTC) promotes it.
--  2. The rate each party is shown at CREATION is snapshotted onto their row:
--       tenders.client_fee_rate   — active client rate when the tender is posted
--       quotes.provider_fee_rate  — active provider rate when the quote is made
--     These are copied onto the transaction at accept, so a later fee change
--     never re-prices an already-posted job.
-- All rates are percentages, e.g. 9.50 means 9.5%.
-- ============================================================

-- 1) Pending (scheduled) fee change, per side.
ALTER TABLE public.platform_fee_config
  ADD COLUMN IF NOT EXISTS pending_client_rate        NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS pending_client_effective   DATE,
  ADD COLUMN IF NOT EXISTS pending_provider_rate      NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS pending_provider_effective DATE;

-- 2) Creation-time snapshots.
ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS client_fee_rate NUMERIC(5,2);

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS provider_fee_rate NUMERIC(5,2);

-- Backfill existing rows from the current active config so nothing is null.
UPDATE public.tenders
   SET client_fee_rate = (SELECT client_rate FROM public.platform_fee_config WHERE id = 1)
 WHERE client_fee_rate IS NULL;

UPDATE public.quotes
   SET provider_fee_rate = (SELECT provider_rate FROM public.platform_fee_config WHERE id = 1)
 WHERE provider_fee_rate IS NULL;
