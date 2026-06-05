-- ============================================================
-- Row Level Security setup for TendrIt
--
-- Architecture:
--   - postgres (superuser) is used ONLY for auth operations
--     (login, register, verify-email) — it bypasses RLS.
--   - tendrit_app (non-superuser) is used for all protected
--     queries. RLS is enforced on this role.
--   - app.current_user_id is set per-transaction via SET LOCAL
--     so it is safely reset between pooled connections.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Create non-superuser app role
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_roles WHERE rolname = 'tendrit_app'
  ) THEN
    CREATE ROLE tendrit_app NOINHERIT NOLOGIN;
  END IF;
END $$;

-- Grant schema + table access to tendrit_app
GRANT USAGE ON SCHEMA public TO tendrit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tendrit_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tendrit_app;

-- Allow postgres to switch into tendrit_app
GRANT tendrit_app TO postgres;

-- ------------------------------------------------------------
-- 2. Helper function — get the current app user's role
--    Runs as SECURITY DEFINER (postgres) so it bypasses RLS
--    when checking the requesting user's role for admin policies.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_app_user_role()
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT role::text
  FROM public.users
  WHERE id::text = current_setting('app.current_user_id', true);
$$;

-- ------------------------------------------------------------
-- 3. Enable RLS on users table
-- ------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- DROP existing policies if re-running
DROP POLICY IF EXISTS "users_insert"        ON public.users;
DROP POLICY IF EXISTS "users_select_own"    ON public.users;
DROP POLICY IF EXISTS "users_select_admin"  ON public.users;
DROP POLICY IF EXISTS "users_update_own"    ON public.users;
DROP POLICY IF EXISTS "users_update_admin"  ON public.users;
DROP POLICY IF EXISTS "users_delete_admin"  ON public.users;

-- INSERT: always allowed — registration has no user context yet
CREATE POLICY "users_insert" ON public.users
  FOR INSERT
  WITH CHECK (true);

-- SELECT: a user can read their own row
CREATE POLICY "users_select_own" ON public.users
  FOR SELECT
  USING (
    id::text = current_setting('app.current_user_id', true)
  );

-- SELECT: admins can read all rows
CREATE POLICY "users_select_admin" ON public.users
  FOR SELECT
  USING (
    public.current_app_user_role() = 'admin'
  );

-- UPDATE: a user can update their own row
CREATE POLICY "users_update_own" ON public.users
  FOR UPDATE
  USING (
    id::text = current_setting('app.current_user_id', true)
  );

-- UPDATE: admins can update any row
CREATE POLICY "users_update_admin" ON public.users
  FOR UPDATE
  USING (
    public.current_app_user_role() = 'admin'
  );

-- DELETE: admins only
CREATE POLICY "users_delete_admin" ON public.users
  FOR DELETE
  USING (
    public.current_app_user_role() = 'admin'
  );
