-- Update/Delete RLS policies previously restricted to status='open'.
-- Autosave needs to UPDATE draft rows, and homeowners must be able to DELETE drafts.

DROP POLICY IF EXISTS "tenders_update_own" ON public.tenders;
CREATE POLICY "tenders_update_own" ON public.tenders
  FOR UPDATE USING (
    client_id::text = current_setting('app.current_user_id', true)
    AND status IN ('draft', 'open')
  );

DROP POLICY IF EXISTS "tenders_delete_own" ON public.tenders;
CREATE POLICY "tenders_delete_own" ON public.tenders
  FOR DELETE USING (
    client_id::text = current_setting('app.current_user_id', true)
    AND status IN ('draft', 'open')
  );
