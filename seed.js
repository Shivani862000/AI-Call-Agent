require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const Tenant = require('./src/models/Tenant');
const User = require('./src/models/User');
const Customer = require('./src/models/Customer');
const { SEED_WEBMASTER } = require('./src/seed-data');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI, { family: 4 });
  
  // Clear existing users and tenants for a clean slate
  await User.deleteMany({});
  await Tenant.deleteMany({});
  await Customer.deleteMany({});

  const passwordHash = await bcrypt.hash('password123', 10);

  // 1. Create Webmaster (Global Admin)
  const webmaster = await User.create({
    ...SEED_WEBMASTER,
    password_hash: passwordHash,
    isActive: true
  });

  // 2. Create Support Team User
  const supportUser = await User.create({
    username: 'support@vikitech.in',
    email: 'support@vikitech.in',
    password_hash: passwordHash,
    role: 'SUPPORT_TEAM',
    isActive: true
  });

  // 3. Create Tenant 1 (Apollo Hospital)
  const apollo = await Tenant.create({
    name: 'Apollo Hospital',
    slug: 'apollo',
    ownerEmail: 'admin@apollo.in',
    dbConnectionString: process.env.MONGODB_URI
  });

  const apolloAdmin = await User.create({
    username: 'admin@apollo.in',
    email: 'admin@apollo.in',
    password_hash: passwordHash,
    role: 'CLIENT_ADMIN',
    tenantId: apollo._id,
    isActive: true
  });

  const apolloAgent = await User.create({
    username: 'agent@apollo.in',
    email: 'agent@apollo.in',
    password_hash: passwordHash,
    role: 'CLIENT_AGENT',
    tenantId: apollo._id,
    isActive: true
  });

  // Add a test customer for Apollo
  await Customer.create({
    tenantId: apollo._id,
    name: 'Rahul Sharma',
    phone: '+919876543210',
    call_type: 'REVIEW_CALL',
    status: 'pending',
    is_manual: 1
  });

  // 4. Create Tenant 2 (Max Hospital)
  const max = await Tenant.create({
    name: 'Max Hospital',
    slug: 'max',
    ownerEmail: 'admin@max.in',
    dbConnectionString: process.env.MONGODB_URI
  });

  const maxAdmin = await User.create({
    username: 'admin@max.in',
    email: 'admin@max.in',
    password_hash: passwordHash,
    role: 'CLIENT_ADMIN',
    tenantId: max._id,
    isActive: true
  });

  console.log('Seed completed successfully!');
  console.log('--- CREDENTIALS (All passwords are "password123") ---');
  console.log('1. Webmaster: webmaster@vikitech.in');
  console.log('2. Support Team: support@vikitech.in');
  console.log('3. Apollo Admin: admin@apollo.in');
  console.log('4. Apollo Agent: agent@apollo.in');
  console.log('5. Max Admin: admin@max.in');
  
  process.exit(0);
}

seed().catch(console.error);
