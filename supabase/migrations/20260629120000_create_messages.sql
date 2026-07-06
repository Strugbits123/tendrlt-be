-- ============================================================
-- messages — 1:1 chat scoped to a quote.
-- The quote IS the conversation (provider_id ↔ tender.client_id).
-- Only the two parties of the quote may read; only a party may send
-- (as themselves); only the recipient may mark messages read.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id      UUID NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    sender_id     UUID NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
    recipient_id  UUID NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
    body          TEXT NOT NULL,
    read          BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_quote_id        ON public.messages(quote_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_unread ON public.messages(recipient_id, read);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO tendrit_app;

DROP POLICY IF EXISTS "messages_select_parties"   ON public.messages;
DROP POLICY IF EXISTS "messages_insert_sender"    ON public.messages;
DROP POLICY IF EXISTS "messages_update_recipient" ON public.messages;
DROP POLICY IF EXISTS "messages_select_admin"     ON public.messages;

-- Helper: is the current user one of the quote's two parties?
-- (Inlined as EXISTS so it stays a pure RLS predicate — mirrors the
--  quotes_select_tender_client shape.)

-- Either party of the quote can read the conversation
CREATE POLICY "messages_select_parties" ON public.messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.quotes q
      JOIN public.tenders t ON t.id = q.tender_id
      WHERE q.id = quote_id
        AND (
          q.provider_id::text = current_setting('app.current_user_id', true)
          OR t.client_id::text = current_setting('app.current_user_id', true)
        )
    )
  );

-- A party may insert a message only AS THEMSELVES on their own quote
CREATE POLICY "messages_insert_sender" ON public.messages
  FOR INSERT WITH CHECK (
    sender_id::text = current_setting('app.current_user_id', true)
    AND EXISTS (
      SELECT 1 FROM public.quotes q
      JOIN public.tenders t ON t.id = q.tender_id
      WHERE q.id = quote_id
        AND (
          q.provider_id::text = current_setting('app.current_user_id', true)
          OR t.client_id::text = current_setting('app.current_user_id', true)
        )
    )
  );

-- Only the recipient can mark a message read
CREATE POLICY "messages_update_recipient" ON public.messages
  FOR UPDATE USING (
    recipient_id::text = current_setting('app.current_user_id', true)
  );

-- Admins may read all (dispute resolution)
CREATE POLICY "messages_select_admin" ON public.messages
  FOR SELECT USING (public.current_app_user_role() = 'admin');
