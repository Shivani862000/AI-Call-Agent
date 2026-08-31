require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function upsertUser(email, password, role, tenantId, platformAccessLevel, username) {
  console.log(`\nUpserting user: ${email}...`);
  
  // 1. Check if user exists in Auth
  const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers();
  if (listError) {
    console.error(`[ERROR] Failed to list users: ${listError.message}`);
    return;
  }

  let user = listData.users.find(u => u.email === email);

  // 2. Create or Update in Auth
  if (!user) {
    const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: { role }
    });
    if (createError) {
      console.error(`[ERROR] Failed to create auth user ${email}:`, createError.message);
      return;
    }
    user = createData.user;
    console.log(`[OK] Created auth user ${email}`);
  } else {
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: password,
      email_confirm: true
    });
    if (updateError) {
      console.error(`[ERROR] Failed to update auth user ${email}:`, updateError.message);
      return;
    }
    console.log(`[OK] Updated password for ${email}`);
  }

  // 3. Sync to public.users
  const userPayload = {
    id: user.id,
    username: username,
    email: email,
    role: role,
    status: 'active'
  };
  
  if (tenantId) userPayload.tenant_id = tenantId;
  if (platformAccessLevel) userPayload.platform_access_level = platformAccessLevel;

  // Cleanup old conflicting user if any (since we manually inserted random UUIDs earlier)
  await supabaseAdmin.from('users').delete().eq('username', username).neq('id', user.id);

  const { data: syncData, error: syncError } = await supabaseAdmin
    .from('users')
    .upsert(userPayload, { onConflict: 'id' })
    .select();

  if (syncError) {
    console.error(`[ERROR] Failed to sync ${email} to public.users:`, syncError.message);
  } else if (!syncData || syncData.length === 0) {
    console.error(`[ERROR] Sync returned empty data. RLS might be blocking the Service Role key for ${email}.`);
  } else {
    console.log(`[OK] Synced ${email} to public.users. Row ID:`, syncData[0].id);
  }
}

async function main() {
  console.log("Starting Supabase User Seed...");

  // The tenant was already created via the SQL script you ran.
  const tenantId = '00000000-0000-0000-0000-000000000001';

  // Webmaster
  await upsertUser('webmaster@vikitech.in', 'WebmasterPassword123!', 'WEBMASTER', null, 'OWNER', 'webmaster');
  
  // Tenant Admin
  await upsertUser('admin@vikitech.in', 'AdminPassword123!', 'CLIENT_ADMIN', tenantId, null, 'admin');

  console.log("\nDone!");
}

main().catch(console.error);
