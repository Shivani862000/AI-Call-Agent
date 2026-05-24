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

function dateOnlyAt(dayOffset) {
  const value = new Date();
  value.setDate(value.getDate() - dayOffset);
  value.setHours(0, 0, 0, 0);
  return value.toISOString().slice(0, 10);
}

function birthDateYearsAgo(years, extraDays = 0) {
  const value = new Date();
  value.setFullYear(value.getFullYear() - years);
  value.setDate(value.getDate() - extraDays);
  value.setHours(0, 0, 0, 0);
  return value.toISOString().slice(0, 10);
}

async function cleanupExistingSeedData(demoPhones, campaignNames) {
  const existingCustomers = await all(
    `SELECT id, phone FROM customers WHERE phone IN (${demoPhones.map(() => '?').join(',')})`,
    demoPhones
  );

  const existingIds = existingCustomers.map((row) => row.id);

  if (existingIds.length) {
    await run(`DELETE FROM feedback WHERE customer_id IN (${existingIds.map(() => '?').join(',')})`, existingIds);
    await run(`DELETE FROM calls WHERE customer_id IN (${existingIds.map(() => '?').join(',')})`, existingIds);
    await run(`DELETE FROM clients WHERE linked_customer_id IN (${existingIds.map(() => '?').join(',')})`, existingIds);
    await run(`DELETE FROM customers WHERE id IN (${existingIds.map(() => '?').join(',')})`, existingIds);
  }

  await run(
    `DELETE FROM campaign_configs WHERE name IN (${campaignNames.map(() => '?').join(',')})`,
    campaignNames
  );
}

