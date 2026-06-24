const express    = require('express');
const db         = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/push/vapid-public-key ───────────────────────────────────────────
// Returns the VAPID public key so the frontend can subscribe.
// Public endpoint — no auth required.
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ success: false, message: 'Push not configured.' });
  res.json({ success: true, publicKey: key });
});

// ── POST /api/push/subscribe ─────────────────────────────────────────────────
// Saves (or updates) a push subscription for the authenticated user.
// Body: { endpoint, keys: { p256dh, auth }, userAgent? }
router.post('/subscribe', authenticate, async (req, res) => {
  const { endpoint, keys, userAgent } = req.body;

  console.log(`[push] POST /subscribe — user=${req.user?.id}, endpoint_tail=…${endpoint?.slice(-30)}`);

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    console.warn('[push] Subscribe rejected — missing endpoint or keys:', { endpoint: !!endpoint, p256dh: !!keys?.p256dh, auth: !!keys?.auth });
    return res.status(400).json({ success: false, message: 'Invalid subscription object.' });
  }

  try {
    await db.query(`
      INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (endpoint)
        DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, user_agent = $5,
                      updated_at = TIMEZONE('utc', NOW())
    `, [req.user.id, endpoint, keys.p256dh, keys.auth, userAgent || null]);

    console.log(`[push] ✓ Subscription saved for user ${req.user.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[push] POST /api/push/subscribe DB error:', err.message, '| code:', err.code);
    res.status(500).json({ success: false, message: 'Failed to save subscription.', detail: err.message });
  }
});

// ── DELETE /api/push/unsubscribe ─────────────────────────────────────────────
// Removes a push subscription (called when the user disables notifications).
// Body: { endpoint }
router.delete('/unsubscribe', authenticate, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ success: false, message: 'endpoint required.' });

  try {
    await db.query(
      'DELETE FROM public.push_subscriptions WHERE endpoint = $1 AND user_id = $2',
      [endpoint, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/push/unsubscribe error:', err);
    res.status(500).json({ success: false, message: 'Failed to remove subscription.' });
  }
});

module.exports = router;
