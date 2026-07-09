/**
 * Daily activation of scheduled platform fee changes.
 *
 * Jamaica (America/Jamaica) is EST/UTC-5 year-round (no DST), so "00:05 Jamaica"
 * is a fixed 05:05 UTC every day. We avoid a cron dependency with a small
 * self-rescheduling timer, and also run once at startup so a pending change
 * whose date passed while the server was down still activates.
 *
 * See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
 */
const { activateDueFees } = require('./feeConfig');
const { notifyChannel } = require('./realtimeService');

const TARGET_UTC_HOUR = 5;   // 05:xx UTC
const TARGET_UTC_MIN = 5;    // :05  → 00:05 America/Jamaica

// ms until the next 05:05 UTC from now.
function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    TARGET_UTC_HOUR, TARGET_UTC_MIN, 0, 0
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function runOnce(label) {
  try {
    const res = await activateDueFees(notifyChannel);
    if (res.changed) {
      console.log(`[feeScheduler] (${label}) activated due fee change.`);
    }
  } catch (err) {
    console.warn(`[feeScheduler] (${label}) activateDueFees failed:`, err.message);
  }
}

function scheduleNext() {
  const delay = msUntilNextRun();
  // setTimeout caps at ~24.8 days; our delay is always < 24h, so it's safe.
  setTimeout(async () => {
    await runOnce('daily 00:05 Jamaica');
    scheduleNext();
  }, delay).unref?.(); // don't keep the event loop alive just for this timer
  const hrs = Math.round((delay / 3_600_000) * 10) / 10;
  console.log(`[feeScheduler] next fee-activation run in ~${hrs}h (05:05 UTC / 00:05 Jamaica).`);
}

function startFeeScheduler() {
  // Catch-up at boot, then align to the daily slot.
  runOnce('startup catch-up');
  scheduleNext();
}

module.exports = { startFeeScheduler };
