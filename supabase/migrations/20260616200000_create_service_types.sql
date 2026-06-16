-- ============================================================
-- Create service_types lookup table
--
-- Replaces all hardcoded SERVICES arrays scattered across the
-- frontend (auth page, complete-profile, provider onboarding,
-- post-job). Single source of truth for display names + emojis.
--
-- provider_services gains service_type_id (UUID FK) alongside
-- the existing category enum column.
--
-- Migration order:
--   1. Extend enum with 4 services that existed in the signup
--      page but were never added to service_category.
--   2. Create + seed service_types.
--   3. Add service_type_id to provider_services and backfill.
-- ============================================================

-- 1. Extend the enum (safe — IF NOT EXISTS, no-op if already added)
ALTER TYPE public.service_category ADD VALUE IF NOT EXISTS 'auto_servicing';
ALTER TYPE public.service_category ADD VALUE IF NOT EXISTS 'car_wash';
ALTER TYPE public.service_category ADD VALUE IF NOT EXISTS 'child_patient_care';
ALTER TYPE public.service_category ADD VALUE IF NOT EXISTS 'delivery';

-- 2. Create service_types table
CREATE TABLE IF NOT EXISTS public.service_types (
  id           UUID     NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug         TEXT     NOT NULL UNIQUE,   -- matches service_category enum value
  display_name TEXT     NOT NULL,
  emoji        TEXT     NOT NULL DEFAULT '🔧',
  is_active    BOOLEAN  NOT NULL DEFAULT TRUE,
  sort_order   SMALLINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Seed all 20 services (alphabetical by display_name)
INSERT INTO public.service_types (slug, display_name, emoji, sort_order) VALUES
  ('hvac',               'AC & HVAC',              '❄️',   1),
  ('auto_servicing',     'Auto Servicing',          '🚗',   2),
  ('carpentry',          'Carpentry',               '🪚',   3),
  ('car_wash',           'Car Wash & Detailing',    '🚘',   4),
  ('child_patient_care', 'Child/Patient Care',      '👶',   5),
  ('cleaning',           'Cleaning & Domestic',     '🧹',   6),
  ('delivery',           'Delivery Services',       '📦',   7),
  ('electrical',         'Electrical',              '⚡',   8),
  ('general_contractor', 'General Contractor',      '👷',   9),
  ('handyman',           'Handy Man',               '🛠️',  10),
  ('lawn_garden',        'Lawn & Garden',           '🌿',  11),
  ('moving',             'Moving Services',         '🚚',  12),
  ('painting',           'Painting',                '🎨',  13),
  ('pest_control',       'Pest Control',            '🐛',  14),
  ('plumbing',           'Plumbing',                '🔧',  15),
  ('pool_maintenance',   'Pool Maintenance',        '🏊',  16),
  ('roofing',            'Roofing',                 '🏠',  17),
  ('security',           'Security Systems',        '🔒',  18),
  ('solar',              'Solar Installation',      '☀️',  19),
  ('tiling',             'Tiling & Masonry',        '🧱',  20)
ON CONFLICT (slug) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      emoji        = EXCLUDED.emoji,
      sort_order   = EXCLUDED.sort_order;

-- 4. Grant read access to the app role
GRANT SELECT ON public.service_types TO tendrit_app;

-- 5. RLS — publicly readable (service list is needed on unauthenticated pages)
ALTER TABLE public.service_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_types_public_read" ON public.service_types;
CREATE POLICY "service_types_public_read"
  ON public.service_types FOR SELECT USING (true);

-- 6. Add service_type_id to provider_services (nullable initially for backfill)
ALTER TABLE public.provider_services
  ADD COLUMN IF NOT EXISTS service_type_id UUID REFERENCES public.service_types(id);

-- 7. Remove any orphaned rows that can't be backfilled (safety net)
DELETE FROM public.provider_services ps
WHERE NOT EXISTS (
  SELECT 1 FROM public.service_types st WHERE st.slug = ps.category::text
);

-- 8. Backfill existing rows
UPDATE public.provider_services ps
SET service_type_id = st.id
FROM public.service_types st
WHERE st.slug = ps.category::text
  AND ps.service_type_id IS NULL;

-- 9. Enforce NOT NULL now that all rows are backfilled
ALTER TABLE public.provider_services
  ALTER COLUMN service_type_id SET NOT NULL;

-- 10. Index for FK lookups
CREATE INDEX IF NOT EXISTS idx_provider_services_type_id
  ON public.provider_services (service_type_id);
