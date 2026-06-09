require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const dbPath = process.env.DATABASE_URL || './feedback.db';
const db = new sqlite3.Database(dbPath);

const run = (sql) => new Promise((resolve, reject) => {
  db.run(sql, (err) => {
    if (err) reject(err);
    else resolve();
  });
});

async function runMigration() {
  const tableInfo = await new Promise((resolve, reject) => {
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'", (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

  if (tableInfo && tableInfo.sql.includes('UNIQUE')) {
    console.log('Migrating customers table to remove UNIQUE constraint on phone...');
    let newSql = tableInfo.sql.replace('phone VARCHAR(20) NOT NULL UNIQUE', 'phone VARCHAR(20) NOT NULL');
    newSql = newSql.replace('CREATE TABLE customers', 'CREATE TABLE customers_new');
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
    console.log('Migration completed successfully.');
  } else {
    console.log('UNIQUE constraint already removed or not found.');
  }
}

runMigration().then(() => db.close()).catch(console.error);
