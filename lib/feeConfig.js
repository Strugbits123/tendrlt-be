/**
 * Platform fee configuration helpers.
 *
 * Single source of truth for reading the ACTIVE two-sided platform fee and for
 * promoting scheduled (pending) fee changes when their effective date arrives.
 * See documentation/PAYMENTS_AND_JOB_WORKFLOW.md
 * ("Platform fee scheduling & creation-time snapshots").
 */
const db = require('../db');

// Safe fallbacks — mirror lib/fees.ts / the config seed.
const DEFAULT_CLIENT_RATE = 9.5;
const DEFAULT_PROVIDER_RATE = 12;

// Jamaica is America/Jamaica = EST (UTC-5) all year — no DST since 1983 — so the
// Jamaica calendar date is always UTC shifted back 5 hours. Returned as
// 'YYYY-MM-DD' for direct comparison against DATE columns.
function jamaicaToday() {
  const shifted = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

const num = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The currently-active two-sided rates (percentages, e.g. 9.5). This is what
 * the tender/quote creation paths snapshot and what GET /api/fees returns.
 */
async function getActiveRates() {
  const r = await db.query(
    'SELECT client_rate, provider_rate FROM public.platform_fee_config WHERE id = 1'
  );
  const row = r.rows[0] || {};
  return {
    clientRate: num(row.client_rate, DEFAULT_CLIENT_RATE),
    providerRate: num(row.provider_rate, DEFAULT_PROVIDER_RATE),
  };
}

/**
 * Promote any pending fee change whose effective date has arrived (in Jamaica
 * time) into the active rate, then clear that pending slot. Runs at startup and
 * daily at 05:05 UTC (00:05 Jamaica). Idempotent — safe to run repeatedly.
 *
 * @param {(channel:string, event:string, payload:object)=>any} [broadcast]
 *        optional notifyChannel to push a live 'fees-updated' event when the
 *        active rate actually changes.
 * @returns {Promise<{changed: boolean, clientRate: number, providerRate: number}>}
 */
async function activateDueFees(broadcast) {
  const today = jamaicaToday();
  // Promote each side independently; only when a pending value exists AND is due.
  const upd = await db.query(
    `UPDATE public.platform_fee_config
        SET client_rate = CASE
              WHEN pending_client_rate IS NOT NULL AND pending_client_effective <= $1::date
              THEN pending_client_rate ELSE client_rate END,
            client_effective = CASE
              WHEN pending_client_rate IS NOT NULL AND pending_client_effective <= $1::date
              THEN pending_client_effective ELSE client_effective END,
            pending_client_rate = CASE
              WHEN pending_client_rate IS NOT NULL AND pending_client_effective <= $1::date
              THEN NULL ELSE pending_client_rate END,
            pending_client_effective = CASE
              WHEN pending_client_rate IS NOT NULL AND pending_client_effective <= $1::date
              THEN NULL ELSE pending_client_effective END,

            provider_rate = CASE
              WHEN pending_provider_rate IS NOT NULL AND pending_provider_effective <= $1::date
              THEN pending_provider_rate ELSE provider_rate END,
            provider_effective = CASE
              WHEN pending_provider_rate IS NOT NULL AND pending_provider_effective <= $1::date
              THEN pending_provider_effective ELSE provider_effective END,
            pending_provider_rate = CASE
              WHEN pending_provider_rate IS NOT NULL AND pending_provider_effective <= $1::date
              THEN NULL ELSE pending_provider_rate END,
            pending_provider_effective = CASE
              WHEN pending_provider_rate IS NOT NULL AND pending_provider_effective <= $1::date
              THEN NULL ELSE pending_provider_effective END,
            updated_at = NOW()
      WHERE id = 1
        AND (
          (pending_client_rate   IS NOT NULL AND pending_client_effective   <= $1::date) OR
          (pending_provider_rate IS NOT NULL AND pending_provider_effective <= $1::date)
        )
      RETURNING client_rate, provider_rate`,
    [today]
  );

  if (upd.rows.length === 0) {
    const cur = await getActiveRates();
    return { changed: false, ...cur };
  }

  const clientRate = num(upd.rows[0].client_rate, DEFAULT_CLIENT_RATE);
  const providerRate = num(upd.rows[0].provider_rate, DEFAULT_PROVIDER_RATE);
  console.log(`[feeConfig] activated scheduled fee change → client ${clientRate}%, provider ${providerRate}% (Jamaica ${today})`);
  if (typeof broadcast === 'function') {
    try {
      broadcast('platform-fees', 'fees-updated', { clientRate, providerRate });
    } catch (e) {
      console.warn('[feeConfig] fees-updated broadcast failed:', e.message);
    }
  }
  return { changed: true, clientRate, providerRate };
}

module.exports = { jamaicaToday, getActiveRates, activateDueFees, DEFAULT_CLIENT_RATE, DEFAULT_PROVIDER_RATE };
