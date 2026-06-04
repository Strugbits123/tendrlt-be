const { Pool } = require('pg');
const path = require('path');
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

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
