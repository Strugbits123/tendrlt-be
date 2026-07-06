const express = require('express');
const db = require('../db');
const { sendContactNotification } = require('../lib/contactEmails');
const { requireTurnstile } = require('../lib/turnstile');

const router = express.Router();

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const VALID_ROLES = ['homeowner', 'provider', 'other'];

// ============================================================
// POST /api/contact  (public — no auth, bot-protected by Turnstile)
// Stores a contact-form submission and emails all admins.
// ============================================================
router.post('/', requireTurnstile, async (req, res) => {
  const first_name = (req.body.first_name || '').trim();
  const last_name = (req.body.last_name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const role = (req.body.role || '').trim();
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();

  // Validation
  if (!first_name || !email || !subject || !message) {
    return res.status(400).json({ success: false, message: 'Please fill in all required fields.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
  }
  if (first_name.length > 100 || last_name.length > 100 || subject.length > 150) {
    return res.status(400).json({ success: false, message: 'One or more fields are too long.' });
  }
  if (message.length > 5000) {
    return res.status(400).json({ success: false, message: 'Message is too long (max 5000 characters).' });
  }
  const safeRole = VALID_ROLES.includes(role) ? role : null;

  try {
    // Store (superuser — public submission, RLS reserved for admin reads)
    const inserted = await db.query(
      `INSERT INTO public.contact_messages (first_name, last_name, email, role, subject, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [first_name, last_name || null, email, safeRole, subject, message]
    );
    const id = inserted.rows[0].id;

    // Respond immediately — the submission is safely stored.
    res.status(201).json({ success: true, message: 'Your message has been received. Our team will get back to you shortly.' });

    // Fire-and-forget: notify every admin (Reply-To = submitter so they can reply directly).
    (async () => {
      try {
        const admins = await db.query(`SELECT email FROM public.users WHERE role = 'admin' AND email IS NOT NULL`);
        const adminEmails = admins.rows.map((r) => r.email).filter(Boolean);
        if (!adminEmails.length) {
          console.warn('[contact] No admin users found — submission stored but no notification sent.');
          return;
        }
        await sendContactNotification(adminEmails, { id, first_name, last_name, email, role: safeRole, subject, message });
      } catch (err) {
        console.error('[contact] admin notification error:', err.message);
      }
    })();
  } catch (err) {
    console.error('POST /api/contact error:', err.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
