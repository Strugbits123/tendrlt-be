/**
 * Web Push notification service using VAPID.
 *
 * sendPushToUser(userId, payload)
 *   Fans out a push notification to every device the user has subscribed with.
 *   410 Gone responses (expired subscriptions) are pruned automatically.
 *   All errors are non-fatal — a failed push never rejects the caller.
 */

const webpush = require('web-push');
const db      = require('../db');

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'noreply@tendrit.com'}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/**
 * @param {string} userId
 * @param {{ title: string, body: string, icon?: string, url?: string, type?: string, data?: object }} payload
 */
async function sendPushToUser(userId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID keys not configured — skipping push');
    return;
  }

  let subs;
  try {
    const result = await db.query(
      'SELECT id, endpoint, p256dh, auth FROM public.push_subscriptions WHERE user_id = $1',
      [userId]
    );
    subs = result.rows;
  } catch (err) {
    console.warn('[push] Failed to fetch subscriptions:', err.message);
    return;
  }

  if (!subs.length) {
    // This is the most common reason push doesn't fire — the user clicked "Enable" but
    // either the browser blocked the permission request, the POST to /api/push/subscribe
    // failed, or they simply haven't enabled push yet.
    console.log(`[push] No push subscriptions found for user ${userId} — skipping push`);
    return;
  }

  console.log(`[push] Sending to ${subs.length} subscription(s) for user ${userId}`);

  // Omit 'badge' — it maps to a local icon path that may not exist in Next.js builds,
  // and a missing badge resource silently prevents notification display on Android Chrome.
  const notification = JSON.stringify({
    title:     payload.title   || 'TendrIt',
    body:      payload.body    || 'You have a new notification',
    icon:      payload.icon    || '/icon-192x192.png',
    url:       payload.url     || '/',
    type:      payload.type    || 'general',
    data:      payload.data    || {},
    timestamp: new Date().toISOString(),
  });

  const expiredEndpoints = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          notification,
          { TTL: 86400 }  // 24 h TTL — deliver even if device is offline
        );
        console.log(`[push] ✓ Delivered to endpoint …${sub.endpoint.slice(-30)}`);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired or the user manually unsubscribed — prune it
          console.log(`[push] Subscription expired (${err.statusCode}), removing …${sub.endpoint.slice(-30)}`);
          expiredEndpoints.push(sub.endpoint);
        } else {
          console.warn(`[push] Failed to send to …${sub.endpoint.slice(-30)}:`, err.statusCode, err.message);
        }
      }
    })
  );

  if (expiredEndpoints.length > 0) {
    db.query(
      'DELETE FROM public.push_subscriptions WHERE endpoint = ANY($1)',
      [expiredEndpoints]
    ).catch(e => console.warn('[push] Failed to prune expired subs:', e.message));
  }
}

module.exports = { sendPushToUser };
