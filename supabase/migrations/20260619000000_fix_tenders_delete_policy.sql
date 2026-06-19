-- Migration: replace the overly-restrictive tenders_delete_own policy.
--
-- Old policy only allowed deleting tenders with status = 'open', which blocked
-- draft deletion. The new policy allows deleting any owned tender UNLESS a quote
-- has already been accepted for that tender (the job is effectively in progress).
--
-- Rollback: re-create the original policy at the bottom.

-- ── UP ──────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenders_delete_own" ON public.tenders;

-- Homeowners can delete any of their own tenders, provided no quote has been
-- accepted yet. Once a quote is accepted the tender is locked from deletion.
CREATE POLICY "tenders_delete_own" ON public.tenders
  FOR DELETE
  TO tendrit_app
  USING (
    client_id::text = current_setting('app.current_user_id', true)
    AND NOT EXISTS (
      SELECT 1
      FROM public.quotes q
      WHERE q.tender_id = id          -- 'id' resolves to the current tenders row
        AND q.status = 'accepted'
    )
  );

-- ── DOWN (rollback) ──────────────────────────────────────────────────────────
-- To rollback, run:
--
--   DROP POLICY IF EXISTS "tenders_delete_own" ON public.tenders;
--
--   CREATE POLICY "tenders_delete_own" ON public.tenders
--     FOR DELETE USING (
--       client_id::text = current_setting('app.current_user_id', true)
--       AND status = 'open'
--     );
