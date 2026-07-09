-- ============================================================
-- transactions: two-sided fee columns
--
-- Context: WiPay is deferred. When a homeowner accepts a quote we now record a
-- REAL transaction row (status 'held') so payment/revenue numbers are live —
-- no money actually moves until WiPay is integrated. The original table stored
-- a single `platform_fee`; the live fee model is two-sided (client fee added on
-- top of the quote, provider fee deducted from the payout), so we split it out.
--
-- All amounts are JMD cents (INTEGER).
--
-- NOTE: RLS on public.transactions and public.disputes is ALREADY enabled with
-- select-own (client/provider) + admin policies in
-- 20260609210006_enable_rls_all_tables.sql, so it is not repeated here. The
-- backend writes as superuser (db.query) and reads own rows via db.queryAsUser.
-- ============================================================

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS client_fee        INTEGER      NOT NULL DEFAULT 0,  -- cents, added on top (paid by client)
  ADD COLUMN IF NOT EXISTS provider_fee      INTEGER      NOT NULL DEFAULT 0,  -- cents, deducted from payout
  ADD COLUMN IF NOT EXISTS client_fee_rate   NUMERIC(5,2),                     -- % captured at creation (historical accuracy)
  ADD COLUMN IF NOT EXISTS provider_fee_rate NUMERIC(5,2);

-- `platform_fee` remains total platform revenue = client_fee + provider_fee.
-- `provider_payout` remains amount - provider_fee. Client total = amount + client_fee (derived).
