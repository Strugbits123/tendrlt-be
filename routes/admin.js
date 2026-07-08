const express = require('express');
const path = require('path');
const db = require('../db');
const supabase = require('../lib/supabaseClient');
const { authenticate, authorize } = require('../middleware/auth');
const {
  sendProviderApprovedEmail,
  sendProviderRejectedEmail,
} = require('../lib/verificationEmails');
const { notifyUser, notifyChannel } = require('../lib/realtimeService');
const { sendTenderRemovedEmail } = require('../lib/tenderEmails');

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

// ============================================================
// Admin Tender Management
// Read via db.query (superuser) — route already gated by authorize('admin').
// Tenders are addressed by their human-readable display_code (TND-####).
// ============================================================

// Prettify a raw service_category slug as a fallback title/label.
const prettifyCat = (c) =>
  (c || 'other').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// DB status + flags -> admin display status.
const toAdminStatus = (row) => {
  if (row.status === 'completed') return 'completed';
  if (row.has_accepted || row.status === 'in_progress') return 'awarded';
  if (row.is_expired) return 'expired';
  return 'active';
};

const QUOTE_STATUS_MAP = { pending: 'pending', accepted: 'awarded', rejected: 'rejected' };

const monthYear = (d) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', year: 'numeric' }) : '';
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

// Ping every provider who quoted a tender so their "My Quotes" list re-fetches
// (their quote is hidden while the tender is trashed, and returns on restore).
async function notifyQuoteProviders(tenderId) {
  const r = await db.query('SELECT DISTINCT provider_id FROM public.quotes WHERE tender_id = $1', [tenderId]);
  await Promise.allSettled(
    r.rows.map((row) => notifyUser(row.provider_id, 'quotes-updated', { tenderId }))
  );
}

// GET /api/admin/tenders — every non-draft tender in the AdminTender shape.
router.get('/tenders', async (req, res) => {
  try {
    const tRes = await db.query(`
      SELECT
        t.id AS uuid, t.display_code, t.description, t.category,
        st.display_name AS service_name,
        t.parish, t.budget_min, t.budget_max,
        t.created_at, t.preferred_start_date, t.expires_at, t.updated_at,
        t.status, t.trashed_at,
        (t.expires_at IS NOT NULL AND t.expires_at <= NOW()) AS is_expired,
        EXISTS (SELECT 1 FROM public.quotes q WHERE q.tender_id = t.id AND q.status = 'accepted') AS has_accepted,
        cu.first_name, cu.last_name, cu.email,
        cu.display_code AS client_code, cu.created_at AS client_since
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users cu ON cu.id = t.client_id
      WHERE t.status <> 'draft'
      ORDER BY t.created_at DESC
    `);

    const uuids = tRes.rows.map((r) => r.uuid);
    const quotesByTender = new Map();
    if (uuids.length) {
      const qRes = await db.query(`
        SELECT q.id, q.tender_id, q.amount, q.status, q.created_at,
               pu.display_code AS provider_code, pu.first_name, pu.last_name
        FROM public.quotes q
        JOIN public.users pu ON pu.id = q.provider_id
        WHERE q.tender_id = ANY($1::uuid[])
        ORDER BY q.created_at ASC
      `, [uuids]);
      for (const q of qRes.rows) {
        if (!quotesByTender.has(q.tender_id)) quotesByTender.set(q.tender_id, []);
        quotesByTender.get(q.tender_id).push(q);
      }
    }

    const tenders = tRes.rows.map((r) => {
      const rawQuotes = quotesByTender.get(r.uuid) || [];
      const quotes = rawQuotes.map((q) => ({
        pid:    q.provider_code,
        name:   `${q.first_name} ${q.last_name}`.trim(),
        amount: Math.round((q.amount || 0) / 100),
        date:   isoDate(q.created_at),
        status: QUOTE_STATUS_MAP[q.status] || 'pending',
      }));
      const accepted = rawQuotes.find((q) => q.status === 'accepted');

      return {
        id:     r.display_code,
        title:  r.service_name || prettifyCat(r.category),
        cat:    r.category,
        desc:   r.description || '',
        client: {
          name:  `${r.first_name} ${r.last_name}`.trim(),
          email: r.email,
          id:    r.client_code,
          since: monthYear(r.client_since),
        },
        location:   r.parish,
        budget_min: Math.round((r.budget_min || 0) / 100),
        budget_max: Math.round((r.budget_max || 0) / 100),
        posted:     isoDate(r.created_at),
        deadline:   isoDate(r.expires_at),
        status:     toAdminStatus(r),
        quotes,
        awarded_to: accepted
          ? { pid: accepted.provider_code, name: `${accepted.first_name} ${accepted.last_name}`.trim(), amount: Math.round((accepted.amount || 0) / 100) }
          : undefined,
        completed_date: r.status === 'completed' ? isoDate(r.updated_at) : undefined,
        trashed: r.trashed_at !== null,
      };
    });

    res.json({ success: true, tenders });
  } catch (err) {
    console.error('GET /api/admin/tenders error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tenders.' });
  }
});

