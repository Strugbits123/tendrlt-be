-- ============================================================
-- tenders — job postings by homeowners
-- tender_photos — Supabase Storage paths for tender images/videos
--
-- Money columns (budget_min, budget_max) are INTEGER in JMD cents.
-- Example: $5,000 JMD = 500000
--
-- Location (location_lat, location_lng) is stored here but the
-- Express API strips it from responses unless the requester is
-- the tender's client or a provider with an accepted quote.
-- Postgres RLS is row-level only and cannot mask individual columns.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title               VARCHAR(150) NOT NULL,
    category            service_category NOT NULL,
    description         TEXT,
    parish              VARCHAR(100) NOT NULL,
    location_lat        DECIMAL(10,8),
    location_lng        DECIMAL(11,8),
    budget_min          INTEGER,
    budget_max          INTEGER,
    status              tender_status NOT NULL DEFAULT 'open',
    urgency             tender_urgency NOT NULL DEFAULT 'flexible',
    preferred_start_date DATE,
    photos_count        SMALLINT NOT NULL DEFAULT 0,
    quotes_count        SMALLINT NOT NULL DEFAULT 0,
    expires_at          TIMESTAMP WITH TIME ZONE,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

DROP TRIGGER IF EXISTS update_tenders_updated_at ON public.tenders;
CREATE TRIGGER update_tenders_updated_at
    BEFORE UPDATE ON public.tenders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_tenders_client_id  ON public.tenders(client_id);
CREATE INDEX IF NOT EXISTS idx_tenders_status      ON public.tenders(status);
CREATE INDEX IF NOT EXISTS idx_tenders_category    ON public.tenders(category);
CREATE INDEX IF NOT EXISTS idx_tenders_parish      ON public.tenders(parish);
CREATE INDEX IF NOT EXISTS idx_tenders_created_at  ON public.tenders(created_at DESC);


-- ============================================================
-- tender_photos — one row per photo/video attached to a tender
-- storage_path is the Supabase Storage object path (bucket: tender-media)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tender_photos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tender_id       UUID NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
    storage_path    TEXT NOT NULL,
    display_order   SMALLINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tender_photos_tender_id ON public.tender_photos(tender_id);
