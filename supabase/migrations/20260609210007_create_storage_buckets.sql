-- ============================================================
-- Supabase Storage buckets for TendrIt
--
-- tender-media     : public — job photos + videos uploaded by homeowners
-- provider-portfolio : public — provider portfolio/work photos
-- provider-documents : PRIVATE — certs, insurance docs (admin/service role only)
--
-- All writes (upload/delete) go through the Express backend using
-- the service role key, which bypasses storage RLS.
-- Storage RLS policies here only control public read access.
-- ============================================================

-- tender-media: public bucket, 100MB limit (supports both photos and videos)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tender-media',
  'tender-media',
  true,
  104857600,  -- 100MB
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/quicktime', 'video/webm'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;


-- provider-portfolio: public bucket, 10MB photos only
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'provider-portfolio',
  'provider-portfolio',
  true,
  10485760,  -- 10MB
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;


-- provider-documents: PRIVATE bucket, 10MB, certs + insurance + PDFs
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'provider-documents',
  'provider-documents',
  false,  -- PRIVATE — service role key only
  10485760,  -- 10MB
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ============================================================
-- Storage RLS Policies on storage.objects
--
-- Public buckets: allow anyone to SELECT (read/download)
-- Private bucket: no policy — only service role key can access
-- No INSERT/UPDATE/DELETE policies — all writes use service role
-- ============================================================

-- tender-media: public read
DROP POLICY IF EXISTS "tender_media_public_select" ON storage.objects;
CREATE POLICY "tender_media_public_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'tender-media');

-- provider-portfolio: public read
DROP POLICY IF EXISTS "provider_portfolio_public_select" ON storage.objects;
CREATE POLICY "provider_portfolio_public_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'provider-portfolio');

-- provider-documents: NO policy — inaccessible without service role key
-- (any authenticated or anonymous user attempting SELECT is blocked by default)
