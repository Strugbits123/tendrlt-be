const express = require('express');
const path = require('path');
const db = require('../db');
const supabase = require('../lib/supabaseClient');
const { authenticate, authorize } = require('../middleware/auth');
const {
  sendProviderApprovedEmail,
  sendProviderRejectedEmail,
} = require('../lib/verificationEmails');
const { notifyUser } = require('../lib/realtimeService');

const router = express.Router();

// All admin routes require an authenticated admin.
router.use(authenticate, authorize('admin'));

// The four known document slots. gov_id is required; the rest are optional.
const DOC_TYPES = [
  { docType: 'gov_id',       name: 'Government ID',          required: true  },
  { docType: 'trade_cert',   name: 'Trade Certificate',      required: false },
  { docType: 'insurance',    name: 'Insurance',              required: false },
  { docType: 'business_reg', name: 'Business Registration',  required: false },
];
const VALID_DOC_TYPES = DOC_TYPES.map(d => d.docType);

// Map a file extension to a coarse content type so the frontend can pick
// <img> vs <iframe> for previewing.
const contentTypeForPath = (p) => {
  const ext = path.extname(p || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
};

// ============================================================
// GET /api/admin/verifications
// All submitted providers (is_onboarding_complete = TRUE) with their
// profile, services, parishes, and a derived docs[] array.
// Read via db.query (superuser) — route already gated by authorize('admin').
// ============================================================
router.get('/verifications', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        u.id            AS provider_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone_number,
        u.parish        AS home_parish,
        p.bio,
        p.verification_status,
        p.documents,
        -- Use the latest submission (resubmission wins) so the SLA clock resets.
        COALESCE(p.resubmitted_at, p.submitted_at) AS submitted_at,
        p.resubmitted_at,
        p.rejection_reason,
        p.rejection_notes,
        p.admin_notes,
        COALESCE(
          (SELECT json_agg(COALESCE(st.display_name, ps.category::text) ORDER BY ps.created_at)
             FROM public.provider_services ps
             LEFT JOIN public.service_types st ON st.slug = ps.category::text
            WHERE ps.provider_id = u.id),
          '[]'::json
        ) AS services,
        COALESCE(
          (SELECT json_agg(pa.parish ORDER BY pa.created_at)
             FROM public.provider_parishes pa
            WHERE pa.provider_id = u.id),
          '[]'::json
        ) AS parishes
      FROM public.provider_profiles p
      JOIN public.users u ON u.id = p.provider_id
      WHERE p.is_onboarding_complete = TRUE
      ORDER BY COALESCE(p.resubmitted_at, p.submitted_at) ASC NULLS LAST
    `);

    const providers = result.rows.map((r) => {
      const docs = r.documents || {};
      return {
        providerId:         r.provider_id,
        name:               `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unnamed Provider',
        firstName:          r.first_name,
        email:              r.email,
        phone:              r.phone_number || '',
        parish:             (Array.isArray(r.parishes) && r.parishes[0]) || r.home_parish || '—',
        coverageParishes:   Array.isArray(r.parishes) ? r.parishes : [],
        cats:               Array.isArray(r.services) ? r.services : [],
        bio:                r.bio || '',
        verification_status: r.verification_status,
        submittedAt:        r.submitted_at,
        rejectionReason:    r.rejection_reason,
        rejectionNotes:     r.rejection_notes,
        // A pending application that carries a prior rejection reason is a
        // resubmission — the admin sees why it was rejected last time.
        previouslyRejected: Boolean(r.resubmitted_at) && Boolean(r.rejection_reason),
        adminNotes:         r.admin_notes || '',
        docs: DOC_TYPES.map(d => ({
          docType:  d.docType,
          name:     d.name,
          required: d.required,
          uploaded: Boolean(docs[d.docType]),
        })),
      };
    });

    res.json({ success: true, providers });
  } catch (err) {
    console.error('GET /api/admin/verifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to load verifications.' });
  }
});

