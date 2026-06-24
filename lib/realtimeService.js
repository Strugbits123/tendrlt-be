const supabase = require('./supabaseClient');

/**
 * Broadcast a real-time event to a specific user's channel via HTTP.
 *
 * Uses httpSend() — the explicit REST broadcast path introduced in
 * @supabase/realtime-js v2.37+. This avoids the deprecation warning that
 * the old channel.send() emitted when no WebSocket was connected:
 *   "Realtime send() is automatically falling back to REST API…"
 *
 * Each channel is created just for this send and immediately removed so the
 * server never accumulates idle WebSocket connections.
 *
 * @param {string} userId  - UUID of the recipient
 * @param {string} event   - Event name (e.g. 'verification-approved')
 * @param {object} payload - Arbitrary data sent to the client
 */
async function notifyUser(userId, event, payload) {
  try {
    const channel = supabase.channel(`user-${userId}`);
    const result  = await channel.httpSend(event, payload);
    if (!result?.success) {
      console.warn(`[realtime] broadcast to user-${userId} returned:`, result);
    }
    // Remove immediately — channels used only for HTTP send accumulate otherwise.
    await supabase.removeChannel(channel);
  } catch (err) {
    // Non-fatal — a failed notification should never break the main request
    console.warn(`[realtime] notifyUser error for ${userId}:`, err.message);
  }
}

/**
 * Broadcast a real-time event to a named shared channel via HTTP.
 * Use this for shared feeds (e.g. 'tenders-feed', 'admin-verifications').
 *
 * @param {string} channelName - Realtime channel name (e.g. 'admin-verifications')
 * @param {string} event       - Event name (e.g. 'new-verification')
 * @param {object} payload     - Arbitrary data sent to subscribers
 */
async function notifyChannel(channelName, event, payload) {
  try {
    const channel = supabase.channel(channelName);
    const result  = await channel.httpSend(event, payload);
    if (!result?.success) {
      console.warn(`[realtime] broadcast to ${channelName} returned:`, result);
    }
    await supabase.removeChannel(channel);
  } catch (err) {
    console.warn(`[realtime] notifyChannel error for ${channelName}:`, err.message);
  }
}

module.exports = { notifyUser, notifyChannel };
