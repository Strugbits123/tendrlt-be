-- ============================================================
-- provider_payment_details — banking / payout details for providers (1:1).
--
-- SECURITY MODEL
--   Unlike provider_profiles (which has a PUBLIC select policy so homeowners
--   can browse providers), this table is NEVER public. Payout data is visible
--   only to:
--     - the owning provider  (masked in the API layer — never full acct #)
--     - admins               (decrypted server-side for verification)
--
--   The two account identifiers (bank account number, ABA/routing number) are
--   ADDITIONALLY encrypted at the application layer with AES-256-GCM before they
--   ever reach the database (see tendrlt-be/lib/paymentCrypto.js). The DB only
--   ever holds ciphertext for those two columns, so a DB leak does not expose
--   account numbers. account_number_last4 is stored in clear ONLY to render the
--   masked "••••4321" readback to the provider.
--
--   The remaining fields (payee name, bank/branch/SWIFT/transit/address) are
--   semi-public banking directory data and are stored as plaintext, but still
--   guarded by the owner/admin-only RLS below.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.provider_payment_details (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id               UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,

    -- Account ownership
    account_ownership         VARCHAR(20)  NOT NULL DEFAULT 'personal', -- 'personal' | 'business'
    business_name             VARCHAR(200),                             -- required when ownership = business

    -- Payee (must match the name on the bank account)
    payee_first_name          VARCHAR(120) NOT NULL,
    payee_surname             VARCHAR(120) NOT NULL,

    -- Bank details (semi-public directory data — plaintext)
    bank_name                 VARCHAR(120) NOT NULL,   -- slug/key, e.g. 'ncb'
    bank_branch               VARCHAR(200),
    swift_code                VARCHAR(20),
    transit_code              VARCHAR(20),
    bank_address              TEXT,

    -- Account details
    account_type              VARCHAR(30)  NOT NULL,   -- 'savings' | 'chequing' | 'business' | 'other'
    currency                  VARCHAR(10)  NOT NULL DEFAULT 'jmd',

    -- Encrypted account identifiers (AES-256-GCM ciphertext, base64) — never plaintext
    account_number_encrypted  TEXT         NOT NULL,
    account_number_last4      VARCHAR(4),              -- clear, for masked readback only
    aba_routing_encrypted     TEXT,                    -- nullable — USD wires only

    created_at                TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at                TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

DROP TRIGGER IF EXISTS update_provider_payment_details_updated_at ON public.provider_payment_details;
CREATE TRIGGER update_provider_payment_details_updated_at
    BEFORE UPDATE ON public.provider_payment_details
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Row Level Security — owner + admin only (NOT public)
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_payment_details TO tendrit_app;

ALTER TABLE public.provider_payment_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_payment_insert"       ON public.provider_payment_details;
DROP POLICY IF EXISTS "provider_payment_select_own"   ON public.provider_payment_details;
DROP POLICY IF EXISTS "provider_payment_select_admin" ON public.provider_payment_details;
DROP POLICY IF EXISTS "provider_payment_update_own"   ON public.provider_payment_details;
DROP POLICY IF EXISTS "provider_payment_delete_admin" ON public.provider_payment_details;

-- Providers create their own payment row
CREATE POLICY "provider_payment_insert" ON public.provider_payment_details
  FOR INSERT WITH CHECK (
    provider_id::text = current_setting('app.current_user_id', true)
    AND public.current_app_user_role() = 'provider'
  );

-- A provider can read ONLY their own row (API masks the account number)
CREATE POLICY "provider_payment_select_own" ON public.provider_payment_details
  FOR SELECT USING (
    provider_id::text = current_setting('app.current_user_id', true)
  );

-- Admins can read any row (server decrypts for verification)
CREATE POLICY "provider_payment_select_admin" ON public.provider_payment_details
  FOR SELECT USING (public.current_app_user_role() = 'admin');

-- A provider can update only their own row
CREATE POLICY "provider_payment_update_own" ON public.provider_payment_details
  FOR UPDATE USING (
    provider_id::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY "provider_payment_delete_admin" ON public.provider_payment_details
  FOR DELETE USING (public.current_app_user_role() = 'admin');
