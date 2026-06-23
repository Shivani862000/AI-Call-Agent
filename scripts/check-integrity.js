const { initializeDatabase, dbAll, dbRun } = require('../db');

async function runIntegrityCheck() {
  await initializeDatabase();
  console.log('Database initialized. Running integrity checks...\n');
  
  let passed = 0;
  let failed = 0;

  async function check(name, testFn) {
    try {
      const errorStr = await testFn();
      if (errorStr) {
        console.error(`❌ [FAIL] ${name}`);
        console.error(`   -> ${errorStr}`);
        failed++;
      } else {
        console.log(`✅ [PASS] ${name}`);
        passed++;
      }
    } catch (e) {
      console.error(`❌ [ERROR] ${name}`);
      console.error(`   -> ${e.message}`);
      failed++;
    }
  }

  // 1. Check for duplicate customers (same phone)
  await check('No duplicate customer phone numbers', async () => {
    const duplicates = await dbAll('SELECT phone, COUNT(*) as c FROM customers GROUP BY phone HAVING c > 1');
    if (duplicates.length > 0) {
      return `Found ${duplicates.length} duplicate phones. Example: ${duplicates[0].phone}`;
    }
  });

  // 2. Check for calls without valid customer
  await check('No orphan calls (invalid customer_id)', async () => {
    const orphans = await dbAll('SELECT id FROM calls WHERE customer_id NOT IN (SELECT id FROM customers)');
    if (orphans.length > 0) {
      return `Found ${orphans.length} calls missing a valid customer. Example ID: ${orphans[0].id}`;
    }
  });

  // 3. Check for feedback without valid call
  await check('No orphan feedback (invalid call_id)', async () => {
    const orphans = await dbAll('SELECT id FROM feedback WHERE call_id IS NOT NULL AND call_id NOT IN (SELECT id FROM calls)');
    if (orphans.length > 0) {
      return `Found ${orphans.length} feedback records missing a valid call. Example ID: ${orphans[0].id}`;
    }
  });

  console.log(`\nIntegrity check complete. Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runIntegrityCheck().catch(e => {
  console.error(e);
  process.exit(1);
});
