const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const supabase = require('../lib/supabaseClient');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyChannel } = require('../lib/realtimeService');
const { sendNewProviderSubmittedEmail } = require('../lib/verificationEmails');

const router = express.Router();

// Memory storage — file bytes held in RAM briefly, then streamed to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 104857600 }, // 100 MB max
});

// Map onboarding docType keys → Supabase bucket + Storage path prefix
const BUCKETS = {
  insurance:    'provider-documents',
  trade_cert:   'provider-documents',
  business_reg: 'provider-documents',
  gov_id:       'provider-documents',
  portfolio:    'provider-portfolio',
};

const VALID_DOC_TYPES = Object.keys(BUCKETS).filter(k => k !== 'portfolio');

// ============================================================
// GET /api/providers/me
// Returns full profile + services + parishes for the logged-in provider.
// Used on onboarding page mount to restore form state after refresh.
// ============================================================
router.get('/me', authenticate, authorize('provider'), async (req, res) => {
  try {
    // Single query + single transaction instead of 3 separate queryAsUser calls.
    // Before: 3 × 5 = 15 DB round trips.  After: 3 round trips total.
    // Wrap array_agg results in json_agg so pg parses them as JS arrays,
    // not raw PostgreSQL array strings (which happens inside scalar subqueries).
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        (SELECT to_json(p.*) FROM public.provider_profiles p WHERE p.provider_id = $1) AS profile,
        (
          SELECT COALESCE(json_agg(s.category::text ORDER BY s.created_at), '[]'::json)
          FROM public.provider_services s WHERE s.provider_id = $1
        ) AS services,
        (
          SELECT COALESCE(json_agg(pa.parish ORDER BY pa.created_at), '[]'::json)
          FROM public.provider_parishes pa WHERE pa.provider_id = $1
        ) AS parishes
    `, [req.user.id]);

    const row = result.rows[0];
    res.json({
      success: true,
      profile:  row.profile  || null,
      services: row.services || [],
      parishes: row.parishes || [],
      user: {
        first_name:       req.user.first_name,
        last_name:        req.user.last_name,
        phone_number:     req.user.phone_number,
        parish:           req.user.parish,
        provider_service: req.user.provider_service,
      },
    });
  } catch (err) {
    console.error('GET /api/providers/me error:', err);
    res.status(500).json({ success: false, message: 'Failed to load profile.' });
  }
});

// ============================================================
// PUT /api/providers/profile
// Upserts provider_profiles row.
// Uses COALESCE so partial updates (e.g. only portfolio_link) do not
// overwrite previously saved fields with null.
// Also updates users.phone_number if phone_number is provided.
// ============================================================
router.put('/profile', authenticate, authorize('provider'), async (req, res) => {
  const {
    bio,
    business_name,
    years_experience,
    typical_price_min,
    typical_price_max,
    portfolio_link,
    phone_number,
  } = req.body;

  try {
    await db.queryAsUser(req.user.id,
      `INSERT INTO public.provider_profiles
         (provider_id, bio, business_name, years_experience, typical_price_min, typical_price_max, portfolio_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider_id) DO UPDATE
         SET bio                = COALESCE($2,   provider_profiles.bio),
             business_name      = COALESCE($3,   provider_profiles.business_name),
             years_experience   = COALESCE($4,   provider_profiles.years_experience),
             typical_price_min  = COALESCE($5,   provider_profiles.typical_price_min),
             typical_price_max  = COALESCE($6,   provider_profiles.typical_price_max),
             portfolio_link     = COALESCE($7,   provider_profiles.portfolio_link),
             updated_at         = NOW()`,
      [
        req.user.id,
        bio             ?? null,
        business_name   ?? null,
        years_experience ?? null,
        typical_price_min != null ? Number(typical_price_min) : null,
        typical_price_max != null ? Number(typical_price_max) : null,
        portfolio_link  ?? null,
      ]
    );

    if (phone_number) {
      await db.queryAsUser(req.user.id,
        `UPDATE public.users SET phone_number = $1, updated_at = NOW() WHERE id = $2`,
        [phone_number, req.user.id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/providers/profile error:', err);
    res.status(500).json({ success: false, message: 'Failed to save profile.' });
  }
});

// ============================================================
// PUT /api/providers/services
// Atomically replaces all services for this provider using a
// data-modifying CTE (DELETE + INSERT in one statement).
// ============================================================
// PUT /api/providers/services
// Accepts optional price range fields alongside categories so the frontend
// can save step 2 (services + price) in a single request instead of two.
router.put('/services', authenticate, authorize('provider'), async (req, res) => {
  const { categories, typical_price_min, typical_price_max } = req.body;

  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one service category is required.' });
  }

  const priceMin = typical_price_min != null ? Number(typical_price_min) : null;
  const priceMax = typical_price_max != null ? Number(typical_price_max) : null;

  try {
    // Three sequential statements in one transaction.
    // DELETE then INSERT as separate statements (not a CTE) so the INSERT
    // sees the committed DELETE — avoids unique-constraint conflicts when
    // re-saving a category that was already in the table.
    // DISTINCT on UNNEST guards against duplicate values in the input array.
    await db.queryAsUserBatch(req.user.id, [
      {
        text:   `DELETE FROM public.provider_services WHERE provider_id = $1`,
        params: [req.user.id],
      },
      {
        // categories are TEXT slugs from the frontend; cast to enum + join for service_type_id
        text: `INSERT INTO public.provider_services (provider_id, category, service_type_id)
               SELECT $1, cat::service_category, st.id
               FROM (SELECT DISTINCT UNNEST($2::text[]) AS cat) t
               JOIN public.service_types st ON st.slug = t.cat`,
        params: [req.user.id, categories],
      },
      {
        text: `INSERT INTO public.provider_profiles (provider_id, typical_price_min, typical_price_max)
               VALUES ($1, $2, $3)
               ON CONFLICT (provider_id) DO UPDATE
                 SET typical_price_min = COALESCE($2, provider_profiles.typical_price_min),
                     typical_price_max = COALESCE($3, provider_profiles.typical_price_max),
                     updated_at        = NOW()`,
        params: [req.user.id, priceMin, priceMax],
      },
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/providers/services error:', err);
    res.status(500).json({ success: false, message: 'Failed to save services.' });
  }
});

// ============================================================
// PUT /api/providers/parishes
// Atomically replaces all parishes for this provider.
// ============================================================
router.put('/parishes', authenticate, authorize('provider'), async (req, res) => {
  const { parishes } = req.body;

  if (!Array.isArray(parishes) || parishes.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one parish is required.' });
  }

  try {
    await db.queryAsUserBatch(req.user.id, [
      {
        text:   `DELETE FROM public.provider_parishes WHERE provider_id = $1`,
        params: [req.user.id],
      },
      {
        text: `INSERT INTO public.provider_parishes (provider_id, parish)
               SELECT $1, parish FROM (SELECT DISTINCT UNNEST($2::text[]) AS parish) t`,
        params: [req.user.id, parishes],
      },
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/providers/parishes error:', err);
    res.status(500).json({ success: false, message: 'Failed to save parishes.' });
  }
});

// ============================================================
// POST /api/providers/upload/document
// Accepts multipart/form-data with fields: file, docType
// Uploads to provider-documents bucket (private), stores path in
// provider_profiles.documents JSONB.
// ============================================================
router.post('/upload/document',
  authenticate,
  authorize('provider'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided.' });
    }

    const { docType } = req.body;
    if (!VALID_DOC_TYPES.includes(docType)) {
      return res.status(400).json({ success: false, message: 'Invalid document type.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.bin';
    const storagePath = `${req.user.id}/${docType}/${Date.now()}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('provider-documents')
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return res.status(500).json({ success: false, message: 'File upload failed.' });
    }

    try {
      await db.queryAsUser(req.user.id,
        `INSERT INTO public.provider_profiles (provider_id, documents)
         VALUES ($1, jsonb_build_object($2::text, $3::text))
         ON CONFLICT (provider_id) DO UPDATE
           SET documents  = provider_profiles.documents || jsonb_build_object($2::text, $3::text),
               updated_at = NOW()`,
        [req.user.id, docType, storagePath]
      );

      res.json({ success: true, path: storagePath });
    } catch (err) {
      console.error('Document DB update error:', err);
      res.status(500).json({ success: false, message: 'Uploaded but failed to save path.' });
    }
  }
);

