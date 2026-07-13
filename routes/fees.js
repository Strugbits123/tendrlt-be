const express = require('express');
const db = require('../db');

const router = express.Router();

// ============================================================
// GET /api/fees — PUBLIC current platform fee rates.
// Read by the frontend (lib/fees) so the whole app uses the admin-configured
// rates instead of build-time env vars. Cached briefly; live updates arrive via
// the 'platform-fees' realtime channel.
// ============================================================
router.get('/', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT client_rate, provider_rate, client_effective, provider_effective, min_fee_enabled, min_client_fee, min_provider_fee FROM public.platform_fee_config WHERE id = 1'
    );
    const row = r.rows[0] || { client_rate: 9.5, provider_rate: 12 };
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    res.json({
      success: true,
      clientRate: parseFloat(row.client_rate),
      providerRate: parseFloat(row.provider_rate),
      clientEffective: row.client_effective,
      providerEffective: row.provider_effective,
      // Minimum-fee floor (JMD cents) + toggle.
      minFeeEnabled: row.min_fee_enabled !== false,
      minClientFee: row.min_client_fee != null ? parseInt(row.min_client_fee, 10) : 10000,
      minProviderFee: row.min_provider_fee != null ? parseInt(row.min_provider_fee, 10) : 10000,
    });
  } catch (err) {
    console.error('GET /api/fees error:', err);
    // Never hard-fail the app over fees — return safe defaults.
    res.status(200).json({ success: true, clientRate: 9.5, providerRate: 12, minFeeEnabled: true, minClientFee: 10000, minProviderFee: 10000 });
  }
});

module.exports = router;
