const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyUser } = require('../lib/realtimeService');
const { sendNewQuoteEmail } = require('../lib/quoteEmails');

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
    // Verify tender exists, is open, and is not the provider's own tender
    const tenderCheck = await db.queryAsUser(req.user.id, `
      SELECT t.id, t.client_id, t.status,
             u.email AS client_email,
             (u.first_name || ' ' || u.last_name) AS client_name,
             st.display_name AS service_name
      FROM public.tenders t
      JOIN public.users u ON u.id = t.client_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE t.id = $1
    `, [tender_id]);

    if (tenderCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found.' });
    }

    const tender = tenderCheck.rows[0];

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

    // Bump the tender's quotes_count
    await db.queryAsUser(req.user.id, `
      UPDATE public.tenders SET quotes_count = quotes_count + 1, updated_at = NOW()
      WHERE id = $1
    `, [tender_id]);

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
// GET /api/quotes/mine
// Returns all quotes submitted by the current provider.
// ============================================================
router.get('/mine', authenticate, authorize('provider'), async (req, res) => {
  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        q.id, q.tender_id, q.amount, q.timeline, q.preferred_start_date,
        q.message, q.what_is_included, q.status, q.created_at,
        t.parish, t.urgency,
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

module.exports = router;