// GET /api/admin/tenders/active-count — count of live "Active" tenders for the
// sidebar badge (open, not admin-removed, not expired, not yet awarded) — mirrors
// the Active/Live bucket on the admin Tenders page.
router.get('/tenders/active-count', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS count
      FROM public.tenders t
      WHERE t.status = 'open'
        AND t.trashed_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > NOW())
        AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.tender_id = t.id AND q.status = 'accepted')
    `);
    res.json({ success: true, count: r.rows[0].count });
  } catch (err) {
    console.error('GET /api/admin/tenders/active-count error:', err);
    res.status(500).json({ success: false, message: 'Failed to count tenders.' });
  }
});

// POST /api/admin/tenders/:code/trash — soft-delete (hides from browse/explore
// and marks the homeowner's copy "Rejected by admin"). Optional { reason }.
router.post('/tenders/:code/trash', async (req, res) => {
  const reason = (req.body && typeof req.body.reason === 'string')
    ? req.body.reason.trim().slice(0, 500) || null
    : null;
  try {
    const r = await db.query(
      `UPDATE public.tenders
         SET trashed_at = NOW(), trashed_reason = $2, updated_at = NOW()
       WHERE display_code = $1
       RETURNING id, client_id, display_code,
                 (SELECT display_name FROM public.service_types WHERE id = service_type_id) AS service_name,
                 category,
                 (SELECT email      FROM public.users WHERE id = client_id) AS client_email,
                 (SELECT first_name FROM public.users WHERE id = client_id) AS client_name`,
      [req.params.code, reason]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });
    res.json({ success: true });

    // Fire-and-forget: tell the homeowner their tender was removed.
    const t = r.rows[0];
    const label = t.service_name || t.category || 'your tender';
    Promise.allSettled([
      notifyUser(t.client_id, 'tender-removed', { tenderId: t.id, displayCode: t.display_code, reason }),
      // Email the homeowner.
      t.client_email
        ? sendTenderRemovedEmail(t.client_email, { clientName: t.client_name, tenderTitle: label, tenderCode: t.display_code, reason })
        : Promise.resolve(),
      notifyUser(t.client_id, 'tenders-updated', { tenderId: t.id }),
      db.query(
        `INSERT INTO public.notifications (user_id, type, title, body, data)
         VALUES ($1, 'tender_removed', $2, $3, $4::jsonb)`,
        [
          t.client_id,
          'Your tender was removed',
          `An administrator removed your "${label}" tender (${t.display_code}).` + (reason ? ` Reason: ${reason}` : ''),
          JSON.stringify({ tenderId: t.id }),
        ]
      ),
      // Refresh the My Quotes list of every provider who quoted — their quote is now hidden.
      notifyQuoteProviders(t.id),
      // Drop it from every provider's Browse grid + recount their stats, live.
      notifyChannel('tenders-feed', 'tender-removed', { tenderId: t.id }),
    ]).catch((err) => console.warn('trash notify error:', err.message));
  } catch (err) {
    console.error('POST /api/admin/tenders/:code/trash error:', err);
    res.status(500).json({ success: false, message: 'Failed to trash tender.' });
  }
});

// POST /api/admin/tenders/:code/restore — undo soft-delete + clear the reason.
router.post('/tenders/:code/restore', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE public.tenders
         SET trashed_at = NULL, trashed_reason = NULL, updated_at = NOW()
       WHERE display_code = $1
       RETURNING id, client_id, display_code,
                 (SELECT display_name FROM public.service_types WHERE id = service_type_id) AS service_name,
                 category`,
      [req.params.code]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });
    res.json({ success: true });

    const t = r.rows[0];
    const label = t.service_name || t.category || 'your tender';
    Promise.allSettled([
      notifyUser(t.client_id, 'tenders-updated', { tenderId: t.id }),
      db.query(
        `INSERT INTO public.notifications (user_id, type, title, body, data)
         VALUES ($1, 'tender_restored', $2, $3, $4::jsonb)`,
        [
          t.client_id,
          'Your tender was restored',
          `An administrator restored your "${label}" tender (${t.display_code}). It is live again.`,
          JSON.stringify({ tenderId: t.id }),
        ]
      ),
      // Refresh My Quotes for providers who quoted — their quote is visible again.
      notifyQuoteProviders(t.id),
      // Re-add it to providers' Browse grids + recount, live.
      notifyChannel('tenders-feed', 'tender-restored', { tenderId: t.id }),
    ]).catch((err) => console.warn('restore notify error:', err.message));
  } catch (err) {
    console.error('POST /api/admin/tenders/:code/restore error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore tender.' });
  }
});

