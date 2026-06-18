-- ============================================================
-- Alter tenders table to match the Post-a-Job UI exactly
--
-- Changes:
--   - DROP title (not in UI)
--   - ADD service_type_id UUID FK → service_types (same pattern as provider_services)
--   - ADD contact_name, contact_phone, contact_email
--   - ADD urgency_note
-- ============================================================

-- 1. Drop title column (not present in the UI)
ALTER TABLE public.tenders DROP COLUMN IF EXISTS title;

-- 2. Add service_type_id (nullable first so existing rows don't violate NOT NULL)
ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS service_type_id UUID REFERENCES public.service_types(id);

-- 3. Backfill existing rows
UPDATE public.tenders t
SET service_type_id = st.id
FROM public.service_types st
WHERE st.slug = t.category::text
  AND t.service_type_id IS NULL;

-- 4. Enforce NOT NULL now that all rows are backfilled
ALTER TABLE public.tenders
  ALTER COLUMN service_type_id SET NOT NULL;

-- 5. Add contact fields (nullable — form allows optional email)
ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS contact_name  VARCHAR(150),
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS urgency_note  TEXT;

-- 6. Index for FK lookups on service_type_id
CREATE INDEX IF NOT EXISTS idx_tenders_service_type_id
  ON public.tenders (service_type_id);
