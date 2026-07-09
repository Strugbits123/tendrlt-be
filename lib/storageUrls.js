/**
 * Signed-URL helpers for Supabase Storage.
 *
 * All media (tender photos/videos, dispute evidence, provider docs) lives in
 * PRIVATE buckets and must be served as short-lived signed URLs — never public
 * URLs. Generate these at request time (they expire); never persist them.
 */

// Default lifetime for in-app media links (1 hour). The page loads the media
// immediately; a refetch mints fresh URLs.
const DEFAULT_TTL_SECONDS = 60 * 60;
// Longer lifetime for links embedded in emails, which are opened later.
const EMAIL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Sign a single storage object path. Returns the signed URL, or null on error
 * / missing path (callers should treat null as "no media").
 */
async function signedUrl(supabase, bucket, path, expiresIn = DEFAULT_TTL_SECONDS) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) {
    if (error) console.warn(`[storageUrls] sign failed (${bucket}/${path}):`, error.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * Batch-sign many paths in one call. Returns a { path: signedUrl } map; paths
 * that fail to sign are simply absent from the map.
 */
async function signedUrlMap(supabase, bucket, paths, expiresIn = DEFAULT_TTL_SECONDS) {
  const map = {};
  const list = (paths || []).filter(Boolean);
  if (list.length === 0) return map;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(list, expiresIn);
  if (error || !Array.isArray(data)) {
    if (error) console.warn(`[storageUrls] batch sign failed (${bucket}):`, error.message);
    return map;
  }
  for (const item of data) {
    if (item?.signedUrl && !item.error && item.path) map[item.path] = item.signedUrl;
  }
  return map;
}

module.exports = { signedUrl, signedUrlMap, DEFAULT_TTL_SECONDS, EMAIL_TTL_SECONDS };
