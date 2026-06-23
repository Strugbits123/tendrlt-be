const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// GET /api/notifications
// Returns the current user's notifications + unread count.
// ============================================================
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT id, type, title, body, data, read, created_at
      FROM public.notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.id]);

    const unreadCount = result.rows.filter(n => !n.read).length;
    res.json({ success: true, notifications: result.rows, unreadCount });
  } catch (err) {
    console.error('GET /api/notifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to load notifications.' });
  }
});

// ============================================================
// PATCH /api/notifications/read-all
// Marks all of the current user's notifications as read.
// Must be defined BEFORE /:id/read to avoid Express matching
// "read-all" as the :id param.
// ============================================================
router.patch('/read-all', authenticate, async (req, res) => {
  try {
    await db.queryAsUser(req.user.id, `
      UPDATE public.notifications SET read = true WHERE user_id = $1 AND read = false
    `, [req.user.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/notifications/read-all error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark all read.' });
  }
});

// ============================================================
// PATCH /api/notifications/:id/read
// Marks a single notification as read.
// ============================================================
router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    await db.queryAsUser(req.user.id, `
      UPDATE public.notifications SET read = true
      WHERE id = $1 AND user_id = $2
    `, [req.params.id, req.user.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/notifications/:id/read error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark notification read.' });
  }
});

module.exports = router;
