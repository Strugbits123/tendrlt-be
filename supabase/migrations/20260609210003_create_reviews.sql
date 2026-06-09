-- ============================================================
-- reviews — star ratings left by homeowners after job completion
-- One review per job per homeowner (unique on tender_id + client_id).
-- Reviews are public — anyone can read them (trust signals).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reviews (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tender_id    UUID NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
    quote_id     UUID NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    client_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment      TEXT,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,

    CONSTRAINT uq_reviews_tender_client UNIQUE (tender_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_provider_id ON public.reviews(provider_id);
CREATE INDEX IF NOT EXISTS idx_reviews_client_id   ON public.reviews(client_id);
CREATE INDEX IF NOT EXISTS idx_reviews_tender_id   ON public.reviews(tender_id);