// ============================================================
// POST /api/providers/upload/portfolio
// Uploads a portfolio photo/video to the provider-portfolio bucket
// (public) and appends the path to provider_profiles.portfolio_paths.
// ============================================================
router.post('/upload/portfolio',
  authenticate,
  authorize('provider'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.bin';
    const storagePath = `${req.user.id}/portfolio/${Date.now()}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('provider-portfolio')
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error('Portfolio upload error:', uploadError);
      return res.status(500).json({ success: false, message: 'Portfolio upload failed.' });
    }

    try {
      await db.queryAsUser(req.user.id,
        `INSERT INTO public.provider_profiles (provider_id, portfolio_paths)
         VALUES ($1, ARRAY[$2::text])
         ON CONFLICT (provider_id) DO UPDATE
           SET portfolio_paths = array_append(provider_profiles.portfolio_paths, $2::text),
               updated_at      = NOW()`,
        [req.user.id, storagePath]
      );

      res.json({ success: true, path: storagePath });
    } catch (err) {
      console.error('Portfolio DB update error:', err);
      res.status(500).json({ success: false, message: 'Uploaded but failed to save path.' });
    }
  }
);

// ============================================================
// DELETE /api/providers/upload/portfolio
// Body: { path: 'provider-portfolio/...' }
// Removes file from storage and strips path from portfolio_paths.
// ============================================================
router.delete('/upload/portfolio', authenticate, authorize('provider'), async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ success: false, message: 'path is required.' });
  }

  const { error: deleteError } = await supabase.storage
    .from('provider-portfolio')
    .remove([filePath]);

  if (deleteError) {
    console.error('Storage delete error:', deleteError);
    return res.status(500).json({ success: false, message: 'File delete failed.' });
  }

  try {
    await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
         SET portfolio_paths = array_remove(portfolio_paths, $1::text),
             updated_at      = NOW()
       WHERE provider_id = $2`,
      [filePath, req.user.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Portfolio delete DB error:', err);
    res.status(500).json({ success: false, message: 'Deleted from storage but failed to update DB.' });
  }
});

