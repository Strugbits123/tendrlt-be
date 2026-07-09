-- ============================================================
-- Let a provider SELECT any tender they've quoted on (any status).
--
-- Problem: the provider tenders RLS was `status = 'open'` only
-- (tenders_select_open). Once a homeowner accepts a quote, the tender moves to
-- 'in_progress' (and later 'completed'), so the winning provider could no
-- longer SELECT it via db.queryAsUser. That silently dropped their accepted
-- quote from GET /api/quotes/mine (Won/Completed showed empty) and 404'd the
-- winner's tender-detail (GET /api/tenders/browse/:id).
--
-- Fix: add a SELECT policy granting access to tenders the current provider has
-- a quote on. We use a SECURITY DEFINER helper so the quotes lookup bypasses
-- RLS — a plain EXISTS subquery on public.quotes would re-trigger the quotes
-- policies (one of which references public.tenders), risking RLS recursion.
--
-- App-level query filters are unchanged, so this does NOT leak non-open tenders
-- into the provider browse LIST (that query still has WHERE t.status = 'open');
-- it only restores access for the provider's own quoted tenders. Column-level
-- PII masking (location/contact) is still enforced in the Express layer.
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_has_quote_on(p_tender_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.quotes q
    WHERE q.tender_id = p_tender_id
      AND q.provider_id::text = current_setting('app.current_user_id', true)
  );
$$;

GRANT EXECUTE ON FUNCTION public.current_user_has_quote_on(uuid) TO tendrit_app;

DROP POLICY IF EXISTS "tenders_select_quoted" ON public.tenders;
CREATE POLICY "tenders_select_quoted" ON public.tenders
  FOR SELECT USING (public.current_user_has_quote_on(id));
