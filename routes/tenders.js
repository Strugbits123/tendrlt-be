const express = require('express');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyUser } = require('../lib/realtimeService');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 104857600 }, // 100 MB — matches Supabase Storage bucket limit
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VALID_URGENCIES = ['emergency', 'urgent', 'soon', 'flexible', 'planning'];
const VALID_STATUSES  = ['draft', 'open'];

// Fields that can be patched on a tender
const PATCHABLE = [
  'category', 'parish', 'description', 'urgency', 'urgency_note',
  'preferred_start_date', 'budget_min', 'budget_max',
  'contact_name', 'contact_phone', 'contact_email',
  'location_lat', 'location_lng',
];

// ============================================================
// POST /api/tenders
// Creates a new tender (draft or open).
// status=draft  → minimal validation (category + parish required by DB NOT NULL)
// status=open   → full validation including contact fields
// ============================================================
router.post('/',
  authenticate,
  authorize('homeowner'),
  upload.array('photos', 20),
  async (req, res) => {
    const {
      category, parish, description, urgency, urgency_note,
      preferred_start_date, budget_min, budget_max,
      contact_name, contact_phone, contact_email,
      location_lat, location_lng,
      status = 'draft',
    } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }

    // category and parish are DB NOT NULL — required for both draft and open
    if (!category || !parish) {
      return res.status(400).json({ success: false, message: 'category and parish are required.' });
    }

    // Full validation only when submitting as open
    if (status === 'open') {
      if (!urgency || !contact_name || !contact_phone) {
        return res.status(400).json({
          success: false,
          message: 'urgency, contact_name, and contact_phone are required to publish a tender.',
        });
      }
      if (!VALID_URGENCIES.includes(urgency)) {
        return res.status(400).json({ success: false, message: 'Invalid urgency value.' });
      }
      const cleanPhone = contact_phone.replace(/\D/g, '');
      if (cleanPhone.length < 7 || cleanPhone.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number.' });
      }
    }

    const cleanPhone = contact_phone ? contact_phone.replace(/\D/g, '') : null;
    const budgetMinCents = budget_min ? Math.round(parseFloat(budget_min) * 100) : null;
    const budgetMaxCents = budget_max ? Math.round(parseFloat(budget_max) * 100) : null;
    const lat = location_lat ? parseFloat(location_lat) : null;
    const lng = location_lng ? parseFloat(location_lng) : null;

    try {
      const insertResult = await db.queryAsUser(req.user.id, `
        INSERT INTO public.tenders (
          client_id, category, service_type_id, parish,
          description, urgency, urgency_note,
          preferred_start_date, budget_min, budget_max,
          contact_name, contact_phone, contact_email,
          location_lat, location_lng, status,
          terms_accepted_at
        )
        SELECT
          $1, $2::service_category, st.id, $3,
          $4, $5::tender_urgency, $6,
          $7::date, $8, $9,
          $10, $11, $12,
          $13, $14, $15::tender_status,
          CASE WHEN $15::tender_status = 'open' THEN NOW() ELSE NULL END
        FROM public.service_types st
        WHERE st.slug = $2::text
        RETURNING *
      `, [
        req.user.id,
        category,
        parish,
        description || null,
        urgency || 'flexible',
        urgency_note || null,
        preferred_start_date || null,
        budgetMinCents,
        budgetMaxCents,
        contact_name ? contact_name.trim() : null,
        cleanPhone,
        contact_email || null,
        lat,
        lng,
        status,
      ]);

      if (insertResult.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid service category.' });
      }

      const tender = insertResult.rows[0];

      let newPhotos = [];
      if (req.files && req.files.length > 0) {
        newPhotos = await uploadPhotos(req.user.id, tender.id, req.files);
        tender.photos_count = newPhotos.length;
      }

      res.status(201).json({ success: true, tender, newPhotos });
      // Fire-and-forget — notify the user's client so My Tenders refetches.
      notifyUser(req.user.id, 'tenders-updated', { tenderId: tender.id }).catch(() => {});
    } catch (err) {
      console.error('POST /api/tenders error:', err);
      res.status(500).json({ success: false, message: 'Failed to create tender.' });
    }
  }
);

