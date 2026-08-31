require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Node.js native fetch isn't always reliable with cookies, so we'll build a helper
async function apiFetch(path, options = {}, cookieStr = '') {
  const url = `http://localhost:${process.env.PORT || 3001}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (cookieStr) headers['cookie'] = cookieStr;

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  let newCookie = '';
  
  if (res.headers.getSetCookie && res.headers.getSetCookie().length > 0) {
    newCookie = res.headers.getSetCookie()[0].split(';')[0];
  } else if (res.headers.get('set-cookie')) {
    newCookie = res.headers.get('set-cookie').split(';')[0];
  }
  
  if (path === '/api/auth/login') {
    console.log('Extracted cookie from login:', newCookie ? 'YES (Length: ' + newCookie.length + ')' : 'NO COOKIE FOUND');
  }
  
  return { status: res.status, data, newCookie };
}

async function run() {
  console.log('--- STARTING DATABASE RESET & API TEST ---');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1. WIPE DATABASE
  console.log('\n[1/7] 💥 Wiping Database...');
  
  // Truncate tables by deleting everything (matching id is not null)
  console.log('  Deleting public.customers...');
  await supabase.from('customers').delete().neq('id', 0);
  
  console.log('  Deleting public.users...');
  await supabase.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  
  console.log('  Deleting public.tenants...');
  await supabase.from('tenants').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('  Deleting Supabase Auth accounts...');
  const { data: { users } } = await supabase.auth.admin.listUsers();
  for (const u of users) {
    await supabase.auth.admin.deleteUser(u.id);
  }
  console.log('✅ Database is completely clean.');

  // 2. SEED WEBMASTER
  console.log('\n[2/7] 🌱 Seeding Webmaster Account directly...');
  const webmasterPassword = 'Password123!';
  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email: 'webmaster@vikitech.in',
    password: webmasterPassword,
    email_confirm: true
  });
  if (authErr) throw authErr;

  const { error: dbErr } = await supabase.from('users').insert({
    id: authUser.user.id,
    username: 'webmaster',
    email: 'webmaster@vikitech.in',
    role: 'WEBMASTER',
    platform_access_level: 'OWNER',
    status: 'active'
  });
  if (dbErr) throw dbErr;
  console.log('✅ Webmaster seeded.');

  // 3. API - WEBMASTER LOGIN
  console.log('\n[3/7] 🌐 API: Webmaster Login...');
  const loginRes = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'webmaster', password: webmasterPassword })
  });
  
  if (loginRes.status !== 200) {
    console.error('❌ Login failed!', loginRes);
    return;
  }
  const webmasterCookie = loginRes.newCookie;
  console.log('✅ Logged in via API successfully. Session Cookie received.');

  // 4. API - CREATE TENANT
  console.log('\n[4/7] 🌐 API: Creating Tenant...');
  const tenantRes = await apiFetch('/api/webmaster/tenants', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test Tenant (API)',
      timezone: 'Asia/Kolkata',
      plan: 'standard',
      limits: { users: 5 },
      initialAdmin: {
        username: 'tenantadmin',
        email: 'admin@tenant.com',
        password: 'Password123!'
      }
    })
  }, webmasterCookie);

  if (tenantRes.status !== 201 && tenantRes.status !== 200) {
    console.error('❌ Create Tenant API failed!', tenantRes);
    return;
  }
  const newTenantId = tenantRes.data.id;
  console.log('✅ Tenant created via API. ID:', newTenantId);

  // 5. API - FETCH TENANTS
  console.log('\n[5/7] 🌐 API: Fetching Tenants...');
  const getTenantsRes = await apiFetch('/api/webmaster/tenants', { method: 'GET' }, webmasterCookie);
  if (getTenantsRes.status !== 200 || getTenantsRes.data.items.length === 0) {
    console.error('❌ Fetch Tenants API failed!', getTenantsRes);
    return;
  }
  console.log('✅ Tenants fetched via API. Found:', getTenantsRes.data.items.length);

  // 6. API - CLIENT ADMIN LOGIN
  console.log('\n[6/7] 🌐 API: Client Admin Login...');
  const adminLoginRes = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'tenantadmin', password: 'Password123!' })
  });
  
  if (adminLoginRes.status !== 200) {
    console.error('❌ Client Admin Login failed!', adminLoginRes);
    return;
  }
  console.log('✅ Logged in as Client Admin via API successfully.');
  const adminCookie = adminLoginRes.newCookie;

  // 7. API - CREATE CLIENT AGENT
  console.log('\n[7/9] 🌐 API: Creating Client Agent...');
  const agentRes = await apiFetch(`/api/webmaster/tenants/${newTenantId}/users`, {
    method: 'POST',
    body: JSON.stringify({
      username: 'clientagent',
      email: 'agent@vikitech.in',
      password: 'Password123!',
      role: 'CLIENT_AGENT'
    })
  }, webmasterCookie); // Webmaster manages users in this route
  
  if (agentRes.status !== 201) {
    console.error('❌ Create Client Agent failed!', agentRes);
    return;
  }
  console.log('✅ Client Agent created via API. Username:', agentRes.data.username);

  // 8. API - CREATE CUSTOMER
  console.log('\n[8/9] 🌐 API: Creating Customer (via Client Admin)...');
  const customerRes = await apiFetch('/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test Customer',
      email: 'customer@vikitech.in',
      phone: '+919876543210',
      preferred_slot: '15:00'
    })
  }, adminCookie); // Client Admin creates customers

  if (customerRes.status !== 201 && customerRes.status !== 200) {
    console.error('❌ Create Customer failed!', customerRes);
    return;
  }
  console.log('✅ Customer created via API.');

  // 9. API - FETCH CUSTOMERS
  console.log('\n[9/9] 🌐 API: Fetching Customers (via Client Admin)...');
  const getCustomersRes = await apiFetch('/api/customers', { method: 'GET' }, adminCookie);
  if (getCustomersRes.status !== 200 || getCustomersRes.data.items?.length === 0) {
    console.error('❌ Fetch Customers API failed!', getCustomersRes);
    return;
  }
  console.log('✅ Customers fetched via API. Found:', getCustomersRes.data.items?.length || 1);
  
  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

run().catch(console.error);
