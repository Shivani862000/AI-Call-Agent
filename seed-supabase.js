require('dotenv').config();
const { supabase } = require('./src/supabase');
const bcrypt = require('bcrypt');

async function seed() {
  console.log('Seeding Supabase database...');

  // 1. Hash password
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash('password123', salt);

  // 2. Create Webmaster (Owner)
  console.log('Creating webmaster user...');
  const { data: webmaster, error: webmasterErr } = await supabase
    .from('users')
    .upsert({
      username: 'webmaster@vikitech.in',
      email: 'webmaster@vikitech.in',
      password_hash: passwordHash,
      role: 'WEBMASTER',
      platform_access_level: 'OWNER',
      status: 'active'
    }, { onConflict: 'username' })
    .select()
    .single();

  if (webmasterErr) console.error('Error creating webmaster:', webmasterErr.message);

  // 3. Create Support
  console.log('Creating support user...');
  const { data: support, error: supportErr } = await supabase
    .from('users')
    .upsert({
      username: 'support@vikitech.in',
      email: 'support@vikitech.in',
      password_hash: passwordHash,
      role: 'SUPPORT_TEAM',
      platform_access_level: 'ADMIN',
      status: 'active'
    }, { onConflict: 'username' })
    .select()
    .single();

  if (supportErr) console.error('Error creating support:', supportErr.message);

  // 4. Create Tenant Apollo
  console.log('Creating Apollo tenant...');
  const { data: apolloTenant, error: apolloErr } = await supabase
    .from('tenants')
    .upsert({
      name: 'Apollo',
      status: 'active',
      daily_report_time: '19:00'
    }, { onConflict: 'name' })
    .select()
    .single();

  if (apolloErr) {
    console.error('Error creating Apollo:', apolloErr.message);
  } else {
    // Apollo Admin
    await supabase.from('users').upsert({
      username: 'admin@apollo.in',
      email: 'admin@apollo.in',
      password_hash: passwordHash,
      role: 'CLIENT_ADMIN',
      tenant_id: apolloTenant.id,
      status: 'active'
    }, { onConflict: 'username' });
  }

  // 5. Create Tenant Max
  console.log('Creating Max tenant...');
  const { data: maxTenant, error: maxErr } = await supabase
    .from('tenants')
    .upsert({
      name: 'Max',
      status: 'active',
      daily_report_time: '19:00'
    }, { onConflict: 'name' })
    .select()
    .single();

  if (maxErr) {
    console.error('Error creating Max:', maxErr.message);
  } else {
    // Max Admin
    await supabase.from('users').upsert({
      username: 'admin@max.in',
      email: 'admin@max.in',
      password_hash: passwordHash,
      role: 'CLIENT_ADMIN',
      tenant_id: maxTenant.id,
      status: 'active'
    }, { onConflict: 'username' });
  }

  console.log('✅ Seeding complete!');
  console.log('\n--- Login Credentials ---');
  console.log('Webmaster Console: webmaster@vikitech.in / password123');
  console.log('Support Console:   support@vikitech.in / password123');
  console.log('Apollo Admin:      admin@apollo.in / password123');
  console.log('Max Admin:         admin@max.in / password123');
}

seed();
