-- ============================================================
-- Provider verification: attach status + audit columns to
-- provider_profiles so admins can approve/reject submitted providers.
-- The verification_status enum already exists (20260609210000_create_enums.sql).
-- ============================================================

ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS verification_status public.verification_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS submitted_at      TIMESTAMPTZ,   -- set on go-live (first submission)
  ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ,   -- set on approve/reject
  ADD COLUMN IF NOT EXISTS reviewed_by       UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS rejection_reason  TEXT,          -- shown to provider in email
  ADD COLUMN IF NOT EXISTS rejection_notes   TEXT,          -- extra detail in email
  ADD COLUMN IF NOT EXISTS admin_notes       TEXT;          -- internal only, never emailed

-- Backfill existing rows: already-verified providers count as approved.
-- (Default 'pending' already covers everyone else.)
UPDATE public.provider_profiles
   SET verification_status = 'approved'
 WHERE is_verified = TRUE
   AND verification_status <> 'approved';

-- Queue index: admin lists by status, filtered to submitted providers.
CREATE INDEX IF NOT EXISTS idx_provider_profiles_verification
  ON public.provider_profiles(verification_status, is_onboarding_complete);
