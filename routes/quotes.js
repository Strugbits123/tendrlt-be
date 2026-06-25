const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyUser } = require('../lib/realtimeService');
const { sendNewQuoteEmail } = require('../lib/quoteEmails');
const { sendPushToUser } = require('../lib/pushService');

const router = express.Router();

const VALID_TIMELINES = ['same_day', 'next_day', '2_3_days', 'within_1_week', '1_2_weeks', '2_4_weeks'];

// ============================================================
// POST /api/quotes
// Provider submits a quote for an open tender.
// Body: { tender_id, amount, timeline, preferred_start_date, message, what_is_included }
// ============================================================
router.post('/', authenticate, authorize('provider'), async (req, res) => {
  const { tender_id, amount, timeline, preferred_start_date, message, what_is_included } = req.body;

  if (!tender_id) return res.status(400).json({ success: false, message: 'tender_id is required.' });
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'A valid amount is required.' });
  }
  if (!timeline || !VALID_TIMELINES.includes(timeline)) {
    return res.status(400).json({ success: false, message: 'A valid timeline is required.' });
  }
  if (!message || message.trim().length < 20) {
    return res.status(400).json({ success: false, message: 'Message must be at least 20 characters.' });
  }

  const amountCents = Math.round(Number(amount) * 100);

  try {
    // Step 1: verify tender exists and is accessible to this provider.
    // Do NOT JOIN public.users here — provider RLS (users_select_own) only allows
    // reading the provider's own user row, so a JOIN to the homeowner's row returns
    // 0 rows and makes the whole query look like "Tender not found".
    const tenderCheck = await db.queryAsUser(req.user.id, `
      SELECT t.id, t.client_id, t.status,
             st.display_name AS service_name
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE t.id = $1
    `, [tender_id]);

    if (tenderCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found.' });
    }

    const tender = tenderCheck.rows[0];

    // Step 2: fetch homeowner contact info using the superuser pool (bypasses RLS).
    // This is safe — it's a backend-only operation never exposed to the client.
    const ownerResult = await db.query(
      `SELECT email, (first_name || ' ' || last_name) AS client_name FROM public.users WHERE id = $1`,
      [tender.client_id]
    );
    tender.client_email = ownerResult.rows[0]?.email ?? null;
    tender.client_name  = ownerResult.rows[0]?.client_name ?? 'Homeowner';

    if (tender.status !== 'open') {
      return res.status(409).json({ success: false, message: 'This tender is no longer accepting quotes.' });
    }

    if (tender.client_id === req.user.id) {
      return res.status(403).json({ success: false, message: 'You cannot quote on your own tender.' });
    }

    // Insert the quote — unique constraint will catch duplicates
    const insertResult = await db.queryAsUser(req.user.id, `
      INSERT INTO public.quotes (
        tender_id, provider_id, amount, timeline,
        preferred_start_date, message, what_is_included
      ) VALUES ($1, $2, $3, $4::quote_timeline, $5::date, $6, $7)
      RETURNING *
    `, [
      tender_id,
      req.user.id,
      amountCents,
      timeline,
      preferred_start_date || null,
      message.trim(),
      what_is_included ? what_is_included.trim() : null,
    ]);

    const quote = insertResult.rows[0];

    // Bump the tender's quotes_count using superuser pool — provider RLS blocks
    // tenders UPDATE (tenders_update_own requires client_id = current_user_id).
    await db.query(
      `UPDATE public.tenders SET quotes_count = quotes_count + 1, updated_at = NOW() WHERE id = $1`,
      [tender_id]
    );

    res.status(201).json({ success: true, quote });

    // Fire-and-forget side effects — must not block the response
    const providerName = `${req.user.first_name} ${req.user.last_name}`.trim();

    Promise.allSettled([
      // Realtime toast to the homeowner
      notifyUser(tender.client_id, 'quote-submitted', {
        tenderId: tender_id,
        quoteId: quote.id,
        providerName,
        amount: amountCents,
      }),

      // Notify the provider's own channel so their stats update
      notifyUser(req.user.id, 'quote-submitted', { tenderId: tender_id, quoteId: quote.id }),

      // Email the homeowner
      sendNewQuoteEmail(tender.client_email, {
        homeownerName: tender.client_name,
        providerName,
        tenderTitle: tender.service_name || 'your job',
        amount: amountCents,
      }),

      // Insert a notification row for the homeowner
      db.query(`
        INSERT INTO public.notifications (user_id, type, title, body, data)
        VALUES ($1, 'quote_received', $2, $3, $4::jsonb)
      `, [
        tender.client_id,
        `New quote from ${providerName}`,
        `${providerName} submitted a quote of $${Math.round(amountCents / 100).toLocaleString()} on your ${tender.service_name || 'job'} tender.`,
        JSON.stringify({ tenderId: tender_id, quoteId: quote.id }),
      ]),

      // Web Push to homeowner's devices
      sendPushToUser(tender.client_id, {
        title: `New quote from ${providerName}`,
        body:  `$${Math.round(amountCents / 100).toLocaleString()} for your ${tender.service_name || 'job'} — tap to review`,
        type:  'new_quote',
        url:   '/dashboard',
        data:  { tender_id, quote_id: quote.id },
      }),
    ]).catch((err) => {
      console.warn('POST /api/quotes — side-effect error:', err.message);
    });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_QUOTED',
        message: 'You have already submitted a quote for this tender.',
      });
    }
    console.error('POST /api/quotes error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit quote.' });
  }
});

