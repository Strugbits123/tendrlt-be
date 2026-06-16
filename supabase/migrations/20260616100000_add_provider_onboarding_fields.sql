-- ============================================================
-- Add onboarding fields to provider_profiles
--
-- is_onboarding_complete: FALSE until provider clicks "Go Live".
--   Admin verification queue only shows providers where this is TRUE.
--   Prevents showing half-filled profiles to admin.
--
-- documents: JSONB map of docType → Supabase Storage path.
--   Keys: insurance | trade_cert | business_reg | gov_id
--
-- portfolio_paths: array of Supabase Storage paths for portfolio files.
-- ============================================================

ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS is_onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS documents              JSONB  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS portfolio_paths        TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_provider_profiles_onboarding
  ON public.provider_profiles(is_onboarding_complete);
