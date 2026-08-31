require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function debug() {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', 'fe2803a5-2f6e-4319-b57e-d46962c0afc8')
    .single();
  
  if (error) {
    console.error("Error with single():", error);
  } else {
    console.log("Success with single():", data);
  }

  const { data: allData, error: allError } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('username', 'webmaster');
    
  console.log("Without single() count for username=webmaster:", allData ? allData.length : allError);
}
debug();
