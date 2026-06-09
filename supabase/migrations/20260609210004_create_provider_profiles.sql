-- ============================================================
-- provider_profiles — extended data for provider accounts (1:1 with users)
-- is_verified is set to TRUE by admin after manual credential review.
-- Unverified providers can browse tenders but cannot have quotes accepted.
--
-- provider_services — service categories a provider offers (multi-select)
-- provider_parishes — parishes a provider covers (multi-select)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.provider_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id         UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
    bio                 TEXT,
    business_name       VARCHAR(150),
    years_experience    VARCHAR(20),
    availability        VARCHAR(100),
    typical_price_min   INTEGER,
    typical_price_max   INTEGER,
    languages           TEXT[],
    portfolio_link      TEXT,
    is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

DROP TRIGGER IF EXISTS update_provider_profiles_updated_at ON public.provider_profiles;
CREATE TRIGGER update_provider_profiles_updated_at
    BEFORE UPDATE ON public.provider_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_provider_profiles_is_verified ON public.provider_profiles(is_verified);


-- ============================================================
-- provider_services
-- ============================================================

CREATE TABLE IF NOT EXISTS public.provider_services (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    category     service_category NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,

    CONSTRAINT uq_provider_services UNIQUE (provider_id, category)
);

CREATE INDEX IF NOT EXISTS idx_provider_services_provider_id ON public.provider_services(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_services_category    ON public.provider_services(category);


-- ============================================================
-- provider_parishes
-- ============================================================

CREATE TABLE IF NOT EXISTS public.provider_parishes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    parish       VARCHAR(100) NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,

    CONSTRAINT uq_provider_parishes UNIQUE (provider_id, parish)
);

CREATE INDEX IF NOT EXISTS idx_provider_parishes_provider_id ON public.provider_parishes(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_parishes_parish       ON public.provider_parishes(parish);
