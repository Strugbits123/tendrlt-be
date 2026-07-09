-- ============================================================
-- Make all media buckets PRIVATE so media is only reachable via short-lived
-- signed URLs (generated server-side in lib/storageUrls.js), never public URLs.
--
-- provider-documents is already private. tender-media (tender photos/videos +
-- dispute evidence) and provider-portfolio were public — flip them. All
-- server code now generates signed URLs; uploads/deletes use the service key
-- which bypasses bucket visibility, so nothing else changes.
-- ============================================================

UPDATE storage.buckets
   SET public = false
 WHERE id IN ('tender-media', 'provider-portfolio');
