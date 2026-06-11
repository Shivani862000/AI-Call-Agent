const { dbAll, initializeDatabase } = require('./db');

async function test() {
  await initializeDatabase();
  
  // Test Old Logic
  const feedback = await dbAll('SELECT * FROM feedback');
  const recentCalls = await dbAll('SELECT * FROM calls ORDER BY created_at DESC LIMIT 500');

  const fbPositive = feedback.filter((item) => Number(item.stars || 0) >= 4);
  const callsPositive = recentCalls.filter((c) => Number(c.extracted_rating || 0) >= 4 && !feedback.find(f => (f.call_id || f.id) === c.id));
  const positiveFeedback = [...fbPositive, ...callsPositive];

  const pendingAnalysis = recentCalls.filter((call) => String(call.analysis_status || '').toLowerCase() !== 'completed');

  console.log("positive length:", positiveFeedback.length);
  console.log("pending length:", pendingAnalysis.length);

  // Test API
  const http = require('http');
  http.get('http://localhost:3000/api/feedback/analytics', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        console.log("API positive:", json.metrics?.positive);
        console.log("API pending:", json.metrics?.pendingAnalysis);
      } catch (e) {
        console.log("API Error:", data.substring(0, 100));
      }
    });
  }).on('error', e => console.log("HTTP Error:", e.message));
}

test();
