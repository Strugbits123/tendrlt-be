-- ============================================================
-- quotes — provider proposals on open tenders
--
-- amount is INTEGER in JMD cents.
-- One quote per provider per tender (unique constraint).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.quotes (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tender_id             UUID NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
    provider_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    amount                INTEGER NOT NULL,
    estimated_days        INTEGER,
    timeline              quote_timeline NOT NULL,
    preferred_start_date  DATE,
    message               TEXT NOT NULL,
    what_is_included      TEXT,
    status                quote_status NOT NULL DEFAULT 'pending',
    created_at            TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at            TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,

    CONSTRAINT uq_quotes_tender_provider UNIQUE (tender_id, provider_id)
);

DROP TRIGGER IF EXISTS update_quotes_updated_at ON public.quotes;
CREATE TRIGGER update_quotes_updated_at
    BEFORE UPDATE ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_quotes_tender_id   ON public.quotes(tender_id);
CREATE INDEX IF NOT EXISTS idx_quotes_provider_id ON public.quotes(provider_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status      ON public.quotes(status);
