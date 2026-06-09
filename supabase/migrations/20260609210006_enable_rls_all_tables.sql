-- ============================================================
-- Row Level Security for all new TendrIt tables
--
-- Architecture (same as public.users):
--   - tendrit_app role: all protected queries use this role
--   - app.current_user_id: SET LOCAL per transaction in db.queryAsUser()
--   - current_app_user_role(): SECURITY DEFINER helper (already exists)
--   - postgres superuser: used only for admin/service-role operations
-- ============================================================

-- ------------------------------------------------------------
-- Grant permissions to tendrit_app for all new tables
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenders           TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tender_photos     TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quotes            TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reviews           TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_profiles TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_services TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_parishes TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions      TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.disputes          TO tendrit_app;

-- Future tables will auto-inherit via:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tendrit_app;


-- ============================================================
-- TENDERS
-- ============================================================
ALTER TABLE public.tenders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenders_insert"        ON public.tenders;
DROP POLICY IF EXISTS "tenders_select_open"   ON public.tenders;
DROP POLICY IF EXISTS "tenders_select_own"    ON public.tenders;
DROP POLICY IF EXISTS "tenders_select_admin"  ON public.tenders;
DROP POLICY IF EXISTS "tenders_update_own"    ON public.tenders;
DROP POLICY IF EXISTS "tenders_update_admin"  ON public.tenders;
DROP POLICY IF EXISTS "tenders_delete_own"    ON public.tenders;
DROP POLICY IF EXISTS "tenders_delete_admin"  ON public.tenders;

-- Homeowners can post tenders for themselves
CREATE POLICY "tenders_insert" ON public.tenders
  FOR INSERT WITH CHECK (
    client_id::text = current_setting('app.current_user_id', true)
    AND public.current_app_user_role() = 'homeowner'
  );

-- Anyone can see open tenders (provider browse)
CREATE POLICY "tenders_select_open" ON public.tenders
  FOR SELECT USING (status = 'open');

-- Homeowners can see all their own tenders regardless of status
CREATE POLICY "tenders_select_own" ON public.tenders
  FOR SELECT USING (
    client_id::text = current_setting('app.current_user_id', true)
  );

-- Admins can see all tenders
CREATE POLICY "tenders_select_admin" ON public.tenders
  FOR SELECT USING (public.current_app_user_role() = 'admin');

-- Homeowners can update their own open tenders
CREATE POLICY "tenders_update_own" ON public.tenders
  FOR UPDATE USING (
    client_id::text = current_setting('app.current_user_id', true)
    AND status = 'open'
  );

CREATE POLICY "tenders_update_admin" ON public.tenders
  FOR UPDATE USING (public.current_app_user_role() = 'admin');

-- Homeowners can delete their own open tenders
CREATE POLICY "tenders_delete_own" ON public.tenders
  FOR DELETE USING (
    client_id::text = current_setting('app.current_user_id', true)
    AND status = 'open'
  );

CREATE POLICY "tenders_delete_admin" ON public.tenders
  FOR DELETE USING (public.current_app_user_role() = 'admin');


-- ============================================================
-- TENDER_PHOTOS
-- ============================================================
ALTER TABLE public.tender_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tender_photos_insert" ON public.tender_photos;
DROP POLICY IF EXISTS "tender_photos_select" ON public.tender_photos;
DROP POLICY IF EXISTS "tender_photos_delete_own"   ON public.tender_photos;
DROP POLICY IF EXISTS "tender_photos_delete_admin" ON public.tender_photos;

-- Only the tender's client can add photos
CREATE POLICY "tender_photos_insert" ON public.tender_photos
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.tenders t
      WHERE t.id = tender_id
        AND t.client_id::text = current_setting('app.current_user_id', true)
    )
  );

-- Photos are public — they're shown on the browse page
CREATE POLICY "tender_photos_select" ON public.tender_photos
  FOR SELECT USING (true);

-- Tender's client can delete their own photos
CREATE POLICY "tender_photos_delete_own" ON public.tender_photos
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.tenders t
      WHERE t.id = tender_id
        AND t.client_id::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "tender_photos_delete_admin" ON public.tender_photos
  FOR DELETE USING (public.current_app_user_role() = 'admin');


