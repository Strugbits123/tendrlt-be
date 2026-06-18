-- Add 'draft' to the tender_status enum
-- Tenders now default to 'draft'; status changes to 'open' only on explicit submit.
ALTER TYPE public.tender_status ADD VALUE IF NOT EXISTS 'draft';

-- New tenders start as drafts
ALTER TABLE public.tenders ALTER COLUMN status SET DEFAULT 'draft';
