'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Tenant = require('../src/models/Tenant');
const Customer = require('../src/models/Customer');
const { dispatchScheduledCalls } = require('../src/scheduler');

test('scheduled-call tick selects customers only from the active tenant set fetched once', async () => {
  // Mutation caught: selecting due customers without checking tenant lifecycle still calls archived tenants.
  const originalTenantFind = Tenant.find;
  const originalCustomerFind = Customer.find;
  let tenantQueries = 0;
  let customerFilter;

  Tenant.find = (filter) => {
    tenantQueries += 1;
    assert.deepEqual(filter, { status: 'active' });
    return {
      select() { return this; },
      async lean() { return [{ _id: 'tenant-a' }, { _id: 'tenant-c' }]; }
    };
  };
  Customer.find = async (filter) => {
    customerFilter = filter;
    return [];
  };

  try {
    await dispatchScheduledCalls();
  } finally {
    Tenant.find = originalTenantFind;
    Customer.find = originalCustomerFind;
  }

  assert.equal(tenantQueries, 1);
  assert.deepEqual(customerFilter.$and[1].tenantId, { $in: ['tenant-a', 'tenant-c'] });
});
