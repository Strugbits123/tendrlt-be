const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is missing in .env file!');
    process.exit(1);
  }

  console.log('Connecting to database...');
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false
  });

  try {
    const sqlPath = path.join(__dirname, '../db.sql');
    console.log(`Reading SQL schema from ${sqlPath}...`);
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Running SQL queries...');
    await pool.query(sql);
    console.log('Database tables, enums, triggers, and indices initialized successfully!');
  } catch (err) {
    console.error('Error executing database initialization:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initDb();
