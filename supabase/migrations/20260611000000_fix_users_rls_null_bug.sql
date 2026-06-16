-- ============================================================
-- Fix: users RLS policies silently returning 0 rows
--
-- Root cause: current_setting('app.current_user_id', true) returns
-- NULL when the setting is not yet set. In SQL, `id = NULL` evaluates
-- to NULL (not FALSE), so no rows ever matched — causing the
-- "Invalid session. User not found." error for new users going
-- through the email-verify or Google OAuth flows.
--
-- Fix: add an explicit NULL guard so the policy correctly returns
-- false (no access) when the setting is absent, and correctly
-- matches the user's own row when it is present.
-- ============================================================

-- SELECT: a user can read their own row
DROP POLICY IF EXISTS "users_select_own" ON public.users;
CREATE POLICY "users_select_own" ON public.users
  FOR SELECT
  USING (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND id::text = current_setting('app.current_user_id', true)
  );

-- UPDATE: a user can update their own row
DROP POLICY IF EXISTS "users_update_own" ON public.users;
CREATE POLICY "users_update_own" ON public.users
  FOR UPDATE
  USING (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND id::text = current_setting('app.current_user_id', true)
  );
