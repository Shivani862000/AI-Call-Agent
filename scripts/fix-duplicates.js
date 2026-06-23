const { initializeDatabase, dbAll, dbRun } = require('../db');

async function fixDuplicates() {
  await initializeDatabase();
  const duplicates = await dbAll('SELECT phone, COUNT(*) as c FROM customers GROUP BY phone HAVING c > 1');
  
  for (const dup of duplicates) {
    const customers = await dbAll('SELECT id FROM customers WHERE phone = ? ORDER BY id DESC', [dup.phone]);
    // keep the first one (most recent)
    const keepId = customers[0].id;
    const deleteIds = customers.slice(1).map(c => c.id);
    
    console.log(`Fixing duplicate phone ${dup.phone}. Keeping ID ${keepId}, deleting ${deleteIds.join(', ')}`);
    
    for (const id of deleteIds) {
      // Re-link calls
      await dbRun('UPDATE calls SET customer_id = ? WHERE customer_id = ?', [keepId, id]);
      // Re-link feedback
      await dbRun('UPDATE feedback SET customer_id = ? WHERE customer_id = ?', [keepId, id]);
      // Delete old customer
      await dbRun('DELETE FROM customers WHERE id = ?', [id]);
    }
  }
  console.log('Duplicates resolved.');
  process.exit(0);
}

fixDuplicates().catch(console.error);