// DELETE /api/admin/tenders/:code — permanent delete (cascades quotes + photos).
router.delete('/tenders/:code', async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM public.tenders WHERE display_code = $1 RETURNING id`,
      [req.params.code]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/tenders/:code error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete tender.' });
  }
});

// DELETE /api/admin/tenders/:code/quotes/:pid — remove a single quote (by provider code).
// One quote per (tender, provider) — uq_quotes_tender_provider — so this is unambiguous.
router.delete('/tenders/:code/quotes/:pid', async (req, res) => {
  try {
    const del = await db.query(`
      DELETE FROM public.quotes
      WHERE tender_id   = (SELECT id FROM public.tenders WHERE display_code = $1)
        AND provider_id = (SELECT id FROM public.users   WHERE display_code = $2)
      RETURNING tender_id
    `, [req.params.code, req.params.pid]);
    if (del.rows.length === 0) return res.status(404).json({ success: false, message: 'Quote not found.' });
    // Keep the denormalised counter honest.
    await db.query(
      `UPDATE public.tenders SET quotes_count = (SELECT COUNT(*) FROM public.quotes WHERE tender_id = $1)
       WHERE id = $1`,
      [del.rows[0].tender_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/tenders/:code/quotes/:pid error:', err);
    res.status(500).json({ success: false, message: 'Failed to remove quote.' });
  }
});

// ============================================================
// Admin Contact Inbox
// Reads/writes public.contact_messages. The public form stores the subject
// as the exact <option> label text (see tendrlt-fe/app/contact/page.tsx);
// we map that + the homeowner/provider/other role onto the admin UI's enums.
// ============================================================

const CONTACT_ROLE_MAP = { homeowner: 'client', provider: 'provider' };
const toContactRole = (r) => CONTACT_ROLE_MAP[r] || 'other';

const CONTACT_SUBJECT_MAP = {
  'Problem with a quote': 'quote',
  'Payment or escrow issue': 'payment',
  'Provider verification': 'verification',
  'Account access': 'account',
  'Report a user': 'report',
  'Feature request': 'feature',
  'General question': 'question',
  'Other': 'other',
};
const toContactSubject = (s) => CONTACT_SUBJECT_MAP[s] || 'other';

const INBOX_STATUSES = ['new', 'read', 'resolved', 'archived'];

const shapeContactMessage = (r) => ({
  id: r.id,
  fn: r.first_name,
  ln: r.last_name || '',
  email: r.email,
  role: toContactRole(r.role),
  subject: toContactSubject(r.subject),
  msg: r.message,
  date: r.created_at.toISOString().slice(0, 10),
  status: r.status,
  trashed: r.trashed,
});

// GET /api/admin/contact-messages
router.get('/contact-messages', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, first_name, last_name, email, role, subject, message, status, trashed, created_at
      FROM public.contact_messages
      ORDER BY created_at DESC
    `);
    res.json({ success: true, items: r.rows.map(shapeContactMessage) });
  } catch (err) {
    console.error('GET /api/admin/contact-messages error:', err);
    res.status(500).json({ success: false, message: 'Failed to load contact messages.' });
  }
});