// ============================================================
// PATCH /api/tenders/:id
// Partially updates an existing draft or open tender.
// If status='open' is included, runs full validation first.
// ============================================================
router.patch('/:id',
  authenticate,
  authorize('homeowner'),
  upload.array('photos', 20),
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    // ── Quote guard ──────────────────────────────────────────────
    // An already-published (open) tender can only be edited while it has NO
    // quotes. Once a provider has quoted, the brief is locked. Drafts and the
    // draft→open publish step are unaffected (a draft has no quotes yet).
    try {
      const guard = await db.queryAsUserBatch(req.user.id, [
        { text: `SELECT status FROM public.tenders WHERE id = $1 AND client_id = $2`, params: [id, req.user.id] },
        { text: `SELECT COUNT(*)::int AS n FROM public.quotes WHERE tender_id = $1`, params: [id] },
      ]);
      if (guard[0].rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Tender not found.' });
      }
      const currentStatus = guard[0].rows[0].status;
      const quoteCount = guard[1].rows[0].n;
      if (currentStatus === 'open' && quoteCount > 0) {
        return res.status(409).json({
          success: false,
          code: 'TENDER_HAS_QUOTES',
          message: 'This tender already has quotes and can no longer be edited.',
        });
      }
    } catch (guardErr) {
      console.error('PATCH /api/tenders/:id quote-guard error:', guardErr);
      return res.status(500).json({ success: false, message: 'Failed to update tender.' });
    }

    // Full validation when upgrading to open
    if (status === 'open') {
      const { category, parish, urgency, contact_name, contact_phone } = req.body;
      if (!category || !parish || !urgency || !contact_name || !contact_phone) {
        return res.status(400).json({
          success: false,
          message: 'category, parish, urgency, contact_name, and contact_phone are required to publish.',
        });
      }
      if (!VALID_URGENCIES.includes(urgency)) {
        return res.status(400).json({ success: false, message: 'Invalid urgency value.' });
      }
      const phone = contact_phone.replace(/\D/g, '');
      if (phone.length < 7 || phone.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number.' });
      }
    }

    // Build SET clause from whitelisted fields that are present in the body
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    const addField = (col, val) => {
      setClauses.push(`${col} = $${paramIdx}`);
      params.push(val);
      paramIdx++;
    };

    if (req.body.category !== undefined) {
      // category update also requires refreshing service_type_id
      // handled via a subquery — skip for now, use a separate approach below
    }

    const simpleFields = {
      parish:               req.body.parish,
      description:          req.body.description || null,
      urgency_note:         req.body.urgency_note || null,
      preferred_start_date: req.body.preferred_start_date || null,
      contact_name:         req.body.contact_name ? req.body.contact_name.trim() : undefined,
      contact_phone:        req.body.contact_phone ? req.body.contact_phone.replace(/\D/g, '') : undefined,
      contact_email:        req.body.contact_email || null,
      location_lat:         req.body.location_lat ? parseFloat(req.body.location_lat) : undefined,
      location_lng:         req.body.location_lng ? parseFloat(req.body.location_lng) : undefined,
    };

    for (const [col, val] of Object.entries(simpleFields)) {
      if (val !== undefined) addField(col, val);
    }

    if (req.body.urgency !== undefined) {
      setClauses.push(`urgency = $${paramIdx}::tender_urgency`);
      params.push(req.body.urgency);
      paramIdx++;
    }

    if (req.body.budget_min !== undefined) {
      addField('budget_min', req.body.budget_min ? Math.round(parseFloat(req.body.budget_min) * 100) : null);
    }
    if (req.body.budget_max !== undefined) {
      addField('budget_max', req.body.budget_max ? Math.round(parseFloat(req.body.budget_max) * 100) : null);
    }

    if (status !== undefined) {
      setClauses.push(`status = $${paramIdx}::tender_status`);
      params.push(status);
      paramIdx++;
      // Record the exact moment the homeowner agreed to T&C and published
      if (status === 'open') {
        setClauses.push(`terms_accepted_at = NOW()`);
      }
    }

    // Handle category change (requires re-joining service_types for service_type_id)
    if (req.body.category !== undefined) {
      setClauses.push(`category = $${paramIdx}::service_category`);
      params.push(req.body.category);
      paramIdx++;
      setClauses.push(
        `service_type_id = (SELECT id FROM public.service_types WHERE slug = $${paramIdx}::text)`
      );
      params.push(req.body.category);
      paramIdx++;
    }

    if (setClauses.length === 0 && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ success: false, message: 'No fields to update.' });
    }

    try {
      let tender;

      if (setClauses.length > 0) {
        params.push(id);
        const updateResult = await db.queryAsUser(req.user.id, `
          UPDATE public.tenders
          SET ${setClauses.join(', ')}, updated_at = NOW()
          WHERE id = $${paramIdx}
          RETURNING *
        `, params);

        if (updateResult.rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Tender not found or not editable.' });
        }
        tender = updateResult.rows[0];
      } else {
        // Only photos being added
        const fetchResult = await db.queryAsUser(req.user.id, `SELECT * FROM public.tenders WHERE id = $1`, [id]);
        if (fetchResult.rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Tender not found.' });
        }
        tender = fetchResult.rows[0];
      }

      let newPhotos = [];
      if (req.files && req.files.length > 0) {
        newPhotos = await uploadPhotos(req.user.id, tender.id, req.files);
        tender.photos_count = (tender.photos_count || 0) + newPhotos.length;
      }

      res.json({ success: true, tender, newPhotos });
      // Fire-and-forget — notify the user's client so My Tenders refetches.
      notifyUser(req.user.id, 'tenders-updated', { tenderId: id }).catch(() => {});
    } catch (err) {
      console.error('PATCH /api/tenders/:id error:', err);
      res.status(500).json({ success: false, message: 'Failed to update tender.' });
    }
  }
);

