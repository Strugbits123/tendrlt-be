-- ============================================================
-- Human-readable serial IDs + tender expiry + admin soft-delete
--
-- 1. display_code on users (CLI-/PRV-/ADM-####) and tenders (TND-####),
--    auto-assigned via BEFORE-trigger from per-role sequences. Existing
--    rows are backfilled in created_at order so the serials feel natural.
-- 2. tenders.expiry_days — the homeowner-chosen lifespan (7/14/30/60/90).
--    tenders.expires_at (already existed, never populated) is set to
--    NOW() + expiry_days when a tender is published (status -> 'open').
-- 3. tenders.trashed_at — admin soft-delete (NULL = live). Trashed tenders
--    are hidden from browse/explore and can be restored or purged by admin.
-- ============================================================

-- ---- 1a. Sequences (one per code prefix) --------------------------------
CREATE SEQUENCE IF NOT EXISTS public.client_code_seq;
CREATE SEQUENCE IF NOT EXISTS public.provider_code_seq;
CREATE SEQUENCE IF NOT EXISTS public.admin_code_seq;
CREATE SEQUENCE IF NOT EXISTS public.tender_code_seq;

-- tender INSERTs run as tendrit_app (via db.queryAsUser -> SET LOCAL ROLE),
-- so the BEFORE-INSERT trigger's nextval() needs USAGE on these sequences.
-- (User INSERTs run as superuser via db.query, but grant all for future-proofing.)
GRANT USAGE ON SEQUENCE
  public.client_code_seq,
  public.provider_code_seq,
  public.admin_code_seq,
  public.tender_code_seq
TO tendrit_app;

-- ---- 1b. Columns --------------------------------------------------------
ALTER TABLE public.users   ADD COLUMN IF NOT EXISTS display_code TEXT UNIQUE;
ALTER TABLE public.tenders ADD COLUMN IF NOT EXISTS display_code TEXT UNIQUE;

-- ---- 2. Expiry ----------------------------------------------------------
ALTER TABLE public.tenders ADD COLUMN IF NOT EXISTS expiry_days SMALLINT;

-- ---- 3. Admin soft-delete ----------------------------------------------
ALTER TABLE public.tenders ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenders_expires_at ON public.tenders(expires_at);
CREATE INDEX IF NOT EXISTS idx_tenders_trashed_at ON public.tenders(trashed_at) WHERE trashed_at IS NOT NULL;

-- ---- 4. Backfill existing rows (before triggers exist) ------------------
-- Users: number contiguously within each role, oldest first.
WITH ordered AS (
  SELECT id, role,
         row_number() OVER (PARTITION BY role ORDER BY created_at, id) AS rn
  FROM public.users
  WHERE display_code IS NULL AND role IS NOT NULL
)
UPDATE public.users u
SET display_code = CASE o.role
    WHEN 'homeowner' THEN 'CLI-' || lpad(o.rn::text, 4, '0')
    WHEN 'provider'  THEN 'PRV-' || lpad(o.rn::text, 4, '0')
    WHEN 'admin'     THEN 'ADM-' || lpad(o.rn::text, 4, '0')
  END
FROM ordered o
WHERE u.id = o.id;

-- Tenders: number contiguously, oldest first.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM public.tenders
  WHERE display_code IS NULL
)
UPDATE public.tenders t
SET display_code = 'TND-' || lpad(o.rn::text, 4, '0')
FROM ordered o
WHERE t.id = o.id;

-- Advance each sequence to the MAX existing code number so the next
-- nextval() continues after it. Using MAX(suffix) rather than count(*)
-- keeps this safe to re-run (via `supabase db push`) even after inserts
-- or deletions — it can never rewind the sequence and mint a duplicate.
SELECT setval('public.client_code_seq',
  GREATEST((SELECT COALESCE(MAX(substring(display_code FROM 5)::int), 0) FROM public.users WHERE display_code LIKE 'CLI-%'), 1),
  (SELECT EXISTS (SELECT 1 FROM public.users WHERE display_code LIKE 'CLI-%')));
SELECT setval('public.provider_code_seq',
  GREATEST((SELECT COALESCE(MAX(substring(display_code FROM 5)::int), 0) FROM public.users WHERE display_code LIKE 'PRV-%'), 1),
  (SELECT EXISTS (SELECT 1 FROM public.users WHERE display_code LIKE 'PRV-%')));
SELECT setval('public.admin_code_seq',
  GREATEST((SELECT COALESCE(MAX(substring(display_code FROM 5)::int), 0) FROM public.users WHERE display_code LIKE 'ADM-%'), 1),
  (SELECT EXISTS (SELECT 1 FROM public.users WHERE display_code LIKE 'ADM-%')));
SELECT setval('public.tender_code_seq',
  GREATEST((SELECT COALESCE(MAX(substring(display_code FROM 5)::int), 0) FROM public.tenders WHERE display_code LIKE 'TND-%'), 1),
  (SELECT EXISTS (SELECT 1 FROM public.tenders WHERE display_code LIKE 'TND-%')));

-- ---- 5. Auto-assign triggers -------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_user_display_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.display_code IS NULL AND NEW.role IS NOT NULL THEN
    NEW.display_code := CASE NEW.role
        WHEN 'homeowner' THEN 'CLI-' || lpad(nextval('public.client_code_seq')::text,   4, '0')
        WHEN 'provider'  THEN 'PRV-' || lpad(nextval('public.provider_code_seq')::text, 4, '0')
        WHEN 'admin'     THEN 'ADM-' || lpad(nextval('public.admin_code_seq')::text,    4, '0')
      END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires on INSERT (role set at email/Google signup) and on UPDATE OF role
-- (Google users who set their role later at profile completion). The
-- display_code IS NULL guard means it only ever assigns once.
DROP TRIGGER IF EXISTS trg_users_display_code ON public.users;
CREATE TRIGGER trg_users_display_code
  BEFORE INSERT OR UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.assign_user_display_code();

CREATE OR REPLACE FUNCTION public.assign_tender_display_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.display_code IS NULL THEN
    NEW.display_code := 'TND-' || lpad(nextval('public.tender_code_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenders_display_code ON public.tenders;
CREATE TRIGGER trg_tenders_display_code
  BEFORE INSERT ON public.tenders
  FOR EACH ROW EXECUTE FUNCTION public.assign_tender_display_code();
