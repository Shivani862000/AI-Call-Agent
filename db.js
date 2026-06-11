require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

let db;

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const dbPath = process.env.DATABASE_URL || './feedback.db';
    
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Error opening database:', err);
        reject(err);
      } else {
        console.log('Connected to SQLite database:', dbPath);
        runMigrations().then(resolve).catch(reject);
      }
    });
  });
}

function runMigrations() {
  const run = (sql) => new Promise((resolve, reject) => {
    db.run(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const addColumnIfMissing = async (tableName, columnName, definition) => {
    const columns = await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(${tableName})`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  };

  const copyLegacyCallIdsToProviderCallId = async () => {
    const legacyColumnName = ['twi', 'lio_sid'].join('');
    const columns = await new Promise((resolve, reject) => {
      db.all('PRAGMA table_info(calls)', (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const hasLegacyColumn = columns.some((column) => column.name === legacyColumnName);
    const hasProviderColumn = columns.some((column) => column.name === 'provider_call_id');
    if (!hasLegacyColumn || !hasProviderColumn) {
      return;
    }

    await run(`UPDATE calls SET provider_call_id = ${legacyColumnName} WHERE provider_call_id IS NULL AND ${legacyColumnName} IS NOT NULL`);
  };

  const enforceCustomersUniquePhone = async () => {
    const tableInfo = await new Promise((resolve, reject) => {
      db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'", (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (tableInfo && !tableInfo.sql.includes('UNIQUE')) {
      console.log('Migrating customers table to enforce UNIQUE constraint on phone...');
      
      // Merge duplicate customers
      const duplicates = await new Promise((resolve, reject) => {
        db.all("SELECT phone, MIN(id) as keep_id FROM customers GROUP BY phone HAVING COUNT(*) > 1", (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });

      for (const dup of duplicates) {
        await run(`UPDATE calls SET customer_id = ${dup.keep_id} WHERE customer_id IN (SELECT id FROM customers WHERE phone = '${dup.phone}' AND id != ${dup.keep_id})`);
        await run(`UPDATE feedback SET customer_id = ${dup.keep_id} WHERE customer_id IN (SELECT id FROM customers WHERE phone = '${dup.phone}' AND id != ${dup.keep_id})`);
        await run(`DELETE FROM customers WHERE phone = '${dup.phone}' AND id != ${dup.keep_id}`);
      }

      let newSql = tableInfo.sql.replace(/phone VARCHAR\(20\) NOT NULL/i, 'phone VARCHAR(20) NOT NULL UNIQUE');
      newSql = newSql.replace(/CREATE TABLE "?customers"?/i, 'CREATE TABLE customers_new');
      
      await run(`DROP TABLE IF EXISTS customers_new`);
      await run(newSql);
      
      const columns = await new Promise((resolve, reject) => {
        db.all("PRAGMA table_info(customers)", (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });
      const colNames = columns.map(c => c.name).join(', ');
      
      await run(`INSERT INTO customers_new (${colNames}) SELECT ${colNames} FROM customers`);
      await run(`DROP TABLE customers`);
      await run(`ALTER TABLE customers_new RENAME TO customers`);
    }
  };

  return (async () => {
    await run(`
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL UNIQUE,
        preferred_slot VARCHAR(10) DEFAULT '10:00',
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await enforceCustomersUniquePhone();

    await run(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        called_at TIMESTAMP,
        outcome VARCHAR(20),
        provider_call_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        call_id INTEGER,
        review_text TEXT,
        category VARCHAR(10),
        stars INTEGER,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (call_id) REFERENCES calls(id)
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS call_supervisor_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id INTEGER NOT NULL,
        event_type VARCHAR(40) NOT NULL,
        severity VARCHAR(20) DEFAULT 'info',
        payload_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (call_id) REFERENCES calls(id)
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS campaign_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(100) NOT NULL UNIQUE,
        service_name VARCHAR(100),
        monthly_spend_inr REAL DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(120) NOT NULL UNIQUE,
        description TEXT,
        client_name VARCHAR(100),
        language VARCHAR(20) DEFAULT 'hi',
        voice_pipeline VARCHAR(30) DEFAULT 'legacy',
        stt_provider VARCHAR(30) DEFAULT 'deepgram',
        llm_provider VARCHAR(30) DEFAULT 'gemini',
        llm_model VARCHAR(120),
        tts_provider VARCHAR(30) DEFAULT 'native',
        tts_voice VARCHAR(120),
        system_prompt TEXT,
        opening_prompt TEXT,
        is_default INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL UNIQUE,
        date_of_birth DATE,
        last_visit_date DATE NOT NULL,
        treatment_type VARCHAR(120) NOT NULL,
        annual_reminder_enabled INTEGER DEFAULT 1,
        annual_reminder_slot VARCHAR(10) DEFAULT '10:00',
        next_annual_reminder_date DATE,
        last_annual_reminder_at TIMESTAMP,
        last_annual_reminder_year INTEGER,
        notes TEXT,
        linked_customer_id INTEGER,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (linked_customer_id) REFERENCES customers(id)
      )
    `);

    await addColumnIfMissing('customers', 'customer_value', "VARCHAR(20) DEFAULT 'standard'");
    await addColumnIfMissing('customers', 'urgency_level', "VARCHAR(20) DEFAULT 'normal'");
    await addColumnIfMissing('customers', 'priority_score', 'INTEGER DEFAULT 50');
    await addColumnIfMissing('customers', 'ai_score', 'INTEGER DEFAULT 50');
    await addColumnIfMissing('customers', 'preferred_language', "VARCHAR(20) DEFAULT 'hi'");
    await addColumnIfMissing('customers', 'preferred_dialect', 'VARCHAR(40)');
    await addColumnIfMissing('customers', 'do_not_call', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('customers', 'consent_status', "VARCHAR(20) DEFAULT 'unknown'");
    await addColumnIfMissing('customers', 'last_contact_outcome', 'VARCHAR(40)');
    await addColumnIfMissing('customers', 'next_retry_at', 'TIMESTAMP');
    await addColumnIfMissing('customers', 'retry_count', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('customers', 'wrong_number_flag', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('customers', 'admin_review_required', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('customers', 'callback_requested_at', 'TIMESTAMP');
    await addColumnIfMissing('customers', 'last_called_at', 'TIMESTAMP');
    await addColumnIfMissing('customers', 'best_call_slot', 'VARCHAR(10)');
    await addColumnIfMissing('customers', 'last_pickup_slot', 'VARCHAR(10)');
    await addColumnIfMissing('customers', 'pickup_rate_score', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('customers', 'outstanding_issues', 'TEXT');
    await addColumnIfMissing('customers', 'pending_follow_ups', 'TEXT');
    await addColumnIfMissing('customers', 'last_sentiment_score', 'REAL');
    await addColumnIfMissing('customers', 'last_sentiment_label', 'VARCHAR(20)');
    await addColumnIfMissing('customers', 'revenue_stage', "VARCHAR(30) DEFAULT 'unassigned'");
    await addColumnIfMissing('customers', 'revenue_estimate', 'REAL DEFAULT 0');
    await addColumnIfMissing('customers', 'campaign_name', 'VARCHAR(100)');
    await addColumnIfMissing('customers', 'service_interest', 'VARCHAR(100)');
    await addColumnIfMissing('customers', 'call_type', "VARCHAR(50) DEFAULT 'REVIEW_CALL'");
    await addColumnIfMissing('customers', 'last_competitor_mention', 'TEXT');
    await addColumnIfMissing('customers', 'data_retention_until', 'TIMESTAMP');
    await addColumnIfMissing('customers', 'dnd_checked_at', 'TIMESTAMP');
    await addColumnIfMissing('customers', 'default_agent_id', 'INTEGER');
    await addColumnIfMissing('customers', 'video_sent', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('customers', 'last_visit_date', 'DATE');
    await addColumnIfMissing('clients', 'date_of_birth', 'DATE');
    await addColumnIfMissing('clients', 'annual_reminder_enabled', 'INTEGER DEFAULT 1');
    await addColumnIfMissing('clients', 'annual_reminder_slot', "VARCHAR(10) DEFAULT '10:00'");
    await addColumnIfMissing('clients', 'next_annual_reminder_date', 'DATE');
    await addColumnIfMissing('clients', 'last_annual_reminder_at', 'TIMESTAMP');
    await addColumnIfMissing('clients', 'last_annual_reminder_year', 'INTEGER');
    await addColumnIfMissing('clients', 'notes', 'TEXT');
    await addColumnIfMissing('clients', 'linked_customer_id', 'INTEGER');
    await addColumnIfMissing('clients', 'status', "VARCHAR(20) DEFAULT 'active'");
    await addColumnIfMissing('clients', 'updated_at', 'TIMESTAMP');

    await addColumnIfMissing('calls', 'provider_call_id', 'VARCHAR(100)');
    await addColumnIfMissing('calls', 'status', "VARCHAR(30) DEFAULT 'pending'");
    await addColumnIfMissing('calls', 'scheduled_at', 'TIMESTAMP');
    await addColumnIfMissing('calls', 'updated_at', 'TIMESTAMP');
    await copyLegacyCallIdsToProviderCallId();
    await addColumnIfMissing('calls', 'call_direction', "VARCHAR(20) DEFAULT 'outbound'");
    await addColumnIfMissing('calls', 'call_source', "VARCHAR(40) DEFAULT 'icallmate'");
    await addColumnIfMissing('calls', 'did', 'VARCHAR(40)');
    await addColumnIfMissing('calls', 'answered_at', 'TIMESTAMP');
    await addColumnIfMissing('calls', 'ended_at', 'TIMESTAMP');
    await addColumnIfMissing('calls', 'media_packets', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'last_event', 'VARCHAR(40)');
    await addColumnIfMissing('calls', 'notes', 'TEXT');
    await addColumnIfMissing('calls', 'provider_payload_json', 'TEXT');
    await addColumnIfMissing('calls', 'transcript_text', 'TEXT');
    await addColumnIfMissing('calls', 'consent_detected', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'language', 'VARCHAR(10)');
    await addColumnIfMissing('calls', 'extracted_rating', 'INTEGER');
    await addColumnIfMissing('calls', 'extracted_review_text', 'TEXT');
    await addColumnIfMissing('calls', 'feedback_saved_at', 'TIMESTAMP');
    await addColumnIfMissing('calls', 'recording_sid', 'VARCHAR(100)');
    await addColumnIfMissing('calls', 'recording_url', 'TEXT');
    await addColumnIfMissing('calls', 'recording_status', 'VARCHAR(30)');
    await addColumnIfMissing('calls', 'recording_local_path', 'TEXT');
    await addColumnIfMissing('calls', 'transcript_status', "VARCHAR(30) DEFAULT 'pending'");
    await addColumnIfMissing('calls', 'transcript_source', 'VARCHAR(20)');
    await addColumnIfMissing('calls', 'analysis_status', "VARCHAR(30) DEFAULT 'pending'");
    await addColumnIfMissing('calls', 'analysis_summary', 'TEXT');
    await addColumnIfMissing('calls', 'summary', 'TEXT');
    await addColumnIfMissing('calls', 'analysis_json', 'TEXT');
    await addColumnIfMissing('calls', 'key_points_json', 'TEXT');
    await addColumnIfMissing('calls', 'report_excerpt', 'TEXT');
    await addColumnIfMissing('calls', 'analysis_completed_at', 'TIMESTAMP');
    await addColumnIfMissing('calls', 'outcome_detail', 'VARCHAR(40)');
    await addColumnIfMissing('calls', 'fallback_triggered', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'sentiment_label', 'VARCHAR(20)');
    await addColumnIfMissing('calls', 'sentiment', 'VARCHAR(20)');
    await addColumnIfMissing('calls', 'sentiment_score', 'REAL');
    await addColumnIfMissing('calls', 'call_duration', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'call_end_reason', 'VARCHAR(50)');
    await addColumnIfMissing('calls', 'ai_talk_time', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'patient_talk_time', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'quality_score', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'timeline_events', 'TEXT');
    await addColumnIfMissing('calls', 'extracted_entities', 'TEXT');
    await addColumnIfMissing('calls', 'hot_lead_score', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'next_action_at', 'TIMESTAMP');
    await addColumnIfMissing('calls', 'follow_up_task', 'TEXT');
    await addColumnIfMissing('calls', 'uuid', 'VARCHAR(36)');
    await addColumnIfMissing('calls', 'recording_download_status', "VARCHAR(30) DEFAULT 'pending'");
    await addColumnIfMissing('calls', 'crm_sync_status', "VARCHAR(30) DEFAULT 'pending'");
    await addColumnIfMissing('calls', 'revenue_attribution_status', "VARCHAR(30) DEFAULT 'pending'");
    await addColumnIfMissing('calls', 'call_script_version', "VARCHAR(40) DEFAULT 'hindi-feedback-v1'");
    await addColumnIfMissing('calls', 'call_type', "VARCHAR(50) DEFAULT 'REVIEW_CALL'");
    await addColumnIfMissing('calls', 'competitor_mentions_json', 'TEXT');
    await addColumnIfMissing('calls', 'objections_json', 'TEXT');
    await addColumnIfMissing('calls', 'interest_detected', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'callback_requested', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'human_escalation_requested', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'supervisor_alert_level', "VARCHAR(20) DEFAULT 'normal'");
    await addColumnIfMissing('calls', 'supervisor_notes', 'TEXT');
    await addColumnIfMissing('calls', 'consent_message_played', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'recording_consent_captured', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'invoice_triggered', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'proposal_triggered', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'live_sentiment_score', 'REAL');
    await addColumnIfMissing('calls', 'live_sentiment_label', 'VARCHAR(20)');
    await addColumnIfMissing('calls', 'live_red_flag', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('calls', 'agent_id', 'INTEGER');
    await addColumnIfMissing('feedback', 'source', "VARCHAR(20) DEFAULT 'manual'");

    const defaultAgent = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM agents WHERE slug = ?', ['default-feedback-agent'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!defaultAgent) {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO agents (
            name, slug, description, client_name, language, voice_pipeline,
            stt_provider, llm_provider, llm_model, tts_provider, tts_voice,
            system_prompt, opening_prompt, is_default, is_active, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'Default Feedback Agent',
            'default-feedback-agent',
            'Default Hindi-first feedback collection agent',
            process.env.CLIENT_NAME || 'your diagnostic and medical collection center',
            'hi',
            'legacy',
            'deepgram',
            'gemini',
            process.env.GEMINI_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
            'native',
            process.env.GEMINI_VOICE || null,
            null,
            null,
            1,
            1,
            new Date().toISOString()
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    console.log('✓ All tables created/verified');
  })();
}

function getDb() {
  return db;
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = {
  initializeDatabase,
  getDb,
  dbRun,
  dbGet,
  dbAll
};
