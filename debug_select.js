require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function debug() {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('username, role, tenant_id, platform_access_level')
    .eq('id', 'fe2803a5-2f6e-4319-b57e-d46962c0afc8')
    .single();
  
  if (error) {
    console.error("Test 1 (with specific columns) Error:", error);
  } else {
    console.log("Test 1 (with specific columns) Success:", data);
  }

  const { data: d2, error: e2 } = await supabaseAdmin
    .from('users')
    .select('email')
    .eq('username', 'webmaster')
    .single();
    
  if (e2) {
    console.error("Test 2 (email lookup) Error:", e2);
  } else {
    console.log("Test 2 (email lookup) Success:", d2);
  }
}
debug();