// ============================================================
// GET /api/admin/verifications/unread-count?since=<unix_ms>
// Returns count of pending verifications submitted after the given timestamp.
// Used by the sidebar badge to show how many are new since the admin last
// viewed the verification page. `since` is milliseconds since epoch (from
// localStorage). Defaults to 0 (count all pending) if omitted or invalid.
// IMPORTANT: must be declared before /:providerId routes to avoid that param
// matching the literal string "unread-count".
// ============================================================
router.get('/verifications/unread-count', async (req, res) => {
  try {
    const sinceMs = parseInt(req.query.since, 10);
    const since = !isNaN(sinceMs) && sinceMs > 0 ? new Date(sinceMs) : new Date(0);

    const result = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM public.provider_profiles pp
        WHERE pp.is_onboarding_complete = TRUE
          AND pp.verification_status    = 'pending'
          AND COALESCE(pp.resubmitted_at, pp.submitted_at) > $1`,
      [since]
    );

    res.json({ success: true, count: result.rows[0].count });
  } catch (err) {
    console.error('GET /api/admin/verifications/unread-count error:', err);
    res.status(500).json({ success: false, count: 0 });
  }
});

// ============================================================
// GET /api/admin/verifications/:providerId/document/:docType
// Generate a short-lived signed URL for a private provider document.
// ============================================================
router.get('/verifications/:providerId/document/:docType', async (req, res) => {
  const { providerId, docType } = req.params;

  if (!VALID_DOC_TYPES.includes(docType)) {
    return res.status(400).json({ success: false, message: 'Invalid document type.' });
  }

  try {
    const result = await db.query(
      `SELECT documents FROM public.provider_profiles WHERE provider_id = $1`,
      [providerId]
    );

    const docs = result.rows[0]?.documents || {};
    const storagePath = docs[docType];
    if (!storagePath) {
      return res.status(404).json({ success: false, message: 'Document not uploaded.' });
    }

    const { data, error } = await supabase.storage
      .from('provider-documents')
      .createSignedUrl(storagePath, 3600); // 1 hour

    if (error || !data?.signedUrl) {
      console.error('createSignedUrl error:', error);
      return res.status(500).json({ success: false, message: 'Could not generate document link.' });
    }

    res.json({
      success: true,
      url: data.signedUrl,
      contentType: contentTypeForPath(storagePath),
    });
  } catch (err) {
    console.error('GET document signed-url error:', err);
    res.status(500).json({ success: false, message: 'Failed to load document.' });
  }
});

// ============================================================
// POST /api/admin/verifications/:providerId/approve   body: { note? }
// ============================================================
router.post('/verifications/:providerId/approve', async (req, res) => {
  const { providerId } = req.params;
  const { note } = req.body;

  try {
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
          SET verification_status = 'approved',
              is_verified         = TRUE,
              reviewed_at         = NOW(),
              reviewed_by         = $2,
              admin_notes         = COALESCE($3, admin_notes),
              updated_at          = NOW()
        WHERE provider_id = $1
        RETURNING provider_id`,
      [providerId, req.user.id, note ?? null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    // Fetch contact details for the email (superuser read).
    const userRes = await db.query(
      `SELECT email, first_name FROM public.users WHERE id = $1`,
      [providerId]
    );
    const u = userRes.rows[0];
    if (u?.email) {
      try {
        await sendProviderApprovedEmail(u.email, u.first_name, note);
      } catch (mailErr) {
        console.warn('Approval email failed:', mailErr.message);
      }
    }

    await notifyUser(providerId, 'verification-approved', {
      message: 'Your account has been approved! You can now receive jobs.',
    });

    res.json({ success: true, verification_status: 'approved' });
  } catch (err) {
    console.error('POST approve error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve provider.' });
  }
});

// ============================================================
// POST /api/admin/verifications/:providerId/reject   body: { reason, notes? }
// ============================================================
router.post('/verifications/:providerId/reject', async (req, res) => {
  const { providerId } = req.params;
  const { reason, notes } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
  }

  try {
    // Append this rejection to the immutable history trail (so prior reasons
    // survive future resubmissions/re-reviews), and set the latest reason/notes.
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
          SET verification_status = 'rejected',
              is_verified         = FALSE,
              reviewed_at         = NOW(),
              reviewed_by         = $2,
              rejection_reason    = $3,
              rejection_notes     = $4,
              verification_history = COALESCE(verification_history, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                     'action', 'rejected',
                     'reason', $3::text,
                     'notes',  $4::text,
                     'at',     NOW(),
                     'by',     $2::uuid
                   )),
              updated_at          = NOW()
        WHERE provider_id = $1
        RETURNING provider_id`,
      [providerId, req.user.id, reason, notes ?? null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    const userRes = await db.query(
      `SELECT email, first_name FROM public.users WHERE id = $1`,
      [providerId]
    );
    const u = userRes.rows[0];
    if (u?.email) {
      try {
        await sendProviderRejectedEmail(u.email, u.first_name, reason, notes);
      } catch (mailErr) {
        console.warn('Rejection email failed:', mailErr.message);
      }
    }

    await notifyUser(providerId, 'verification-rejected', {
      message: 'Your verification was not approved. Check your email for details.',
      reason,
    });

    res.json({ success: true, verification_status: 'rejected' });
  } catch (err) {
    console.error('POST reject error:', err);
    res.status(500).json({ success: false, message: 'Failed to reject provider.' });
  }
});

// ============================================================
// PUT /api/admin/verifications/:providerId/note   body: { admin_notes }
// Persist internal review notes (never emailed to the provider).
// ============================================================
router.put('/verifications/:providerId/note', async (req, res) => {
  const { providerId } = req.params;
  const { admin_notes } = req.body;

  try {
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
          SET admin_notes = $2, updated_at = NOW()
        WHERE provider_id = $1
        RETURNING provider_id`,
      [providerId, admin_notes ?? null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('PUT note error:', err);
    res.status(500).json({ success: false, message: 'Failed to save note.' });
  }
});

module.exports = router;
