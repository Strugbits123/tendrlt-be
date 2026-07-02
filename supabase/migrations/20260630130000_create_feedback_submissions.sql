-- ============================================================
-- feedback_submissions — public Feedback form submissions
-- (feedback / bug / idea / other). Inserted by the backend
-- (superuser) from the public endpoint; admin-readable only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.feedback_submissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cat         VARCHAR(20) NOT NULL,                -- feedback | bug | idea | other
    name        VARCHAR(150) NOT NULL,
    email       VARCHAR(255) NOT NULL,
    role        VARCHAR(20),                         -- client | provider | visitor | other
    rating      SMALLINT,                            -- 1–5 (feedback only), else NULL
    follow_up   BOOLEAN NOT NULL DEFAULT true,
    message     TEXT NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'new',  -- new | read | resolved | archived
    trashed     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_status     ON public.feedback_submissions(status);
CREATE INDEX IF NOT EXISTS idx_feedback_cat        ON public.feedback_submissions(cat);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON public.feedback_submissions(created_at DESC);

-- ------------------------------------------------------------
-- RLS — admins only (inserts come from the backend as superuser)
-- ------------------------------------------------------------
ALTER TABLE public.feedback_submissions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE, DELETE ON public.feedback_submissions TO tendrit_app;

DROP POLICY IF EXISTS "feedback_select_admin" ON public.feedback_submissions;
DROP POLICY IF EXISTS "feedback_update_admin" ON public.feedback_submissions;
DROP POLICY IF EXISTS "feedback_delete_admin" ON public.feedback_submissions;

CREATE POLICY "feedback_select_admin" ON public.feedback_submissions
  FOR SELECT USING (public.current_app_user_role() = 'admin');
CREATE POLICY "feedback_update_admin" ON public.feedback_submissions
  FOR UPDATE USING (public.current_app_user_role() = 'admin');
CREATE POLICY "feedback_delete_admin" ON public.feedback_submissions
  FOR DELETE USING (public.current_app_user_role() = 'admin');
