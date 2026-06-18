// Shared Supabase client using the service role key (bypasses storage RLS).
// Used by provider upload endpoints and the admin verification routes
// (signed URLs for the private provider-documents bucket).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = supabase;
