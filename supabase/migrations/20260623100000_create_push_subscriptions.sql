-- Push subscriptions table for Web Push / VAPID notifications.
-- One row per browser/device subscription per user.
-- The endpoint is globally unique (issued by the browser vendor's push service).

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- Index for fast lookups when fanning out to all of a user's devices
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
    ON public.push_subscriptions(user_id);

-- Backend-only table — no RLS needed, never queried via anon key.
-- tendrit_app role handles all reads/writes through the Express API.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO tendrit_app;
