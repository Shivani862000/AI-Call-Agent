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
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Create customers table
      db.run(`
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name VARCHAR(100) NOT NULL,
          phone VARCHAR(20) NOT NULL UNIQUE,
          preferred_slot VARCHAR(10) DEFAULT '10:00',
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) console.error('Error creating customers table:', err);
      });

      // Create calls table
      db.run(`
        CREATE TABLE IF NOT EXISTS calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL,
          called_at TIMESTAMP,
          outcome VARCHAR(20),
          twilio_sid VARCHAR(100),
          whatsapp_sent BOOLEAN DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (customer_id) REFERENCES customers(id)
        )
      `, (err) => {
        if (err) console.error('Error creating calls table:', err);
      });

      // Create feedback table
      db.run(`
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
      `, (err) => {
        if (err) console.error('Error creating feedback table:', err);
        else {
          console.log('✓ All tables created/verified');
          resolve();
        }
      });
    });
  });
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
