-- ============================================================
-- Add terms_accepted_at to tenders
--
-- Records the exact timestamp when the homeowner checked
-- "I agree to the Terms of Service and Privacy Policy of Tendrit"
-- and submitted their tender (status changed to 'open').
-- NULL for drafts that have not yet been submitted.
-- ============================================================

ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITH TIME ZONE;
