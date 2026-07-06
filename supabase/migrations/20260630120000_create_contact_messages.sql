-- ============================================================
-- contact_messages — public "Contact Us" form submissions.
-- Inserted by the backend (superuser) from the public endpoint;
-- only admins may read/manage them (future Contact Inbox screen).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contact_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name  VARCHAR(100) NOT NULL,
    last_name   VARCHAR(100),
    email       VARCHAR(255) NOT NULL,
    role        VARCHAR(20),                 -- homeowner | provider | other (free text from the form)
    subject     VARCHAR(150) NOT NULL,
    message     TEXT NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'new',  -- new | read | resolved | archived
    trashed     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_status     ON public.contact_messages(status);
CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON public.contact_messages(created_at DESC);

-- ------------------------------------------------------------
-- RLS — admins only (inserts come from the backend as superuser)
-- ------------------------------------------------------------
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE, DELETE ON public.contact_messages TO tendrit_app;

DROP POLICY IF EXISTS "contact_select_admin" ON public.contact_messages;
DROP POLICY IF EXISTS "contact_update_admin" ON public.contact_messages;
DROP POLICY IF EXISTS "contact_delete_admin" ON public.contact_messages;

CREATE POLICY "contact_select_admin" ON public.contact_messages
  FOR SELECT USING (public.current_app_user_role() = 'admin');
CREATE POLICY "contact_update_admin" ON public.contact_messages
  FOR UPDATE USING (public.current_app_user_role() = 'admin');
CREATE POLICY "contact_delete_admin" ON public.contact_messages
  FOR DELETE USING (public.current_app_user_role() = 'admin');
