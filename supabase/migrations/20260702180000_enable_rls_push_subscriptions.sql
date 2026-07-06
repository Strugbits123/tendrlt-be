-- Fix Supabase "rls_disabled_in_public" advisory.
--
-- push_subscriptions is in the public schema, so it is reachable through
-- Supabase's auto REST API with the public anon key. With RLS off, that means
-- the subscription endpoints/keys could be read or written by anyone holding the
-- anon key. The Express backend accesses this table via the superuser service
-- connection (db.query), which BYPASSES RLS — so enabling RLS does not affect it.
-- Policies below also make it correct if access ever moves to the tendrit_app role.

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Owner-scoped policies (mirrors the notifications table).
DROP POLICY IF EXISTS "push_subscriptions_select_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_select_own" ON public.push_subscriptions
  FOR SELECT USING (
    user_id::text = current_setting('app.current_user_id', true)
  );

DROP POLICY IF EXISTS "push_subscriptions_insert_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_insert_own" ON public.push_subscriptions
  FOR INSERT WITH CHECK (
    user_id::text = current_setting('app.current_user_id', true)
  );

DROP POLICY IF EXISTS "push_subscriptions_update_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_update_own" ON public.push_subscriptions
  FOR UPDATE USING (
    user_id::text = current_setting('app.current_user_id', true)
  );

DROP POLICY IF EXISTS "push_subscriptions_delete_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_delete_own" ON public.push_subscriptions
  FOR DELETE USING (
    user_id::text = current_setting('app.current_user_id', true)
  );