// PATCH /api/admin/contact-messages/:id/status   body: { status }
router.patch('/contact-messages/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!INBOX_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status.' });
  }
  try {
    const r = await db.query(
      `UPDATE public.contact_messages SET status = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, status]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/admin/contact-messages/:id/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update status.' });
  }
});

// POST /api/admin/contact-messages/:id/trash
router.post('/contact-messages/:id/trash', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE public.contact_messages SET trashed = true WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/admin/contact-messages/:id/trash error:', err);
    res.status(500).json({ success: false, message: 'Failed to trash message.' });
  }
});

// POST /api/admin/contact-messages/:id/restore
router.post('/contact-messages/:id/restore', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE public.contact_messages SET trashed = false WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/admin/contact-messages/:id/restore error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore message.' });
  }
});

// DELETE /api/admin/contact-messages/:id
router.delete('/contact-messages/:id', async (req, res) => {
  try {
    const r = await db.query(`DELETE FROM public.contact_messages WHERE id = $1 RETURNING id`, [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/contact-messages/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete message.' });
  }
});

// ============================================================
// Admin Feedback Inbox
// Reads/writes public.feedback_submissions. The public form only ever sends
// role in {client, provider, visitor, other} and never collects a subject.
// ============================================================

const FEEDBACK_ROLE_MAP = { client: 'client', provider: 'provider', visitor: 'visitor' };
const toFeedbackRole = (r) => FEEDBACK_ROLE_MAP[r] || 'other';

const shapeFeedbackItem = (r) => ({
  id: r.id,
  cat: r.cat,
  name: r.name,
  email: r.email,
  role: toFeedbackRole(r.role),
  msg: r.message,
  rating: r.rating,
  followUp: r.follow_up,
  date: r.created_at.toISOString().slice(0, 10),
  status: r.status,
});

// GET /api/admin/feedback-submissions
router.get('/feedback-submissions', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, cat, name, email, role, rating, follow_up, message, status, created_at
      FROM public.feedback_submissions
      ORDER BY created_at DESC
    `);
    res.json({ success: true, items: r.rows.map(shapeFeedbackItem) });
  } catch (err) {
    console.error('GET /api/admin/feedback-submissions error:', err);
    res.status(500).json({ success: false, message: 'Failed to load feedback submissions.' });
  }
});

