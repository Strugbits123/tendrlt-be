-- ============================================================
-- Platform fee configuration + change history (audit trail).
--
-- platform_fee_config is a single-row table holding the CURRENT active
-- client/provider fee percentages. fee_change_history is an append-only audit
-- log of every change (and rollback). Both are written by the backend as
-- superuser (db.query, bypasses RLS); the public app reads the current rates
-- through GET /api/fees (backend), never via the anon key. RLS is enabled so
-- the tables are not exposed through Supabase's public REST API.
-- ============================================================

-- ---- Current active configuration (singleton) --------------------------
CREATE TABLE IF NOT EXISTS public.platform_fee_config (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    client_rate      NUMERIC(5,2) NOT NULL,
    provider_rate    NUMERIC(5,2) NOT NULL,
    client_effective DATE,
    provider_effective DATE,
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT TIMEZONE('utc', NOW())
);

-- Seed the single row with today's live defaults (matches lib/fees.ts fallback).
INSERT INTO public.platform_fee_config (id, client_rate, provider_rate, client_effective, provider_effective)
VALUES (1, 9.5, 12, CURRENT_DATE, CURRENT_DATE)
ON CONFLICT (id) DO NOTHING;

-- ---- Append-only change history ---------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.fee_change_code_seq;

CREATE TABLE IF NOT EXISTS public.fee_change_history (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          TEXT UNIQUE NOT NULL,                        -- FCH-####
    type          TEXT NOT NULL CHECK (type IN ('client', 'provider', 'both')),
    old_client    NUMERIC(5,2) NOT NULL,
    old_provider  NUMERIC(5,2) NOT NULL,
    new_client    NUMERIC(5,2) NOT NULL,
    new_provider  NUMERIC(5,2) NOT NULL,
    effective     DATE,
    reason        TEXT,
    changed_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_fee_change_history_created_at ON public.fee_change_history(created_at DESC);

-- Seed an initial "launch" entry so the screen + rollback have a baseline.
INSERT INTO public.fee_change_history (code, type, old_client, old_provider, new_client, new_provider, effective, reason, status)
SELECT 'FCH-' || lpad(nextval('public.fee_change_code_seq')::text, 3, '0'),
       'both', 0, 0, 9.5, 12, CURRENT_DATE, 'Initial platform fee structure', 'active'
WHERE NOT EXISTS (SELECT 1 FROM public.fee_change_history);

-- ---- RLS (admin-only; backend superuser bypasses) ---------------------
ALTER TABLE public.platform_fee_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_change_history  ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.platform_fee_config TO tendrit_app;
GRANT SELECT, INSERT, UPDATE ON public.fee_change_history  TO tendrit_app;
GRANT USAGE ON SEQUENCE public.fee_change_code_seq TO tendrit_app;

DROP POLICY IF EXISTS "fee_config_select_admin" ON public.platform_fee_config;
DROP POLICY IF EXISTS "fee_config_update_admin" ON public.platform_fee_config;
CREATE POLICY "fee_config_select_admin" ON public.platform_fee_config
  FOR SELECT USING (public.current_app_user_role() = 'admin');
CREATE POLICY "fee_config_update_admin" ON public.platform_fee_config
  FOR UPDATE USING (public.current_app_user_role() = 'admin');

DROP POLICY IF EXISTS "fee_history_select_admin" ON public.fee_change_history;
DROP POLICY IF EXISTS "fee_history_insert_admin" ON public.fee_change_history;
DROP POLICY IF EXISTS "fee_history_update_admin" ON public.fee_change_history;
CREATE POLICY "fee_history_select_admin" ON public.fee_change_history
  FOR SELECT USING (public.current_app_user_role() = 'admin');
CREATE POLICY "fee_history_insert_admin" ON public.fee_change_history
  FOR INSERT WITH CHECK (public.current_app_user_role() = 'admin');
CREATE POLICY "fee_history_update_admin" ON public.fee_change_history
  FOR UPDATE USING (public.current_app_user_role() = 'admin');
