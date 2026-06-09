-- ============================================================
-- New ENUM types for TendrIt core tables
-- ============================================================

-- Service categories (tenders.category + provider_services.category)
DO $$ BEGIN
  CREATE TYPE service_category AS ENUM (
    'lawn_garden', 'electrical', 'plumbing', 'painting', 'roofing',
    'pest_control', 'cleaning', 'carpentry', 'hvac', 'pool_maintenance',
    'solar', 'tiling', 'moving', 'security', 'auto', 'car_wash',
    'child_care', 'delivery', 'handyman', 'general_contractor', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tender lifecycle: open → in_progress (quote accepted) → completed
DO $$ BEGIN
  CREATE TYPE tender_status AS ENUM ('open', 'in_progress', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- How urgently the homeowner needs the work
DO $$ BEGIN
  CREATE TYPE tender_urgency AS ENUM ('emergency', 'urgent', 'soon', 'flexible', 'planning');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Quote lifecycle
DO $$ BEGIN
  CREATE TYPE quote_status AS ENUM ('pending', 'accepted', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Provider's promised completion timeline on a quote
DO $$ BEGIN
  CREATE TYPE quote_timeline AS ENUM (
    'same_day', 'next_day', '2_3_days', 'within_1_week', '1_2_weeks', '2_4_weeks'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Payment escrow state machine (NCB/WiPay → EFT payout cycle)
DO $$ BEGIN
  CREATE TYPE transaction_status AS ENUM (
    'held',           -- payment captured, funds held
    'payout_queued',  -- homeowner confirmed completion, queued for weekly EFT
    'completed',      -- EFT sent to provider
    'refunded',       -- refunded to homeowner
    'disputed'        -- admin intervention required
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Provider credential/identity verification status
DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
