const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('WARNING: DATABASE_URL is not set in .env! Database queries will fail.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString && connectionString.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false
});

/**
 * Plain query — runs as postgres superuser, bypasses RLS.
 * Use ONLY for auth operations: login, register, verify-email, resend-verification.
 */
const query = (text, params) => pool.query(text, params);

/**
 * User-scoped query — enforces RLS.
 * Runs inside a transaction as the tendrit_app role with
 * app.current_user_id set to the authenticated user's UUID.
 * Use for all protected operations after authentication.
 *
 * @param {string} userId  - The authenticated user's UUID (req.user.id)
 * @param {string} text    - SQL query string
 * @param {Array}  params  - Query parameters
 */
const queryAsUser = async (userId, text, params) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE tendrit_app');
    await client.query(`SET LOCAL app.current_user_id = '${userId}'`);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { query, queryAsUser, pool };