-- ============================================================
-- QUOTES
-- ============================================================
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quotes_insert"        ON public.quotes;
DROP POLICY IF EXISTS "quotes_select_own_provider"  ON public.quotes;
DROP POLICY IF EXISTS "quotes_select_tender_client" ON public.quotes;
DROP POLICY IF EXISTS "quotes_select_admin"  ON public.quotes;
DROP POLICY IF EXISTS "quotes_update_own"    ON public.quotes;
DROP POLICY IF EXISTS "quotes_update_admin"  ON public.quotes;
DROP POLICY IF EXISTS "quotes_delete_own"    ON public.quotes;
DROP POLICY IF EXISTS "quotes_delete_admin"  ON public.quotes;

-- Providers can submit quotes for themselves
CREATE POLICY "quotes_insert" ON public.quotes
  FOR INSERT WITH CHECK (
    provider_id::text = current_setting('app.current_user_id', true)
    AND public.current_app_user_role() = 'provider'
  );

-- Providers can see their own quotes
CREATE POLICY "quotes_select_own_provider" ON public.quotes
  FOR SELECT USING (
    provider_id::text = current_setting('app.current_user_id', true)
  );

-- Homeowners can see all quotes on their own tenders
CREATE POLICY "quotes_select_tender_client" ON public.quotes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.tenders t
      WHERE t.id = tender_id
        AND t.client_id::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "quotes_select_admin" ON public.quotes
  FOR SELECT USING (public.current_app_user_role() = 'admin');

-- Providers can update their own quotes only while still pending
CREATE POLICY "quotes_update_own" ON public.quotes
  FOR UPDATE USING (
    provider_id::text = current_setting('app.current_user_id', true)
    AND status = 'pending'
  );

CREATE POLICY "quotes_update_admin" ON public.quotes
  FOR UPDATE USING (public.current_app_user_role() = 'admin');

-- Providers can delete their own pending quotes
CREATE POLICY "quotes_delete_own" ON public.quotes
  FOR DELETE USING (
    provider_id::text = current_setting('app.current_user_id', true)
    AND status = 'pending'
  );

CREATE POLICY "quotes_delete_admin" ON public.quotes
  FOR DELETE USING (public.current_app_user_role() = 'admin');


-- ============================================================
-- REVIEWS
-- ============================================================
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reviews_insert"       ON public.reviews;
DROP POLICY IF EXISTS "reviews_select"       ON public.reviews;
DROP POLICY IF EXISTS "reviews_update_admin" ON public.reviews;
DROP POLICY IF EXISTS "reviews_delete_admin" ON public.reviews;

-- Homeowners can leave reviews for their own completed jobs
CREATE POLICY "reviews_insert" ON public.reviews
  FOR INSERT WITH CHECK (
    client_id::text = current_setting('app.current_user_id', true)
    AND public.current_app_user_role() = 'homeowner'
  );

-- Reviews are public (trust signals for providers)
CREATE POLICY "reviews_select" ON public.reviews
  FOR SELECT USING (true);

CREATE POLICY "reviews_update_admin" ON public.reviews
  FOR UPDATE USING (public.current_app_user_role() = 'admin');

CREATE POLICY "reviews_delete_admin" ON public.reviews
  FOR DELETE USING (public.current_app_user_role() = 'admin');


-- ============================================================
-- PROVIDER_PROFILES
-- ============================================================
ALTER TABLE public.provider_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_profiles_insert"       ON public.provider_profiles;
DROP POLICY IF EXISTS "provider_profiles_select"       ON public.provider_profiles;
DROP POLICY IF EXISTS "provider_profiles_update_own"   ON public.provider_profiles;
DROP POLICY IF EXISTS "provider_profiles_update_admin" ON public.provider_profiles;
DROP POLICY IF EXISTS "provider_profiles_delete_admin" ON public.provider_profiles;

-- Providers create their own profile
CREATE POLICY "provider_profiles_insert" ON public.provider_profiles
  FOR INSERT WITH CHECK (
    provider_id::text = current_setting('app.current_user_id', true)
    AND public.current_app_user_role() = 'provider'
  );

-- Provider profiles are public (browsable by homeowners)
CREATE POLICY "provider_profiles_select" ON public.provider_profiles
  FOR SELECT USING (true);

