-- ============================================================
-- transactions — payment escrow state machine
--
-- Created when a homeowner accepts a quote.
-- All amounts in JMD cents (INTEGER).
-- Platform fee is 9.5% of amount (stored at creation time so
-- historical records are accurate if the fee rate ever changes).
--
-- Escrow flow:
--   1. Quote accepted → transaction created, status = 'held', ncb_transaction_ref stored
--   2. Homeowner confirms job complete → status = 'payout_queued', payout_queued_at set
--   3. Weekly EFT batch runs → status = 'completed', payout_batch_id + completed_at set
--   4. Dispute raised (any held/payout_queued state) → status = 'disputed'
--   5. Admin resolves → 'completed' or 'refunded'
-- ============================================================

CREATE TABLE IF NOT EXISTS public.transactions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id              UUID NOT NULL UNIQUE REFERENCES public.quotes(id) ON DELETE RESTRICT,
    tender_id             UUID NOT NULL REFERENCES public.tenders(id) ON DELETE RESTRICT,
    client_id             UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    provider_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    amount                INTEGER NOT NULL,
    platform_fee          INTEGER NOT NULL,
    provider_payout       INTEGER NOT NULL,
    ncb_transaction_ref   TEXT,
    payout_batch_id       TEXT,
    status                transaction_status NOT NULL DEFAULT 'held',
    collected_at          TIMESTAMP WITH TIME ZONE,
    payout_queued_at      TIMESTAMP WITH TIME ZONE,
    completed_at          TIMESTAMP WITH TIME ZONE,
    created_at            TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at            TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

DROP TRIGGER IF EXISTS update_transactions_updated_at ON public.transactions;
CREATE TRIGGER update_transactions_updated_at
    BEFORE UPDATE ON public.transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_transactions_client_id   ON public.transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_transactions_provider_id ON public.transactions(provider_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status      ON public.transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_tender_id   ON public.transactions(tender_id);


-- ============================================================
-- disputes — raised when a transaction is flagged as disputed
-- Transactions are never deleted; disputes are permanent audit records.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.disputes (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id    UUID NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
    raised_by         UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    client_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    provider_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    category          VARCHAR(50) NOT NULL,
    description       TEXT NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'open',
    resolution        VARCHAR(20),
    resolution_notes  TEXT,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    resolved_at       TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_disputes_transaction_id ON public.disputes(transaction_id);
CREATE INDEX IF NOT EXISTS idx_disputes_client_id      ON public.disputes(client_id);
CREATE INDEX IF NOT EXISTS idx_disputes_provider_id    ON public.disputes(provider_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status         ON public.disputes(status);
