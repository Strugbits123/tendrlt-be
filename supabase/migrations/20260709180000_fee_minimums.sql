-- ============================================================
-- Platform fee: minimum-fee floor (guardrail on very low-value jobs).
--
-- When a homeowner accepts a quote, the percentage-based fee can be negligible
-- on a very small job. These columns let admins enforce a minimum fee per side:
-- at accept time, if the computed client/provider fee falls below the minimum,
-- the minimum is charged instead. Amounts are JMD cents (J$100 = 10000).
-- Managed in Admin → Fee Settings → Advanced. See PAYMENTS_AND_JOB_WORKFLOW.md.
--
-- (The former "Fee Caps" and "Fee Change Grace Period" ideas were dropped, so no
--  max/grace columns exist.)
-- ============================================================

ALTER TABLE public.platform_fee_config
  ADD COLUMN IF NOT EXISTS min_client_fee   INTEGER NOT NULL DEFAULT 10000,  -- J$100 (cents)
  ADD COLUMN IF NOT EXISTS min_provider_fee INTEGER NOT NULL DEFAULT 10000,  -- J$100 (cents)
  ADD COLUMN IF NOT EXISTS min_fee_enabled  BOOLEAN NOT NULL DEFAULT true;
