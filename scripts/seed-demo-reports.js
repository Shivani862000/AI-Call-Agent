require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();

const dbPath = process.env.DATABASE_URL || './feedback.db';
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function isoAt(dayOffset, hour, minute) {
  const value = new Date();
  value.setDate(value.getDate() - dayOffset);
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
}

async function seed() {
  const demoPhones = [
    '+919870000101',
    '+919870000102',
    '+919870000103',
    '+919870000104',
    '+919870000105',
    '+919870000106',
    '+919870000107',
    '+919870000108'
  ];

  const existingCustomers = await all(
    `SELECT id, phone FROM customers WHERE phone IN (${demoPhones.map(() => '?').join(',')})`,
    demoPhones
  );

  const existingIds = existingCustomers.map((row) => row.id);

  if (existingIds.length) {
    await run(`DELETE FROM feedback WHERE customer_id IN (${existingIds.map(() => '?').join(',')})`, existingIds);
    await run(`DELETE FROM calls WHERE customer_id IN (${existingIds.map(() => '?').join(',')})`, existingIds);
    await run(`DELETE FROM customers WHERE id IN (${existingIds.map(() => '?').join(',')})`, existingIds);
  }

  const customers = [
    ['Demo Asha Kapoor', demoPhones[0], '09:30', 'called', 'premium', 'high', 88, 'hi', 'full body checkup'],
    ['Demo Rohan Mehta', demoPhones[1], '10:15', 'completed', 'standard', 'normal', 72, 'en', 'thyroid panel'],
    ['Demo Neha Arora', demoPhones[2], '11:00', 'pending', 'standard', 'normal', 64, 'hi', 'vitamin profile'],
    ['Demo Kabir Jain', demoPhones[3], '11:45', 'failed', 'high_value', 'high', 82, 'en', 'diabetes screening'],
    ['Demo Meera Sethi', demoPhones[4], '12:30', 'called', 'premium', 'high', 90, 'hi', 'home collection'],
    ['Demo Arjun Khanna', demoPhones[5], '13:15', 'completed', 'standard', 'normal', 69, 'en', 'xray follow-up'],
    ['Demo Sana Verma', demoPhones[6], '15:00', 'callback', 'standard', 'normal', 75, 'hi', 'cbc test'],
    ['Demo Ishan Batra', demoPhones[7], '16:20', 'completed', 'premium', 'low', 58, 'en', 'lipid profile']
  ];

  const customerIds = [];
  for (const customer of customers) {
    const result = await run(
      `INSERT INTO customers (
        name, phone, preferred_slot, status, created_at, customer_value, urgency_level,
        priority_score, ai_score, preferred_language, service_interest, campaign_name,
        revenue_stage, revenue_estimate, last_called_at, last_contact_outcome, do_not_call, next_retry_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer[0],
        customer[1],
        customer[2],
        'completed',
        isoAt(20, 10, 0),
        customer[4],
        customer[5],
        customer[6],
        customer[6],
        customer[7],
        customer[8],
        'Spring Health Check',
        customer[6] > 80 ? 'qualified' : 'follow_up',
        customer[6] * 120,
        isoAt(1, 16, 0),
        customer[3],
        1,
        null
      ]
    );
    customerIds.push(result.lastID);
  }

  const callRows = [
    [0, 9, 20, 'completed', 'completed', 5, 'positive', 'Amazing home collection experience and very polite staff.', 92],
    [0, 13, 10, 'completed', 'completed', 4, 'positive', 'Reports were quick and the nurse was very helpful.', 84],
    [1, 10, 30, 'completed', 'completed', 4, 'positive', 'Smooth process, just wanted slightly earlier follow-up.', 76],
    [1, 17, 25, 'busy', 'pending', null, null, null, 0],
    [2, 11, 40, 'initiated', 'pending', null, null, null, 0],
    [2, 18, 15, 'no_answer', 'pending', null, null, null, 0],
    [3, 12, 5, 'failed', 'blocked', null, 'negative', 'Patient upset about repeated rescheduling and pricing confusion.', 34],
    [3, 6, 50, 'completed', 'completed', 2, 'negative', 'Collection arrived late and support felt rushed.', 28],
    [4, 8, 55, 'completed', 'completed', 5, 'positive', 'Very happy with phlebotomist professionalism and clean packaging.', 96],
    [4, 14, 0, 'callback', 'completed', 3, 'neutral', 'Asked for callback after discussing family package pricing.', 67],
    [5, 9, 45, 'completed', 'completed', 4, 'positive', 'Good update call and clear explanation of next steps.', 70],
    [5, 15, 20, 'completed', 'blocked', null, 'neutral', 'Analysis pending but patient sounded okay on call.', 45],
    [6, 16, 40, 'callback', 'completed', 3, 'neutral', 'Requested evening callback for discussing annual plan.', 60],
    [6, 7, 10, 'completed', 'completed', 4, 'positive', 'Friendly reminder call and useful offer explanation.', 73],
    [7, 11, 15, 'completed', 'completed', 5, 'positive', 'Loved the premium service and fast digital report sharing.', 88],
    [7, 19, 5, 'no_answer', 'pending', null, null, null, 0],
    [0, 5, 30, 'completed', 'completed', 5, 'positive', 'Excellent pickup timing and zero waiting.', 91],
    [1, 4, 10, 'completed', 'completed', 4, 'positive', 'Nice follow-up and clear billing explanation.', 74],
    [4, 3, 45, 'busy', 'pending', null, null, null, 0],
    [3, 2, 20, 'failed', 'blocked', 1, 'negative', 'Very poor experience with delay and confusion.', 20]
  ];

  for (let index = 0; index < callRows.length; index += 1) {
    const [customerIndex, dayOffset, hour, outcome, analysisStatus, rating, sentimentLabel, reviewText, hotLeadScore] = callRows[index];
    const customerId = customerIds[customerIndex];
    const calledAt = isoAt(dayOffset, hour, (index * 7) % 60);
    const result = await run(
      `INSERT INTO calls (
        customer_id, called_at, outcome, twilio_sid, transcript_text, consent_detected, language,
        extracted_rating, extracted_review_text, recording_status, transcript_status, transcript_source,
        analysis_status, analysis_summary, report_excerpt, outcome_detail, fallback_triggered,
        sentiment_label, sentiment_score, hot_lead_score, next_action_at, follow_up_task,
        recording_download_status, crm_sync_status, whatsapp_summary_sent, revenue_attribution_status,
        call_script_version, competitor_mentions_json, objections_json, interest_detected,
        callback_requested, human_escalation_requested, supervisor_alert_level, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        calledAt,
        outcome,
        `demo-call-${Date.now()}-${index}`,
        reviewText ? `Agent: Thank you for your time.\nCustomer: ${reviewText}` : null,
        outcome === 'completed' ? 1 : 0,
        'hi',
        rating,
        reviewText,
        outcome === 'completed' ? 'completed' : 'pending',
        outcome === 'completed' ? 'completed' : 'pending',
        outcome === 'completed' ? 'live' : null,
        analysisStatus,
        reviewText ? `Patient mentioned: ${reviewText}` : null,
        reviewText ? reviewText.slice(0, 120) : null,
        outcome,
        outcome === 'failed' ? 1 : 0,
        sentimentLabel,
        sentimentLabel === 'positive' ? 0.82 : sentimentLabel === 'negative' ? -0.76 : 0.08,
        hotLeadScore,
        hotLeadScore > 70 ? isoAt(0, 18, 30) : null,
        hotLeadScore > 70 ? 'Call back with premium wellness plan offer' : null,
        outcome === 'completed' ? 'completed' : 'pending',
        outcome === 'completed' ? 'synced' : 'pending',
        outcome === 'completed' ? 1 : 0,
        outcome === 'completed' ? 'attributed' : 'pending',
        index % 2 === 0 ? 'hindi-feedback-v1' : 'upsell-experiment-v2',
        JSON.stringify(index % 5 === 0 ? ['Nearby Diagnostics'] : []),
        JSON.stringify(index % 4 === 0 ? ['pricing concern'] : index % 6 === 0 ? ['timing issue'] : []),
        hotLeadScore >= 80 ? 1 : 0,
        outcome === 'callback' ? 1 : 0,
        outcome === 'failed' ? 1 : 0,
        outcome === 'failed' ? 'high' : 'normal',
        1
      ]
    );

    if (rating && reviewText) {
      const category = rating >= 4 ? 'good' : rating === 3 ? 'average' : 'bad';
      await run(
        `INSERT INTO feedback (customer_id, call_id, review_text, category, stars, submitted_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [customerId, result.lastID, reviewText, category, rating, calledAt, 'ai_call']
      );
    }
  }

  console.log(`Seeded ${customerIds.length} demo customers, ${callRows.length} demo calls, and matching feedback entries.`);
}

seed()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