// ============================================================
// GET /api/quotes/received
// Returns all quotes on the homeowner's tenders.
// Optional query param: ?tender_id=<uuid> to filter by tender.
// ============================================================
router.get('/received', authenticate, authorize('homeowner'), async (req, res) => {
  const { tender_id } = req.query;
  try {
    const params = [req.user.id];
    let extra = '';
    if (tender_id) {
      params.push(tender_id);
      extra = ` AND q.tender_id = $2`;
    }
    const result = await db.query(`
      SELECT
        q.id, q.tender_id, q.amount, q.timeline, q.preferred_start_date,
        q.message, q.what_is_included, q.status, q.created_at,
        u.id         AS provider_id,
        u.first_name AS provider_first_name,
        u.last_name  AS provider_last_name,
        st.display_name AS tender_title,
        st.emoji        AS tender_emoji
      FROM public.quotes q
      JOIN public.tenders t  ON t.id  = q.tender_id
      JOIN public.users   u  ON u.id  = q.provider_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE t.client_id = $1${extra}
      ORDER BY q.created_at DESC
    `, params);
    res.json({ success: true, quotes: result.rows });
  } catch (err) {
    console.error('GET /api/quotes/received error:', err);
    res.status(500).json({ success: false, message: 'Failed to load quotes.' });
  }
});

// ============================================================
// PATCH /api/quotes/:id/accept
// Homeowner accepts a quote; all other quotes on the same tender
// are set to 'rejected'.
// ============================================================
router.patch('/:id/accept', authenticate, authorize('homeowner'), async (req, res) => {
  const { id } = req.params;
  try {
    const check = await db.query(`
      SELECT q.id, q.tender_id, q.provider_id, t.client_id
      FROM public.quotes q
      JOIN public.tenders t ON t.id = q.tender_id
      WHERE q.id = $1
    `, [id]);

    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quote not found.' });
    }
    const row = check.rows[0];
    if (row.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    // Reject every other quote on the tender; capture the losing providers so we
    // can push them a realtime event (their "My Quotes" flips to "Not selected").
    const rejected = await db.query(
      `UPDATE public.quotes SET status = 'rejected', updated_at = NOW()
       WHERE tender_id = $1 AND id != $2 RETURNING id, provider_id`,
      [row.tender_id, id]
    );
    await db.query(
      `UPDATE public.quotes SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({ success: true });

    // Realtime fan-out — winner first, then each losing provider.
    notifyUser(row.provider_id, 'quote-accepted', { quoteId: id, tenderId: row.tender_id }).catch(() => {});
    for (const r of rejected.rows) {
      notifyUser(r.provider_id, 'quote-rejected', { quoteId: r.id, tenderId: row.tender_id }).catch(() => {});
    }
  } catch (err) {
    console.error('PATCH /api/quotes/:id/accept error:', err);
    res.status(500).json({ success: false, message: 'Failed to accept quote.' });
  }
});

// ============================================================
// GET /api/quotes/mine
// Returns all quotes submitted by the current provider.
// ============================================================
router.get('/mine', authenticate, authorize('provider'), async (req, res) => {
  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        q.id, q.tender_id, q.amount, q.timeline, q.preferred_start_date,
        q.message, q.what_is_included, q.status, q.created_at,
        t.parish, t.urgency, t.category,
        st.display_name AS service_name,
        st.emoji        AS service_emoji
      FROM public.quotes q
      JOIN public.tenders t ON t.id = q.tender_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE q.provider_id = $1
      ORDER BY q.created_at DESC
    `, [req.user.id]);

    res.json({ success: true, quotes: result.rows });
  } catch (err) {
    console.error('GET /api/quotes/mine error:', err);
    res.status(500).json({ success: false, message: 'Failed to load quotes.' });
  }
});

// ============================================================
// GET /api/quotes/:id
// Returns full details of a single quote.
// Must come AFTER all static paths (/received, /mine) so the
// wildcard /:id does not shadow them.
// Access: homeowner who owns the tender, OR provider who submitted the quote.
// ============================================================
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(`
      SELECT
        q.id, q.tender_id, q.amount, q.timeline, q.preferred_start_date,
        q.message, q.what_is_included, q.status, q.created_at,
        u.id         AS provider_id,
        u.first_name AS provider_first_name,
        u.last_name  AS provider_last_name,
        st.display_name AS tender_title,
        st.emoji        AS tender_emoji,
        t.client_id
      FROM public.quotes q
      JOIN public.tenders t  ON t.id  = q.tender_id
      JOIN public.users   u  ON u.id  = q.provider_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE q.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quote not found.' });
    }

    const row = result.rows[0];
    const isHomeowner = req.user.role === 'homeowner' && row.client_id === req.user.id;
    const isProvider  = req.user.role === 'provider'  && row.provider_id === req.user.id;

    if (!isHomeowner && !isProvider) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    const { client_id: _omit, ...quote } = row;
    res.json({ success: true, quote });
  } catch (err) {
    console.error('GET /api/quotes/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to load quote.' });
  }
});

module.exports = router;
