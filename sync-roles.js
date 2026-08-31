require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function run() {
  console.log("Fetching users from public.users...");
  const { data: users, error } = await supabase.from('users').select('id, role');
  
  if (error) {
    console.error("Error fetching users:", error);
    return;
  }
  
  for (const user of users) {
    console.log(`Updating auth metadata for user ${user.id} -> role: ${user.role}`);
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { role: user.role }
    });
    
    if (updateError) {
      console.error(`Failed to update user ${user.id}:`, updateError.message);
    }
  }
  
  console.log("Done syncing roles to Auth.");
}

run();