// ============================================================
// GET /api/tenders/mine
// Lists tenders for the current homeowner, newest first.
// Optional query params: ?status=open, ?limit=3
// JOINs service_types for display_name + emoji.
// ============================================================
router.get('/mine', authenticate, authorize('homeowner'), async (req, res) => {
  const { status, limit } = req.query;
  const params = [req.user.id];
  let extraWhere = '';
  let limitClause = '';

  if (status) {
    params.push(status);
    extraWhere = ` AND t.status = $${params.length}::tender_status`;
  }

  if (limit) {
    const n = parseInt(limit, 10);
    if (!isNaN(n) && n > 0 && n <= 100) {
      params.push(n);
      limitClause = `LIMIT $${params.length}`;
    }
  }

  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        t.id, t.status, t.category, t.parish, t.description,
        t.urgency, t.budget_min, t.budget_max, t.created_at,
        t.quotes_count, t.photos_count,
        (
          SELECT MIN(q.amount) FROM public.quotes q
          WHERE q.tender_id = t.id
        ) AS best_quote_price,
        EXISTS (
          SELECT 1 FROM public.quotes q
          WHERE q.tender_id = t.id AND q.status = 'accepted'
        ) AS has_accepted_quote,
        st.display_name AS service_name,
        st.emoji        AS service_emoji
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE t.client_id = $1${extraWhere}
      ORDER BY t.created_at DESC
      ${limitClause}
    `, params);

    res.json({ success: true, tenders: result.rows });
  } catch (err) {
    console.error('GET /api/tenders/mine error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tenders.' });
  }
});

// ============================================================
// GET /api/tenders/:id
// Returns a single tender for the current homeowner.
// Used by post-job page to pre-populate draft form.
// Also returns tender_photos rows with public Storage URLs.
// ============================================================
router.get('/:id', authenticate, authorize('homeowner'), async (req, res) => {
  try {
    const [tenderResult, photosResult] = await db.queryAsUserBatch(req.user.id, [
      {
        text: `
          SELECT
            t.*,
            st.display_name AS service_name,
            st.emoji        AS service_emoji,
            (SELECT COUNT(*)::int FROM public.quotes q WHERE q.tender_id = t.id) AS quote_count
          FROM public.tenders t
          LEFT JOIN public.service_types st ON st.id = t.service_type_id
          WHERE t.id = $1 AND t.client_id = $2
        `,
        params: [req.params.id, req.user.id],
      },
      {
        text: `
          SELECT id, storage_path, display_order
          FROM public.tender_photos
          WHERE tender_id = $1
          ORDER BY display_order ASC
        `,
        params: [req.params.id],
      },
    ]);

    if (tenderResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found.' });
    }

    // tender-media is a public bucket — construct public URLs without signing
    const photos = photosResult.rows.map((p) => {
      const { data: { publicUrl } } = supabase.storage
        .from('tender-media')
        .getPublicUrl(p.storage_path);
      return {
        id: p.id,
        storage_path: p.storage_path,
        url: publicUrl,
        type: /\.(mp4|mov|webm|avi|mkv|wmv)$/i.test(p.storage_path) ? 'video' : 'image',
      };
    });

    res.json({ success: true, tender: tenderResult.rows[0], photos });
  } catch (err) {
    console.error('GET /api/tenders/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tender.' });
  }
});

// ============================================================
// DELETE /api/tenders/:tenderId/photos/:photoId
// Deletes a single photo: removes from tender_photos table AND
// from Supabase Storage. Tender must belong to the current user.
// ============================================================
router.delete('/:tenderId/photos/:photoId', authenticate, authorize('homeowner'), async (req, res) => {
  const { tenderId, photoId } = req.params;
  try {
    // Fetch the photo row, confirming it belongs to this user's tender
    const photoResult = await db.queryAsUser(req.user.id, `
      SELECT tp.id, tp.storage_path
      FROM public.tender_photos tp
      JOIN public.tenders t ON t.id = tp.tender_id
      WHERE tp.id = $1
        AND tp.tender_id = $2
        AND t.client_id = $3
    `, [photoId, tenderId, req.user.id]);

    if (photoResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Photo not found.' });
    }

    const { storage_path } = photoResult.rows[0];

    // Delete DB row + decrement counter in one transaction
    await db.queryAsUserBatch(req.user.id, [
      {
        text: `DELETE FROM public.tender_photos WHERE id = $1`,
        params: [photoId],
      },
      {
        text: `UPDATE public.tenders SET photos_count = GREATEST(photos_count - 1, 0) WHERE id = $1`,
        params: [tenderId],
      },
    ]);

    // Delete from Storage — best-effort (don't fail the whole request if storage errors)
    const { error: storageError } = await supabase.storage
      .from('tender-media')
      .remove([storage_path]);
    if (storageError) {
      console.error('Storage delete error (non-fatal):', storageError.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/tenders/:tenderId/photos/:photoId error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete photo.' });
  }
});

// ============================================================
// DELETE /api/tenders/:id
// Deletes any tender owned by the current homeowner, provided no
// quote has been accepted for it (accepted quotes lock the tender).
// ============================================================
router.delete('/:id', authenticate, authorize('homeowner'), async (req, res) => {
  const { id } = req.params;
  try {
    // Guard: reject deletion if a quote has been accepted.
    const acceptedCheck = await db.queryAsUser(req.user.id, `
      SELECT EXISTS (
        SELECT 1 FROM public.quotes q
        WHERE q.tender_id = $1 AND q.status = 'accepted'
      ) AS has_accepted
    `, [id]);

    if (acceptedCheck.rows[0].has_accepted) {
      return res.status(409).json({
        success: false,
        code: 'QUOTE_ACCEPTED',
        message: 'This tender cannot be deleted because a quote has already been accepted.',
      });
    }

    const result = await db.queryAsUser(req.user.id, `
      DELETE FROM public.tenders
      WHERE id = $1 AND client_id = $2
      RETURNING id
    `, [id, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found or cannot be deleted.' });
    }

    res.json({ success: true });
    // Notify the user's connected clients so the dashboard and My Tenders refetch.
    notifyUser(req.user.id, 'tenders-updated', { tenderId: id }).catch(() => {});
  } catch (err) {
    console.error('DELETE /api/tenders/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete tender.' });
  }
});

// ============================================================
// Helper: upload photos to Supabase Storage + insert tender_photos rows
// Returns array of { id, storage_path, url, type } for each uploaded file.
// ============================================================
async function uploadPhotos(userId, tenderId, files) {
  const photoInserts = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const rand = Math.random().toString(36).slice(2, 7);
    const storagePath = `${userId}/${tenderId}/${Date.now()}_${i}_${rand}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('tender-media')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error(`Photo upload error (file ${i}):`, uploadError);
      continue;
    }
    photoInserts.push({ path: storagePath, order: i });
  }

  if (photoInserts.length === 0) return [];

  const photoValues = photoInserts
    .map((_, idx) => `($1, $${idx * 2 + 2}, $${idx * 2 + 3})`)
    .join(', ');
  const photoParams = [tenderId];
  photoInserts.forEach(p => photoParams.push(p.path, p.order));

  try {
    const results = await db.queryAsUserBatch(userId, [
      {
        text: `INSERT INTO public.tender_photos (tender_id, storage_path, display_order) VALUES ${photoValues} RETURNING id, storage_path`,
        params: photoParams,
      },
      {
        text: `UPDATE public.tenders SET photos_count = photos_count + $2 WHERE id = $1`,
        params: [tenderId, photoInserts.length],
      },
    ]);

    // Build response objects with public URLs (tender-media is a public bucket)
    return results[0].rows.map(row => {
      const { data: { publicUrl } } = supabase.storage
        .from('tender-media')
        .getPublicUrl(row.storage_path);
      return {
        id: row.id,
        storage_path: row.storage_path,
        url: publicUrl,
        type: /\.(mp4|mov|webm|avi|mkv|wmv)$/i.test(row.storage_path) ? 'video' : 'image',
      };
    });
  } catch (err) {
    console.error('Photo DB insert error:', err);
    return [];
  }
}

module.exports = router;
