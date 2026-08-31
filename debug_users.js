require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function debug() {
  const { data: users, error } = await supabaseAdmin.from('users').select('*');
  if (error) console.error("Error fetching users:", error);
  else console.log("Current users in DB:", JSON.stringify(users, null, 2));
}

debug();