// ============================================================
// GET /api/providers/stats
// KPI counts for the provider dashboard header cards.
// ============================================================
router.get('/stats', authenticate, authorize('provider'), async (req, res) => {
  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        -- Only live tenders: open, not admin-removed, not expired (matches Browse).
        (SELECT COUNT(*)::int FROM public.tenders
           WHERE status = 'open' AND trashed_at IS NULL
             AND (expires_at IS NULL OR expires_at > NOW())) AS open_tenders,
        (SELECT COUNT(*)::int FROM public.tenders t
           WHERE t.status = 'open' AND t.trashed_at IS NULL
             AND (t.expires_at IS NULL OR t.expires_at > NOW())
             AND t.category IN (
               SELECT category FROM public.provider_services WHERE provider_id = $1
             )) AS matched_open_tenders,
        -- Quotes on admin-removed tenders are hidden, so exclude them (matches My Quotes).
        (SELECT COUNT(*)::int FROM public.quotes q
           JOIN public.tenders t ON t.id = q.tender_id
           WHERE q.provider_id = $1 AND t.trashed_at IS NULL) AS quotes_submitted,
        (SELECT COUNT(*)::int FROM public.quotes q
           JOIN public.tenders t ON t.id = q.tender_id
           WHERE q.provider_id = $1 AND q.status = 'accepted' AND t.trashed_at IS NULL) AS jobs_won,
        (SELECT ROUND(AVG(rating)::numeric, 1) FROM public.reviews WHERE provider_id = $1) AS avg_rating,
        (SELECT COUNT(*)::int FROM public.reviews WHERE provider_id = $1) AS review_count
    `, [req.user.id]);

    const row = result.rows[0];
    res.json({
      success: true,
      openTenders:         row.open_tenders         ?? 0,
      matchedOpenTenders:  row.matched_open_tenders  ?? 0,
      quotesSubmitted:     row.quotes_submitted      ?? 0,
      jobsWon:             row.jobs_won              ?? 0,
      avgRating:           row.avg_rating            ? parseFloat(row.avg_rating) : null,
      reviewCount:         row.review_count          ?? 0,
    });
  } catch (err) {
    console.error('GET /api/providers/stats error:', err);
    res.status(500).json({ success: false, message: 'Failed to load stats.' });
  }
});

// ============================================================
// POST /api/providers/go-live
// Sets is_onboarding_complete = TRUE on the provider's profile.
// Only succeeds if a profile row already exists (step 1 must be saved first).
// ============================================================
router.post('/go-live', authenticate, authorize('provider'), async (req, res) => {
  try {
    // Block re-submission for already-approved providers.
    const statusRow = await db.queryAsUser(req.user.id,
      `SELECT verification_status FROM public.provider_profiles WHERE provider_id = $1`,
      [req.user.id]
    );
    if (statusRow.rows[0]?.verification_status === 'approved') {
      return res.status(400).json({
        success: false,
        code: 'ALREADY_APPROVED',
        message: 'Your account is already verified. No resubmission is needed.',
      });
    }

    // On (re)submission: mark onboarding complete and stamp submitted_at.
    // If the provider was previously REJECTED, flip them back to 'pending' and
    // stamp resubmitted_at so the application re-enters the admin queue.
    // The previous rejection_reason/notes are intentionally preserved so the
    // admin can see why it was rejected before. An approved provider re-saving
    // is never downgraded.
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
         SET is_onboarding_complete = TRUE,
             submitted_at           = COALESCE(submitted_at, NOW()),
             resubmitted_at         = CASE WHEN verification_status = 'rejected'
                                           THEN NOW() ELSE resubmitted_at END,
             verification_status    = CASE WHEN verification_status = 'rejected'
                                           THEN 'pending'::public.verification_status
                                           ELSE verification_status END,
             updated_at             = NOW()
       WHERE provider_id = $1
       RETURNING id`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Profile not found. Please complete step 1 first.',
      });
    }

    res.json({ success: true });

    // Fire-and-forget: email all admins + broadcast Realtime.
    // Both run AFTER the response is already sent so they never delay the provider.
    try {
      const [providerRes, adminRes] = await Promise.all([
        db.query(
          `SELECT u.first_name, u.last_name,
                  (SELECT st.display_name
                     FROM public.provider_services ps
                     JOIN public.service_types st ON st.slug = ps.category::text
                    WHERE ps.provider_id = $1
                    LIMIT 1) AS service_name
             FROM public.users u
            WHERE u.id = $1`,
          [req.user.id]
        ),
        db.query(
          `SELECT email FROM public.users WHERE role = 'admin' AND is_email_verified = TRUE`
        ),
      ]);

      const p = providerRes.rows[0];
      const providerName = p ? `${p.first_name} ${p.last_name}`.trim() : 'A provider';
      const adminEmails = adminRes.rows.map((r) => r.email);

      await Promise.allSettled([
        sendNewProviderSubmittedEmail(providerName, p?.service_name || null, adminEmails),
        notifyChannel('admin-verifications', 'new-verification', {
          providerId: req.user.id,
          providerName,
        }),
      ]);
    } catch (notifyErr) {
      console.warn('POST /api/providers/go-live — admin notification failed:', notifyErr.message);
    }
  } catch (err) {
    console.error('POST /api/providers/go-live error:', err);
    res.status(500).json({ success: false, message: 'Failed to go live. Please try again.' });
  }
});

module.exports = router;