async function seedCampaigns(campaigns) {
  for (const campaign of campaigns) {
    await run(
      `INSERT INTO campaign_configs (name, service_name, monthly_spend_inr, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [campaign.name, campaign.service_name, campaign.monthly_spend_inr, campaign.status, isoAt(28, 9, 0)]
    );
  }
}

async function seed() {
  const patients = [
    {
      name: 'Pooja Sharma',
      phone: '+919870000101',
      preferred_slot: '09:15',
      status: 'completed',
      customer_value: 'vip',
      urgency_level: 'high',
      priority_score: 92,
      preferred_language: 'hi',
      service_interest: 'full body checkup',
      campaign_name: 'Executive Preventive Panel',
      revenue_stage: 'qualified',
      revenue_estimate: 8500,
      pending_follow_ups: 'Share annual preventive package and family add-on offer.',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(7),
      treatment_type: 'Executive health package',
      notes: 'Prefers morning home collection. Husband may also convert on family package.'
    },
    {
      name: 'Rajeev Malhotra',
      phone: '+919870000102',
      preferred_slot: '10:00',
      status: 'completed',
      customer_value: 'high',
      urgency_level: 'normal',
      priority_score: 78,
      preferred_language: 'en',
      service_interest: 'thyroid panel',
      campaign_name: 'Thyroid Recall Program',
      revenue_stage: 'follow_up',
      revenue_estimate: 3200,
      pending_follow_ups: 'Confirm if home collection required for spouse next week.',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(14),
      treatment_type: 'Thyroid profile',
      notes: 'Open to package upgrade if morning slot available.'
    },
    {
      name: 'Nidhi Bansal',
      phone: '+919870000103',
      preferred_slot: '11:20',
      status: 'pending',
      customer_value: 'standard',
      urgency_level: 'normal',
      priority_score: 66,
      preferred_language: 'hi',
      service_interest: 'vitamin profile',
      campaign_name: 'Nutrition Recheck Drive',
      revenue_stage: 'unassigned',
      revenue_estimate: 1800,
      pending_follow_ups: 'Retry after lunch. Patient asked to call after report review.',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(5),
      treatment_type: 'Vitamin D and B12 profile',
      notes: 'Frequently busy in the first half. Better connect post 3 PM.'
    },
    {
      name: 'Kabir Jain',
      phone: '+919870000104',
      preferred_slot: '12:10',
      status: 'failed',
      customer_value: 'high',
      urgency_level: 'high',
      priority_score: 84,
      preferred_language: 'en',
      service_interest: 'diabetes screening',
      campaign_name: 'HbA1c Recall Campaign',
      revenue_stage: 'follow_up',
      revenue_estimate: 4200,
      pending_follow_ups: 'Escalate service recovery and waive convenience fee on next booking.',
      outstanding_issues: 'Previous collection reached late by 35 minutes.',
      last_visit_date: dateOnlyAt(3),
      treatment_type: 'Diabetes screening',
      notes: 'Negative sentiment due to late collection and pricing confusion.'
    },
    {
      name: 'Meera Sethi',
      phone: '+919870000105',
      preferred_slot: '08:45',
      status: 'called',
      customer_value: 'vip',
      urgency_level: 'high',
      priority_score: 95,
      preferred_language: 'hi',
      service_interest: 'home collection',
      campaign_name: 'Premium Home Collection',
      revenue_stage: 'qualified',
      revenue_estimate: 9600,
      pending_follow_ups: 'Send premium wellness brochure and lock Sunday family visit.',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(2),
      treatment_type: 'Senior citizen home collection',
      notes: 'Very positive experience. Interested in preventive package for parents.'
    },
    {
      name: 'Arjun Khanna',
      phone: '+919870000106',
      preferred_slot: '14:00',
      status: 'completed',
      customer_value: 'standard',
      urgency_level: 'normal',
      priority_score: 71,
      preferred_language: 'en',
      service_interest: 'xray follow-up',
      campaign_name: 'Diagnostics Follow-up',
      revenue_stage: 'follow_up',
      revenue_estimate: 2400,
      pending_follow_ups: '',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(9),
      treatment_type: 'Chest X-ray follow-up',
      notes: 'Satisfied, but asked for faster turnaround on report PDF sharing.'
    },
    {
      name: 'Sana Verma',
      phone: '+919870000107',
      preferred_slot: '16:15',
      status: 'callback',
      customer_value: 'standard',
      urgency_level: 'normal',
      priority_score: 74,
      preferred_language: 'hi',
      service_interest: 'cbc test',
      campaign_name: 'Women Wellness Recall',
      revenue_stage: 'follow_up',
      revenue_estimate: 2700,
      pending_follow_ups: 'Call in evening with package pricing and couple discount.',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(12),
      treatment_type: 'CBC with iron profile',
      notes: 'Interested but wants to confirm with husband before booking.'
    },
    {
      name: 'Ishan Batra',
      phone: '+919870000108',
      preferred_slot: '17:10',
      status: 'completed',
      customer_value: 'high',
      urgency_level: 'low',
      priority_score: 62,
      preferred_language: 'en',
      service_interest: 'lipid profile',
      campaign_name: 'Cardiac Risk Recall',
      revenue_stage: 'qualified',
      revenue_estimate: 5100,
      pending_follow_ups: '',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(10),
      treatment_type: 'Lipid profile',
      notes: 'Happy with digital reports and app reminders.'
    },
    {
      name: 'Sunita Arora',
      phone: '+919870000109',
      preferred_slot: '09:50',
      status: 'pending',
      customer_value: 'high',
      urgency_level: 'high',
      priority_score: 87,
      preferred_language: 'hi',
      service_interest: 'senior citizen panel',
      campaign_name: 'Premium Home Collection',
      revenue_stage: 'qualified',
      revenue_estimate: 6800,
      pending_follow_ups: 'Reconnect with son for address confirmation.',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(1),
      treatment_type: 'Senior citizen panel',
      notes: 'Patient herself is positive but final booking depends on son.'
    },
    {
      name: 'Mohit Suri',
      phone: '+919870000110',
      preferred_slot: '13:35',
      status: 'completed',
      customer_value: 'standard',
      urgency_level: 'normal',
      priority_score: 68,
      preferred_language: 'mixed',
      service_interest: 'liver function test',
      campaign_name: 'Executive Preventive Panel',
      revenue_stage: 'follow_up',
      revenue_estimate: 2900,
      pending_follow_ups: '',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(8),
      treatment_type: 'LFT follow-up',
      notes: 'Wanted clearer explanation on fasting rules.'
    },
    {
      name: 'Aarti Gupta',
      phone: '+919870000111',
      preferred_slot: '15:40',
      status: 'completed',
      customer_value: 'high',
      urgency_level: 'normal',
      priority_score: 81,
      preferred_language: 'hi',
      service_interest: 'cbc and ferritin',
      campaign_name: 'Women Wellness Recall',
      revenue_stage: 'qualified',
      revenue_estimate: 5600,
      pending_follow_ups: 'Offer annual women wellness bundle.',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(4),
      treatment_type: 'CBC and ferritin profile',
      notes: 'Likely to book additional vitamin panel next cycle.'
    },
    {
      name: 'Varun Chawla',
      phone: '+919870000112',
      preferred_slot: '18:00',
      status: 'scheduled',
      customer_value: 'vip',
      urgency_level: 'high',
      priority_score: 90,
      preferred_language: 'en',
      service_interest: 'corporate wellness package',
      campaign_name: 'Corporate Wellness Leads',
      revenue_stage: 'qualified',
      revenue_estimate: 15000,
      pending_follow_ups: 'Share proposal for 6-member executive package.',
      outstanding_issues: '',
      last_visit_date: dateOnlyAt(6),
      treatment_type: 'Corporate wellness consultation',
      notes: 'High commercial potential if converted this week.'
    }
  ];

  const campaigns = [
    { name: 'Executive Preventive Panel', service_name: 'Executive full body checkup', monthly_spend_inr: 28000, status: 'active' },
    { name: 'Premium Home Collection', service_name: 'Home collection upsell', monthly_spend_inr: 22000, status: 'active' },
    { name: 'HbA1c Recall Campaign', service_name: 'Diabetes follow-up recall', monthly_spend_inr: 18000, status: 'active' },
    { name: 'Women Wellness Recall', service_name: 'Women wellness package', monthly_spend_inr: 16000, status: 'active' },
    { name: 'Corporate Wellness Leads', service_name: 'Corporate package outreach', monthly_spend_inr: 32000, status: 'active' }
  ];

  await cleanupExistingSeedData(patients.map((item) => item.phone), campaigns.map((item) => item.name));
  await seedCampaigns(campaigns);

  const customerIds = [];

  for (const patient of patients) {
    const createdAt = isoAt(26, 10, 0);
    const lastCalledAt = isoAt(1, 16, 20);
    const nextRetryAt = ['pending', 'scheduled', 'callback'].includes(patient.status)
      ? isoAt(0, Number(patient.preferred_slot.slice(0, 2)), Number(patient.preferred_slot.slice(3, 5)))
      : null;

    const result = await run(
      `INSERT INTO customers (
        name, phone, preferred_slot, status, created_at, customer_value, urgency_level,
        priority_score, ai_score, preferred_language, service_interest, campaign_name,
        revenue_stage, revenue_estimate, last_called_at, last_contact_outcome, do_not_call, next_retry_at,
        consent_status, preferred_dialect, best_call_slot, pickup_rate_score, outstanding_issues,
        pending_follow_ups, last_sentiment_score, last_sentiment_label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patient.name,
        patient.phone,
        patient.preferred_slot,
        patient.status,
        createdAt,
        patient.customer_value,
        patient.urgency_level,
        patient.priority_score,
        patient.priority_score,
        patient.preferred_language,
        patient.service_interest,
        patient.campaign_name,
        patient.revenue_stage,
        patient.revenue_estimate,
        lastCalledAt,
        patient.status,
        1,
        nextRetryAt,
        'granted',
        patient.preferred_language === 'hi' ? 'north-india-hindi' : null,
        patient.preferred_slot,
        Math.min(95, Math.max(45, patient.priority_score - 6)),
        patient.outstanding_issues || null,
        patient.pending_follow_ups || null,
        patient.status === 'failed' ? -0.72 : patient.status === 'callback' ? 0.16 : 0.78,
        patient.status === 'failed' ? 'negative' : patient.status === 'callback' ? 'neutral' : 'positive'
      ]
    );

    customerIds.push(result.lastID);

    await run(
      `INSERT INTO clients (
        name, phone, date_of_birth, last_visit_date, treatment_type, annual_reminder_enabled,
        annual_reminder_slot, next_annual_reminder_date, notes, linked_customer_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patient.name,
        patient.phone,
        birthDateYearsAgo(28 + (customerIds.length % 24), customerIds.length * 11),
        patient.last_visit_date,
        patient.treatment_type,
        1,
        patient.preferred_slot,
        dateOnlyAt(-330),
        patient.notes,
        result.lastID,
        'active',
        createdAt,
        new Date().toISOString()
      ]
    );
  }

  const calls = [
    {
      customerIndex: 0, dayOffset: 0, hour: 10, minute: 18, outcome: 'completed', analysis_status: 'completed',
      rating: 5, sentiment_label: 'positive', hot_lead_score: 94,
      review: 'Home collection executive was on time, reports came before evening, and I would like details for the annual family preventive package.',
      summary: 'Strong NPS-type response. Patient appreciated punctual home collection and asked for annual family preventive package details.',
      excerpt: 'High-value patient satisfied with service and open to premium family upsell.',
      task: 'Send annual family package brochure and callback tomorrow before 11 AM.',
      objections: [], competitors: [], script: 'premium-homecare-v3', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 1, dayOffset: 0, hour: 12, minute: 8, outcome: 'completed', analysis_status: 'completed',
      rating: 4, sentiment_label: 'positive', hot_lead_score: 72,
      review: 'Overall process was smooth. I may book a thyroid test for my wife as well if a morning slot is available.',
      summary: 'Positive service response with a secondary household lead if morning slot availability is confirmed.',
      excerpt: 'Satisfied patient with possible spouse conversion opportunity.',
      task: 'Share next available morning slots for spouse booking.',
      objections: ['slot availability'], competitors: [], script: 'thyroid-followup-v2', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 2, dayOffset: 0, hour: 15, minute: 12, outcome: 'no_answer', analysis_status: 'pending',
      rating: null, sentiment_label: null, hot_lead_score: 0,
      review: null,
      summary: null,
      excerpt: null,
      task: 'Retry after 5 PM when patient is usually available.',
      objections: [], competitors: [], script: 'nutrition-recall-v1', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 3, dayOffset: 0, hour: 16, minute: 42, outcome: 'failed', analysis_status: 'completed',
      rating: 2, sentiment_label: 'negative', hot_lead_score: 26,
      review: 'Collection was late and no one clearly explained the changed price. I am not confident about booking again right now.',
      summary: 'Patient flagged delayed pickup and price confusion. This is a service recovery case, not a sales call.',
      excerpt: 'Negative feedback tied to delay and pricing mismatch. Manager callback advised.',
      task: 'Escalate to customer care lead and offer apology plus fee waiver.',
      objections: ['pricing concern', 'timing issue'], competitors: ['Dr Lal PathLabs'], script: 'recovery-script-v1', callback: 0, escalation: 1, liveRedFlag: 1, supervisorLevel: 'high'
    },
    {
      customerIndex: 4, dayOffset: 0, hour: 9, minute: 2, outcome: 'completed', analysis_status: 'completed',
      rating: 5, sentiment_label: 'positive', hot_lead_score: 97,
      review: 'Very professional phlebotomist, clean packaging, and quick report delivery. Please send the premium senior citizen plan details.',
      summary: 'Very high-value positive patient. Strong conversion signal for premium senior citizen plan and family home collection.',
      excerpt: 'Excellent patient experience with immediate upsell interest.',
      task: 'Sales callback with senior citizen plan and weekend family visit slot.',
      objections: [], competitors: [], script: 'premium-homecare-v3', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 5, dayOffset: 1, hour: 14, minute: 18, outcome: 'completed', analysis_status: 'completed',
      rating: 4, sentiment_label: 'positive', hot_lead_score: 68,
      review: 'Call was helpful and the team explained the next steps clearly. Report sharing could be a little faster.',
      summary: 'Overall positive case with a mild process note around report turnaround speed.',
      excerpt: 'Satisfied patient; small opportunity to improve speed of report delivery.',
      task: 'Review report dispatch SLA with operations.',
      objections: ['report turnaround'], competitors: [], script: 'diagnostic-followup-v2', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 6, dayOffset: 1, hour: 18, minute: 5, outcome: 'callback', analysis_status: 'completed',
      rating: 3, sentiment_label: 'neutral', hot_lead_score: 61,
      review: 'The offer sounds useful but I need an evening callback after discussing it with my husband.',
      summary: 'Patient is not lost; callback requested after family discussion. Keep in active follow-up queue.',
      excerpt: 'Callback requested for pricing discussion.',
      task: 'Call tomorrow after 7 PM with final package pricing.',
      objections: ['price confirmation'], competitors: [], script: 'women-wellness-v2', callback: 1, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 7, dayOffset: 1, hour: 11, minute: 36, outcome: 'completed', analysis_status: 'completed',
      rating: 5, sentiment_label: 'positive', hot_lead_score: 86,
      review: 'Premium service was excellent and the digital report link was very easy to use.',
      summary: 'Premium experience delivered as promised. Strong retention probability and referral potential.',
      excerpt: 'Positive premium-service review with retention upside.',
      task: 'Send referral coupon and lipid retest reminder in 90 days.',
      objections: [], competitors: [], script: 'premium-followup-v2', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 8, dayOffset: 1, hour: 10, minute: 55, outcome: 'callback', analysis_status: 'completed',
      rating: 4, sentiment_label: 'positive', hot_lead_score: 82,
      review: 'Please speak to my son for address confirmation. I am happy to proceed if home collection timing is fixed.',
      summary: 'Elderly patient positive toward booking. Decision bottleneck is caretaker coordination, not service quality.',
      excerpt: 'Good booking intent pending family coordination.',
      task: 'Callback son for address confirmation and collection window.',
      objections: ['caregiver coordination'], competitors: [], script: 'senior-care-v1', callback: 1, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 9, dayOffset: 2, hour: 13, minute: 48, outcome: 'completed', analysis_status: 'completed',
      rating: 4, sentiment_label: 'positive', hot_lead_score: 70,
      review: 'The team was polite and informative. I only needed a clearer note on fasting before the test.',
      summary: 'Patient satisfied overall. Small educational gap around fasting instructions.',
      excerpt: 'Positive experience with a minor pre-test instruction gap.',
      task: 'Update pre-call FAQ prompt for fasting instructions.',
      objections: ['test preparation clarity'], competitors: [], script: 'preventive-upsell-v2', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 10, dayOffset: 2, hour: 16, minute: 25, outcome: 'completed', analysis_status: 'completed',
      rating: 5, sentiment_label: 'positive', hot_lead_score: 88,
      review: 'Good reminder call and I am interested in the annual women wellness bundle if the price is shared on WhatsApp.',
      summary: 'Patient gave strong buying signal for annual women wellness bundle and asked for price follow-up on WhatsApp.',
      excerpt: 'Likely upsell if pricing is sent promptly.',
      task: 'Share women wellness bundle pricing on WhatsApp today.',
      objections: ['needs package pricing'], competitors: [], script: 'women-wellness-v2', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 11, dayOffset: 2, hour: 18, minute: 22, outcome: 'interested', analysis_status: 'completed',
      rating: null, sentiment_label: 'positive', hot_lead_score: 98,
      review: null,
      summary: 'Corporate wellness lead is sales-ready. Prospect asked for structured proposal covering six executives.',
      excerpt: 'Highest commercial lead in current queue. Proposal follow-up required within 24 hours.',
      task: 'Share proposal deck and schedule decision-maker callback tomorrow.',
      objections: ['requires proposal'], competitors: ['Healthians'], script: 'corporate-lead-v1', callback: 1, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 0, dayOffset: 3, hour: 9, minute: 28, outcome: 'completed', analysis_status: 'completed',
      rating: 5, sentiment_label: 'positive', hot_lead_score: 90,
      review: 'Pickup was exactly on time and the call follow-up felt very premium.',
      summary: 'Repeat signal that premium-service positioning is landing well with high-value patients.',
      excerpt: 'Premium journey validated by repeat positive feedback.',
      task: '',
      objections: [], competitors: [], script: 'premium-homecare-v3', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 1, dayOffset: 4, hour: 10, minute: 16, outcome: 'busy', analysis_status: 'pending',
      rating: null, sentiment_label: null, hot_lead_score: 0,
      review: null,
      summary: null,
      excerpt: null,
      task: 'Retry before 11 AM tomorrow.',
      objections: [], competitors: [], script: 'thyroid-followup-v2', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 2, dayOffset: 4, hour: 17, minute: 44, outcome: 'completed', analysis_status: 'completed',
      rating: 4, sentiment_label: 'positive', hot_lead_score: 64,
      review: 'The staff explained the vitamin profile well and the experience was smooth.',
      summary: 'Healthy patient experience with modest repeat-booking potential.',
      excerpt: 'Positive experience, medium commercial value.',
      task: '',
      objections: [], competitors: [], script: 'nutrition-recall-v1', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 3, dayOffset: 5, hour: 12, minute: 6, outcome: 'completed', analysis_status: 'completed',
      rating: 2, sentiment_label: 'negative', hot_lead_score: 30,
      review: 'This time the explanation was better, but my previous late pickup issue is still unresolved.',
      summary: 'Recovery improving, but complaint not fully closed. Requires manager ownership.',
      excerpt: 'Sentiment still negative because original issue remains open.',
      task: 'Manager callback with concrete resolution and concession.',
      objections: ['service recovery pending'], competitors: [], script: 'recovery-script-v1', callback: 1, escalation: 1, liveRedFlag: 1, supervisorLevel: 'high'
    },
    {
      customerIndex: 4, dayOffset: 6, hour: 8, minute: 50, outcome: 'completed', analysis_status: 'completed',
      rating: 5, sentiment_label: 'positive', hot_lead_score: 93,
      review: 'Everything was seamless and I would recommend this home collection service to my relatives.',
      summary: 'Referral-ready promoter. Ideal candidate for referral nudge and repeat package offer.',
      excerpt: 'Promoter-level response with referral opportunity.',
      task: 'Share referral coupon link.',
      objections: [], competitors: [], script: 'premium-homecare-v3', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 6, dayOffset: 7, hour: 19, minute: 10, outcome: 'completed', analysis_status: 'completed',
      rating: 4, sentiment_label: 'positive', hot_lead_score: 75,
      review: 'Evening callback helped. Please message the final offer and I will likely book this weekend.',
      summary: 'Callback strategy worked. Weekend conversion likely if offer is pushed quickly.',
      excerpt: 'Warm lead after evening re-engagement.',
      task: 'Send final offer on WhatsApp and hold weekend slot.',
      objections: ['needs written offer'], competitors: [], script: 'women-wellness-v2', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 8, dayOffset: 8, hour: 10, minute: 4, outcome: 'completed', analysis_status: 'completed',
      rating: 5, sentiment_label: 'positive', hot_lead_score: 84,
      review: 'Very courteous staff and my son also liked the professionalism.',
      summary: 'Senior care proposition is landing well with both patient and caregiver.',
      excerpt: 'Positive family response to senior care service.',
      task: '',
      objections: [], competitors: [], script: 'senior-care-v1', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 10, dayOffset: 9, hour: 15, minute: 30, outcome: 'completed', analysis_status: 'completed',
      rating: 5, sentiment_label: 'positive', hot_lead_score: 83,
      review: 'Reminder timing was perfect and the package sounds relevant for me.',
      summary: 'Reminder quality strong; patient is a good candidate for next package conversation.',
      excerpt: 'Good engagement from wellness recall cohort.',
      task: '',
      objections: [], competitors: [], script: 'women-wellness-v2', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    },
    {
      customerIndex: 11, dayOffset: 10, hour: 17, minute: 58, outcome: 'no_answer', analysis_status: 'pending',
      rating: null, sentiment_label: null, hot_lead_score: 0,
      review: null,
      summary: null,
      excerpt: null,
      task: 'Retry with founder-level intro in next attempt.',
      objections: [], competitors: [], script: 'corporate-lead-v1', callback: 0, escalation: 0, liveRedFlag: 0, supervisorLevel: 'normal'
    }
  ];

  let feedbackCount = 0;

  for (let index = 0; index < calls.length; index += 1) {
    const item = calls[index];
    const customerId = customerIds[item.customerIndex];
    const calledAt = isoAt(item.dayOffset, item.hour, item.minute);
    const nextActionAt = item.task ? isoAt(Math.max(item.dayOffset - 1, 0), Math.min(item.hour + 2, 20), item.minute) : null;
    const transcriptText = item.review
      ? `[AGENT]: Thank you for your time today.\n[CUSTOMER]: ${item.review}\n[NOTE]: ${item.summary || 'Call notes captured.'}`
      : '[AGENT]: Follow-up call attempt completed.\n[NOTE]: No detailed transcript captured for this attempt.';

    const result = await run(
      `INSERT INTO calls (
        customer_id, called_at, outcome, provider_call_id, transcript_text, consent_detected, language,
        extracted_rating, extracted_review_text, recording_status, transcript_status, transcript_source,
        analysis_status, analysis_summary, report_excerpt, outcome_detail, fallback_triggered,
        sentiment_label, sentiment_score, hot_lead_score, next_action_at, follow_up_task,
        recording_download_status, crm_sync_status, whatsapp_summary_sent, revenue_attribution_status,
        call_script_version, competitor_mentions_json, objections_json, interest_detected,
        callback_requested, human_escalation_requested, supervisor_alert_level, agent_id,
        live_sentiment_score, live_sentiment_label, live_red_flag, recording_url, recording_sid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        calledAt,
        item.outcome,
        `seed-call-${Date.now()}-${index}`,
        transcriptText,
        ['completed', 'interested', 'callback'].includes(item.outcome) ? 1 : 0,
        patients[item.customerIndex].preferred_language === 'en' ? 'en' : 'hi',
        item.rating,
        item.review,
        ['completed', 'interested', 'callback'].includes(item.outcome) ? 'completed' : 'pending',
        ['completed', 'interested', 'callback'].includes(item.outcome) ? 'completed' : 'pending',
        ['completed', 'interested', 'callback'].includes(item.outcome) ? 'live' : null,
        item.analysis_status,
        item.summary,
        item.excerpt,
        item.outcome,
        item.outcome === 'failed' ? 1 : 0,
        item.sentiment_label,
        item.sentiment_label === 'positive' ? 0.84 : item.sentiment_label === 'negative' ? -0.82 : item.sentiment_label === 'neutral' ? 0.12 : null,
        item.hot_lead_score,
        nextActionAt,
        item.task || null,
        ['completed', 'interested', 'callback'].includes(item.outcome) ? 'completed' : 'pending',
        ['completed', 'interested', 'callback'].includes(item.outcome) ? 'synced' : 'pending',
        ['completed', 'interested', 'callback'].includes(item.outcome) ? 1 : 0,
        ['completed', 'interested'].includes(item.outcome) ? 'attributed' : 'pending',
        item.script,
        JSON.stringify(item.competitors),
        JSON.stringify(item.objections),
        item.hot_lead_score >= 85 ? 1 : 0,
        item.callback ? 1 : 0,
        item.escalation ? 1 : 0,
        item.supervisorLevel,
        1,
        item.sentiment_label === 'positive' ? 0.76 : item.sentiment_label === 'negative' ? -0.68 : 0.08,
        item.sentiment_label || null,
        item.liveRedFlag,
        ['completed', 'interested', 'callback'].includes(item.outcome) ? `https://example.com/recordings/${index + 1}.mp3` : null,
        ['completed', 'interested', 'callback'].includes(item.outcome) ? `seed-recording-${index + 1}` : null
      ]
    );

    if (item.rating && item.review) {
      const category = item.rating >= 4 ? 'good' : item.rating === 3 ? 'average' : 'bad';
      await run(
        `INSERT INTO feedback (customer_id, call_id, review_text, category, stars, submitted_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [customerId, result.lastID, item.review, category, item.rating, calledAt, 'ai_call']
      );
      feedbackCount += 1;
    }

    await run(
      `UPDATE customers
          SET last_called_at = ?,
              last_contact_outcome = ?,
              last_sentiment_label = COALESCE(?, last_sentiment_label),
              last_sentiment_score = COALESCE(?, last_sentiment_score),
              pending_follow_ups = COALESCE(?, pending_follow_ups),
              last_competitor_mention = COALESCE(?, last_competitor_mention)
        WHERE id = ?`,
      [
        calledAt,
        item.outcome,
        item.sentiment_label,
        item.sentiment_label === 'positive' ? 0.84 : item.sentiment_label === 'negative' ? -0.82 : item.sentiment_label === 'neutral' ? 0.12 : null,
        item.task || patients[item.customerIndex].pending_follow_ups || null,
        item.competitors[0] || null,
        customerId
      ]
    );
  }

  console.log(`Seeded ${customerIds.length} realistic customers, ${calls.length} realistic calls, ${feedbackCount} feedback items, and ${campaigns.length} active campaigns.`);
}

seed()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
