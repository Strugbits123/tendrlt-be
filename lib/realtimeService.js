const supabase = require('./supabaseClient');

/**
 * Broadcast a real-time event to a specific user's channel.
 *
 * Uses the Supabase Realtime HTTP broadcast API (no persistent WebSocket
 * needed on the server). The frontend subscribes to `user-<userId>` with the
 * anon key and receives the event immediately.
 *
 * @param {string} userId  - UUID of the recipient
 * @param {string} event   - Event name (e.g. 'verification-approved')
 * @param {object} payload - Arbitrary data sent to the client
 */
async function notifyUser(userId, event, payload) {
  try {
    const channel = supabase.channel(`user-${userId}`);
    const result = await channel.send({
      type: 'broadcast',
      event,
      payload,
    });
    if (result !== 'ok') {
      console.warn(`[realtime] broadcast to user-${userId} returned: ${result}`);
    }
  } catch (err) {
    // Non-fatal — a failed notification should never break the main request
    console.warn(`[realtime] notifyUser error for ${userId}:`, err.message);
  }
}

/**
 * Broadcast a real-time event to a named shared channel.
 * Use this for admin-wide notifications (e.g. 'admin-verifications').
 *
 * @param {string} channelName - Realtime channel name (e.g. 'admin-verifications')
 * @param {string} event       - Event name (e.g. 'new-verification')
 * @param {object} payload     - Arbitrary data sent to subscribers
 */
async function notifyChannel(channelName, event, payload) {
  try {
    const channel = supabase.channel(channelName);
    const result = await channel.send({
      type: 'broadcast',
      event,
      payload,
    });
    if (result !== 'ok') {
      console.warn(`[realtime] broadcast to ${channelName} returned: ${result}`);
    }
  } catch (err) {
    console.warn(`[realtime] notifyChannel error for ${channelName}:`, err.message);
  }
}

module.exports = { notifyUser, notifyChannel };
