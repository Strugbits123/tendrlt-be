-- ============================================================
-- Provider resubmission after rejection.
-- A rejected provider can edit their onboarding and resubmit; the
-- application returns to the admin's pending queue while the prior
-- rejection reason is preserved so the admin remembers the history.
-- ============================================================

ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS resubmitted_at      TIMESTAMPTZ,                       -- last resubmission after a rejection
  ADD COLUMN IF NOT EXISTS verification_history JSONB NOT NULL DEFAULT '[]'::jsonb; -- audit trail of review actions