// PATCH /api/admin/feedback-submissions/:id/status   body: { status }
router.patch('/feedback-submissions/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!INBOX_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status.' });
  }
  try {
    const r = await db.query(
      `UPDATE public.feedback_submissions SET status = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, status]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Submission not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/admin/feedback-submissions/:id/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update status.' });
  }
});

// ============================================================
// Platform Fee Configuration (admin-only)
// Reads/writes platform_fee_config (singleton) + fee_change_history (audit).
// Every change broadcasts on 'platform-fees' so the whole app updates live.
// ============================================================

const num = (v) => (v == null ? null : parseFloat(v));

// Map a DB history row to the admin-screen HistoryEntry shape.
const shapeFeeHistory = (h) => {
  const created = new Date(h.created_at);
  return {
    id:           h.code,
    date:         created.toISOString().slice(0, 10),
    time:         created.toISOString().slice(11, 16),
    by:           h.changed_by_name || 'TendrIt Admin',
    role:         'Platform Owner',
    type:         h.type,
    old_client:   num(h.old_client),
    old_provider: num(h.old_provider),
    new_client:   num(h.new_client),
    new_provider: num(h.new_provider),
    effective:    h.effective ? new Date(h.effective).toISOString().slice(0, 10) : null,
    reason:       h.reason || '',
    status:       h.status,
    batches_applied: 0,
  };
};

async function loadFeeConfig() {
  const [cfg, hist] = await Promise.all([
    db.query('SELECT * FROM public.platform_fee_config WHERE id = 1'),
    db.query(`
      SELECT h.*, (u.first_name || ' ' || u.last_name) AS changed_by_name
      FROM public.fee_change_history h
      LEFT JOIN public.users u ON u.id = h.changed_by
      ORDER BY h.created_at ASC
    `),
  ]);
  const c = cfg.rows[0] || {};
  return {
    config: {
      client_rate:   num(c.client_rate),
      provider_rate: num(c.provider_rate),
      client_effective:   c.client_effective ? new Date(c.client_effective).toISOString().slice(0, 10) : null,
      provider_effective: c.provider_effective ? new Date(c.provider_effective).toISOString().slice(0, 10) : null,
    },
    history: hist.rows.map(shapeFeeHistory),
  };
}

const broadcastFees = (config) =>
  notifyChannel('platform-fees', 'fees-updated', {
    clientRate: config.client_rate,
    providerRate: config.provider_rate,
  }).catch(() => {});

// GET /api/admin/fee-config — current config + full change history.
router.get('/fee-config', async (req, res) => {
  try {
    res.json({ success: true, ...(await loadFeeConfig()) });
  } catch (err) {
    console.error('GET /api/admin/fee-config error:', err);
    res.status(500).json({ success: false, message: 'Failed to load fee config.' });
  }
});

// PATCH /api/admin/fee-config { side, rate, effective, reason } — change one side.
router.patch('/fee-config', async (req, res) => {
  const { side, rate, effective, reason } = req.body || {};
  if (side !== 'client' && side !== 'provider') {
    return res.status(400).json({ success: false, message: 'side must be "client" or "provider".' });
  }
  const r = parseFloat(rate);
  if (isNaN(r) || r < 0 || r > 100) {
    return res.status(400).json({ success: false, message: 'Rate must be between 0 and 100.' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'A reason is required.' });
  }
  if (!effective) {
    return res.status(400).json({ success: false, message: 'An effective date is required.' });
  }
  try {
    const cur = (await db.query('SELECT client_rate, provider_rate FROM public.platform_fee_config WHERE id = 1')).rows[0];
    const oldClient = num(cur.client_rate);
    const oldProvider = num(cur.provider_rate);
    const newClient = side === 'client' ? r : oldClient;
    const newProvider = side === 'provider' ? r : oldProvider;

    // side is validated to a fixed literal above — safe to interpolate the column.
    await db.query(
      `UPDATE public.platform_fee_config SET ${side}_rate = $1, ${side}_effective = $2, updated_at = NOW() WHERE id = 1`,
      [r, effective]
    );
    await db.query(
      `UPDATE public.fee_change_history SET status = 'superseded' WHERE status = 'active' AND (type = $1 OR type = 'both')`,
      [side]
    );
    await db.query(
      `INSERT INTO public.fee_change_history
         (code, type, old_client, old_provider, new_client, new_provider, effective, reason, changed_by, status)
       VALUES ('FCH-' || lpad(nextval('public.fee_change_code_seq')::text, 3, '0'),
               $1, $2, $3, $4, $5, $6, $7, $8, 'active')`,
      [side, oldClient, oldProvider, newClient, newProvider, effective, reason.trim(), req.user.id]
    );

    const out = await loadFeeConfig();
    res.json({ success: true, ...out });
    broadcastFees(out.config);
  } catch (err) {
    console.error('PATCH /api/admin/fee-config error:', err);
    res.status(500).json({ success: false, message: 'Failed to update fee config.' });
  }
});

// POST /api/admin/fee-config/rollback { client, provider } — revert the checked
// side(s) to their previous historical value. Entries are individual per side.
router.post('/fee-config/rollback', async (req, res) => {
  const doClient = !!(req.body && req.body.client);
  const doProvider = !!(req.body && req.body.provider);
  if (!doClient && !doProvider) {
    return res.status(400).json({ success: false, message: 'Select at least one side to roll back.' });
  }
  try {
    const cur = (await db.query('SELECT client_rate, provider_rate FROM public.platform_fee_config WHERE id = 1')).rows[0];
    const oldClient = num(cur.client_rate);
    const oldProvider = num(cur.provider_rate);
    let newClient = oldClient;
    let newProvider = oldProvider;

    if (doClient) {
      const prev = (await db.query(
        `SELECT old_client FROM public.fee_change_history WHERE type IN ('client','both') ORDER BY created_at DESC LIMIT 1`
      )).rows[0];
      if (!prev) return res.status(400).json({ success: false, message: 'No previous client fee to roll back to.' });
      newClient = num(prev.old_client);
    }
    if (doProvider) {
      const prev = (await db.query(
        `SELECT old_provider FROM public.fee_change_history WHERE type IN ('provider','both') ORDER BY created_at DESC LIMIT 1`
      )).rows[0];
      if (!prev) return res.status(400).json({ success: false, message: 'No previous provider fee to roll back to.' });
      newProvider = num(prev.old_provider);
    }

    if (doClient) {
      await db.query(`UPDATE public.platform_fee_config SET client_rate = $1, client_effective = CURRENT_DATE, updated_at = NOW() WHERE id = 1`, [newClient]);
    }
    if (doProvider) {
      await db.query(`UPDATE public.platform_fee_config SET provider_rate = $1, provider_effective = CURRENT_DATE, updated_at = NOW() WHERE id = 1`, [newProvider]);
    }

    // Supersede the active entries for the rolled-back side(s).
    if (doClient && doProvider) {
      await db.query(`UPDATE public.fee_change_history SET status = 'superseded' WHERE status = 'active'`);
    } else {
      const side = doClient ? 'client' : 'provider';
      await db.query(`UPDATE public.fee_change_history SET status = 'superseded' WHERE status = 'active' AND (type = $1 OR type = 'both')`, [side]);
    }

    const type = doClient && doProvider ? 'both' : doClient ? 'client' : 'provider';
    const sidesLabel = [doClient && 'Client', doProvider && 'Provider'].filter(Boolean).join(' & ');
    await db.query(
      `INSERT INTO public.fee_change_history
         (code, type, old_client, old_provider, new_client, new_provider, effective, reason, changed_by, status)
       VALUES ('FCH-' || lpad(nextval('public.fee_change_code_seq')::text, 3, '0'),
               $1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, 'active')`,
      [type, oldClient, oldProvider, newClient, newProvider, `Rollback (${sidesLabel})`, req.user.id]
    );

    const out = await loadFeeConfig();
    res.json({ success: true, ...out });
    broadcastFees(out.config);
  } catch (err) {
    console.error('POST /api/admin/fee-config/rollback error:', err);
    res.status(500).json({ success: false, message: 'Failed to roll back fee config.' });
  }
});

module.exports = router;
