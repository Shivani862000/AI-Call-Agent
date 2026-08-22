require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('./src/models/Tenant');

mongoose.connect(process.env.MONGODB_URI, { family: 4 })
  .then(() => Tenant.find())
  .then(tenants => {
    console.log('Tenants:', tenants);
    if (tenants.length === 0) {
      console.log('No tenants found. Creating a default tenant...');
      return Tenant.create({
        name: 'Default Tenant (Vikitech)',
        slug: 'default-vikitech',
        dbConnectionString: process.env.MONGODB_URI,
        ownerEmail: 'admin@vikitechsolutions.in'
      }).then(t => console.log('Created:', t));
    }
  })
  .then(() => process.exit(0))
  .catch(console.error);
