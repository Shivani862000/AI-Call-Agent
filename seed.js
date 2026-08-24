require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const Tenant = require('./src/models/Tenant');
const User = require('./src/models/User');
const Customer = require('./src/models/Customer');
const { SEED_WEBMASTER } = require('./src/seed-data');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI, { family: 4 });

  const passwordHash = await bcrypt.hash('password123', 10);
  const activeLifecycle = {
    status: 'active',
    archived_at: null,
    archived_by: null,
    archive_reason: null
  };

  // 1. Create Webmaster (Global Admin)
  await User.findOneAndUpdate(
    { username: SEED_WEBMASTER.username },
    { $set: { ...SEED_WEBMASTER, password_hash: passwordHash, ...activeLifecycle } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // 2. Create Support Team User
  await User.findOneAndUpdate(
    { username: 'support@vikitech.in' },
    { $set: { username: 'support@vikitech.in', email: 'support@vikitech.in', password_hash: passwordHash, role: 'SUPPORT_TEAM', ...activeLifecycle } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // 3. Create Tenant 1 (Apollo Hospital)
  const apollo = await Tenant.findOneAndUpdate(
    { name: 'Apollo Hospital' },
    { $set: { name: 'Apollo Hospital', ...activeLifecycle } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await User.findOneAndUpdate(
    { username: 'admin@apollo.in' },
    { $set: { username: 'admin@apollo.in', email: 'admin@apollo.in', password_hash: passwordHash, role: 'CLIENT_ADMIN', tenantId: apollo._id, ...activeLifecycle } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await User.findOneAndUpdate(
    { username: 'agent@apollo.in' },
    { $set: { username: 'agent@apollo.in', email: 'agent@apollo.in', password_hash: passwordHash, role: 'CLIENT_AGENT', tenantId: apollo._id, ...activeLifecycle } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Add a test customer for Apollo
  await Customer.findOneAndUpdate(
    { tenantId: apollo._id, phone: '+919876543210' },
    { $set: { tenantId: apollo._id, name: 'Rahul Sharma', phone: '+919876543210', call_type: 'REVIEW_CALL', status: 'pending', is_manual: 1, archived_at: null, archived_by: null, archive_reason: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // 4. Create Tenant 2 (Max Hospital)
  const max = await Tenant.findOneAndUpdate(
    { name: 'Max Hospital' },
    { $set: { name: 'Max Hospital', ...activeLifecycle } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await User.findOneAndUpdate(
    { username: 'admin@max.in' },
    { $set: { username: 'admin@max.in', email: 'admin@max.in', password_hash: passwordHash, role: 'CLIENT_ADMIN', tenantId: max._id, ...activeLifecycle } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log('Seed completed successfully!');
  console.log('Seed identities were upserted without removing retained records.');
  process.exit(0);
}

seed().catch(console.error);
