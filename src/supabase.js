require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('WARNING: Missing SUPABASE_URL or SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY. The application might fail to connect to the database.');
}

if (supabaseKey === process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log('[SUPABASE INIT] Using SERVICE_ROLE_KEY');
} else if (supabaseKey === process.env.SUPABASE_ANON_KEY) {
  console.log('[SUPABASE INIT] Using ANON_KEY! RLS will apply!');
} else {
  console.log('[SUPABASE INIT] Using fallback key');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder_key', {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = supabase;
