const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function createAdmin() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.log('Usage: node create-admin.js <email> <password> <first_name> <last_name> [phone_number] [parish]');
    console.log('Example: node create-admin.js admin@tendrit.com secretpassword Admin User 8761112222 Kingston');
    process.exit(1);
  }

  const [email, password, firstName, lastName, phoneNumber, parish] = args;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is missing in .env file!');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false
  });

  try {
    // 1. Check if user already exists
    console.log(`Checking if email ${email} is already in use...`);
    const existCheck = await pool.query('SELECT id FROM public.users WHERE email = $1', [email.toLowerCase()]);
    if (existCheck.rows.length > 0) {
      console.error(`ERROR: A user with the email ${email} already exists!`);
      process.exit(1);
    }

    // 2. Hash password
    console.log('Hashing password...');
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 3. Insert user
    console.log('Inserting admin user...');
    const insertQuery = `
      INSERT INTO public.users (
        email, password_hash, first_name, last_name, phone_number, parish, role, is_email_verified
      ) VALUES ($1, $2, $3, $4, $5, $6, 'admin', true)
      RETURNING id, email, first_name, last_name;
    `;
    const result = await pool.query(insertQuery, [
      email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      phoneNumber || '876-000-0000',
      parish || 'Kingston'
    ]);

    const createdAdmin = result.rows[0];
    console.log('Admin user created successfully!');
    console.log('ID:', createdAdmin.id);
    console.log('Email:', createdAdmin.email);
    console.log('Name:', `${createdAdmin.first_name} ${createdAdmin.last_name}`);
  } catch (err) {
    console.error('Error creating admin user:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

createAdmin();
