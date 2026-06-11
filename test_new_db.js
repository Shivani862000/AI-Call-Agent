const { dbAll, initializeDatabase } = require('./db');

async function test() {
  await initializeDatabase();
  
  try {
    const feedback = await dbAll(`
      SELECT f.*, c.name as customer_name, c.phone as customer_phone
      FROM feedback f
      LEFT JOIN customers c ON f.customer_id = c.id
    `);
    const recentCalls = await dbAll(`
      SELECT calls.*, c.name as customer_name, c.phone as customer_phone
      FROM calls
      LEFT JOIN customers c ON calls.customer_id = c.id
      ORDER BY calls.created_at DESC LIMIT 500
    `);
  
    console.log("feedback query successful, length:", feedback.length);
    console.log("calls query successful, length:", recentCalls.length);

    const pendingAnalysis = recentCalls.filter((call) => String(call.analysis_status || '').toLowerCase() !== 'completed');
    console.log("pending length:", pendingAnalysis.length);
  } catch(e) {
    console.log("ERROR RUNNING NEW CODE:", e.message);
  }
}

test();
