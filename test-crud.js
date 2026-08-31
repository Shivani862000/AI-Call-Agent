require('dotenv').config();
const supabase = require('./src/supabase');
const { createTenantService } = require('./src/webmaster/tenant-service');
const { createUserService } = require('./src/webmaster/user-service');
const { createAuditService } = require('./src/webmaster/audit-service');
const { createSettingsService } = require('./src/webmaster/settings-service');
const { createSecretService } = require('./src/webmaster/secret-service');
const crypto = require('crypto');
process.env.WEBMASTER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

async function runTests() {
  console.log('--- Starting Webmaster CRUD Tests ---');
  
  const actor = { id: 'test-admin', username: 'webmaster', platformAccessLevel: 'OWNER' };
  
  const auditService = createAuditService({ supabase });
  const secretService = createSecretService({ supabase, environmentKeyFor: () => 'test_key' });
  const settingsService = createSettingsService({ supabase, auditService, secretService });
  const passwordPolicy = async () => ({ minLength: 8, maxLength: 128 });
  const tenantService = createTenantService({ supabase, auditService, passwordPolicy, integrationStatus: async () => [] });
  const userService = createUserService({ supabase, auditService, passwordPolicy });

  let testTenantId;
  let testUserId;

  try {
    console.log('\n[1] Testing Tenants CRUD...');
    const tenantPayload = {
      name: `Test Tenant ${Date.now()}`,
      timezone: 'Asia/Kolkata',
      dailyReportTime: '18:00',
      initialAdmin: {
        username: `admin_${Date.now()}`,
        email: `admin_${Date.now()}@test.com`,
        password: 'Password123!'
      },
      plan: 'standard',
      limits: { users: 10, monthlyCalls: 1000 }
    };
    console.log('Creating Tenant...');
    const tenant = await tenantService.createWithAdmin(tenantPayload, actor);
    testTenantId = tenant.id;
    console.log(`✅ Tenant created: ${tenant.name} (${tenant.id})`);

    console.log('Reading Tenant...');
    const fetchedTenant = await tenantService.get(testTenantId);
    console.log(`✅ Tenant read: ${fetchedTenant.name}`);

    console.log('Updating Tenant...');
    const updatePayload = { plan: 'premium' };
    const updatedTenant = await tenantService.update(testTenantId, updatePayload, fetchedTenant.version, actor);
    console.log(`✅ Tenant updated plan to: ${updatedTenant.plan}`);

  } catch (err) {
    console.error('❌ Tenants CRUD failed:', err.message || err);
  }

  if (testTenantId) {
    try {
      console.log('\n[2] Testing Tenant Users CRUD...');
      const userPayload = {
        username: `user_${Date.now()}`,
        email: `agent_${Date.now()}@test.com`,
        password: 'Password123!',
        role: 'CLIENT_AGENT'
      };
      
      console.log('Creating Tenant User...');
      const user = await userService.createTenantUser(testTenantId, userPayload, actor);
      testUserId = user.id;
      console.log(`✅ Tenant User created: ${user.username} (${user.id})`);

      console.log('Reading Tenant Users...');
      const usersList = await userService.listTenantUsers(testTenantId);
      console.log(`✅ Tenant Users read: Found ${usersList.total} users`);

      console.log('Updating Tenant User...');
      const updatePayload = { username: `user_${Date.now()}_updated`, email: user.email, role: 'CLIENT_ADMIN' };
      const updatedUser = await userService.updateTenantUser(testTenantId, testUserId, updatePayload, user.version, actor);
      console.log(`✅ Tenant User updated username to: ${updatedUser.username}, role to: ${updatedUser.role}`);

      console.log('Archiving Tenant User...');
      const archivedUser = await userService.transitionTenantUser(testTenantId, testUserId, 'archive', updatedUser.version, actor, 'test');
      console.log(`✅ Tenant User archived. Status: ${archivedUser.status}`);

    } catch (err) {
      console.error('❌ Tenant Users CRUD failed:', err.message || err);
    }

    try {
      console.log('\n[3] Testing Tenants Archival...');
      const archivedTenant = await tenantService.transition(testTenantId, 'archive', 1, actor, 'test archive');
      console.log(`✅ Tenant archived. Status: ${archivedTenant.status}`);
    } catch(err) {
      console.error('❌ Tenant Archival failed:', err.message || err);
    }
  }

  try {
    console.log('\n[4] Testing Integrations CRUD...');
    const integrationName = 'bhashini';
    const configData = { userId: 'test_user', apiKey: 'test_key' };
    console.log('Configuring Integration...');
    await secretService.replaceSecret({ integration: integrationName, key: 'apiKey', value: 'test_key', actor });
    console.log(`✅ Integration configured`);

    console.log('Reading Integration...');
    const configuredKeys = await secretService.getMetadata(integrationName, 'apiKey');
    console.log(`✅ Integration read keys:`, configuredKeys);
  } catch (err) {
    console.error('❌ Integrations CRUD failed:', err.message || err);
  }

  try {
    console.log('\n[5] Testing Policies/Settings CRUD...');
    console.log('Fetching Platform Settings...');
    const settings = await settingsService.getGlobal();
    console.log(`✅ Platform Settings fetched`);
    
    console.log('Updating Platform Settings...');
    // We must pass a registered section to updateSection. For example: application
    const updatedSettings = await settingsService.updateSection('application', { supportEmail: 'test@vikitech.in' }, settings.version, actor);
    console.log(`✅ Platform Settings updated`);
  } catch (err) {
    console.error('❌ Policies/Settings CRUD failed:', err.message || err);
  }

  console.log('\n--- Webmaster CRUD Tests Complete ---');
}

runTests().catch(console.error);