-- Providers update their own profile
CREATE POLICY "provider_profiles_update_own" ON public.provider_profiles
  FOR UPDATE USING (
    provider_id::text = current_setting('app.current_user_id', true)
  );

-- Admins can update any profile (e.g. set is_verified = TRUE)
CREATE POLICY "provider_profiles_update_admin" ON public.provider_profiles
  FOR UPDATE USING (public.current_app_user_role() = 'admin');

CREATE POLICY "provider_profiles_delete_admin" ON public.provider_profiles
  FOR DELETE USING (public.current_app_user_role() = 'admin');


-- ============================================================
-- PROVIDER_SERVICES
-- ============================================================
ALTER TABLE public.provider_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_services_insert" ON public.provider_services;
DROP POLICY IF EXISTS "provider_services_select" ON public.provider_services;
DROP POLICY IF EXISTS "provider_services_delete" ON public.provider_services;

CREATE POLICY "provider_services_insert" ON public.provider_services
  FOR INSERT WITH CHECK (
    provider_id::text = current_setting('app.current_user_id', true)
  );

-- Public — used for category filtering on browse page
CREATE POLICY "provider_services_select" ON public.provider_services
  FOR SELECT USING (true);

CREATE POLICY "provider_services_delete" ON public.provider_services
  FOR DELETE USING (
    provider_id::text = current_setting('app.current_user_id', true)
  );


-- ============================================================
-- PROVIDER_PARISHES
-- ============================================================
ALTER TABLE public.provider_parishes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_parishes_insert" ON public.provider_parishes;
DROP POLICY IF EXISTS "provider_parishes_select" ON public.provider_parishes;
DROP POLICY IF EXISTS "provider_parishes_delete" ON public.provider_parishes;

CREATE POLICY "provider_parishes_insert" ON public.provider_parishes
  FOR INSERT WITH CHECK (
    provider_id::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY "provider_parishes_select" ON public.provider_parishes
  FOR SELECT USING (true);

CREATE POLICY "provider_parishes_delete" ON public.provider_parishes
  FOR DELETE USING (
    provider_id::text = current_setting('app.current_user_id', true)
  );


-- ============================================================
-- TRANSACTIONS
-- All writes go through the Express service role (bypasses RLS).
-- No INSERT/UPDATE policy needed for service role.
-- tendrit_app users (homeowners/providers) can only read their own.
-- ============================================================
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "transactions_select_own"  ON public.transactions;
DROP POLICY IF EXISTS "transactions_select_admin" ON public.transactions;

-- Homeowner and provider involved in the transaction can read it
CREATE POLICY "transactions_select_own" ON public.transactions
  FOR SELECT USING (
    client_id::text   = current_setting('app.current_user_id', true)
    OR provider_id::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY "transactions_select_admin" ON public.transactions
  FOR SELECT USING (public.current_app_user_role() = 'admin');


-- ============================================================
-- DISPUTES
-- Raised by a client or provider; only admin can resolve.
-- ============================================================
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "disputes_insert"        ON public.disputes;
DROP POLICY IF EXISTS "disputes_select_own"    ON public.disputes;
DROP POLICY IF EXISTS "disputes_select_admin"  ON public.disputes;
DROP POLICY IF EXISTS "disputes_update_admin"  ON public.disputes;

-- Client or provider in the transaction can open a dispute
CREATE POLICY "disputes_insert" ON public.disputes
  FOR INSERT WITH CHECK (
    raised_by::text = current_setting('app.current_user_id', true)
    AND (
      client_id::text   = current_setting('app.current_user_id', true)
      OR provider_id::text = current_setting('app.current_user_id', true)
    )
  );

-- Involved parties can see the dispute
CREATE POLICY "disputes_select_own" ON public.disputes
  FOR SELECT USING (
    client_id::text   = current_setting('app.current_user_id', true)
    OR provider_id::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY "disputes_select_admin" ON public.disputes
  FOR SELECT USING (public.current_app_user_role() = 'admin');

-- Only admin can update (resolve) disputes
CREATE POLICY "disputes_update_admin" ON public.disputes
  FOR UPDATE USING (public.current_app_user_role() = 'admin');
