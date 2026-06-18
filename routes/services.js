const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * GET /api/services
 * Public — no auth required.
 * Returns all active service types ordered by sort_order.
 * Used by: signup, complete-profile, provider onboarding, post-job.
 */
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, slug, display_name, emoji, sort_order
       FROM public.service_types
       WHERE is_active = TRUE
       ORDER BY sort_order ASC, display_name ASC`
    );
    res.json({ success: true, services: result.rows });
  } catch (err) {
    console.error('GET /api/services error:', err);
    res.status(500).json({ success: false, message: 'Failed to load service types.' });
  }
});

module.exports = router;
