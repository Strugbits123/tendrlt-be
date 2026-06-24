-- ============================================================
-- notifications — persistent in-app notification center
-- ============================================================

CREATE TABLE IF NOT EXISTS public.notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    data        JSONB DEFAULT '{}'::jsonb,
    read        BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id    ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read       ON public.notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at DESC);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO tendrit_app;

DROP POLICY IF EXISTS "notifications_select_own"  ON public.notifications;
DROP POLICY IF EXISTS "notifications_update_own"  ON public.notifications;
DROP POLICY IF EXISTS "notifications_delete_own"  ON public.notifications;

-- Users can only see their own notifications
CREATE POLICY "notifications_select_own" ON public.notifications
  FOR SELECT USING (
    user_id::text = current_setting('app.current_user_id', true)
  );

-- Users can mark their own notifications as read
CREATE POLICY "notifications_update_own" ON public.notifications
  FOR UPDATE USING (
    user_id::text = current_setting('app.current_user_id', true)
  );

-- Users can delete their own notifications
CREATE POLICY "notifications_delete_own" ON public.notifications
  FOR DELETE USING (
    user_id::text = current_setting('app.current_user_id', true)
  );
