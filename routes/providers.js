const express = require('express');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Memory storage — file bytes held in RAM briefly, then streamed to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 104857600 }, // 100 MB max
});

// Supabase Storage client using service role key (bypasses storage RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        (SELECT to_json(p.*) FROM public.provider_profiles p WHERE p.provider_id = $1) AS profile,
        (
          SELECT COALESCE(array_agg(s.category ORDER BY s.created_at), ARRAY[]::service_category[])
          FROM public.provider_services s WHERE s.provider_id = $1
        ) AS services,
        (
          SELECT COALESCE(array_agg(pa.parish ORDER BY pa.created_at), ARRAY[]::text[])
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
        text: `INSERT INTO public.provider_services (provider_id, category)
               SELECT $1, cat FROM (SELECT DISTINCT UNNEST($2::service_category[]) AS cat) t`,
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
// POST /api/providers/go-live
// Sets is_onboarding_complete = TRUE on the provider's profile.
// Only succeeds if a profile row already exists (step 1 must be saved first).
// ============================================================
router.post('/go-live', authenticate, authorize('provider'), async (req, res) => {
  try {
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
         SET is_onboarding_complete = TRUE,
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
  } catch (err) {
    console.error('POST /api/providers/go-live error:', err);
    res.status(500).json({ success: false, message: 'Failed to go live. Please try again.' });
  }
});

module.exports = router;
