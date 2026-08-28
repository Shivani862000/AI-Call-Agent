'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Warning: SUPABASE_URL and SUPABASE_SECRET_KEY must be provided for database operations.');
}

// We use the SECRET_KEY to bypass RLS in server-side operations, as it is a service role.
const supabase = createClient(supabaseUrl || 'https://example.supabase.co', supabaseKey || 'dummy_key');

module.exports = { supabase };
