require('dotenv').config();
const mongoose = require('mongoose');

let isConnected = false;

async function initializeDatabase() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-call-agent';
  if (isConnected) return;
  
  try {
    await mongoose.connect(uri);
    isConnected = true;
    console.log('Connected to MongoDB Atlas:', uri.split('@').pop());
  } catch (err) {
    console.error('Error opening database:', err);
    throw err;
  }
}

function getDb() {
  return mongoose.connection;
}

// These are stubbed out as they are SQLite specific, 
// the rest of the application must be updated to use Mongoose ORM.
function dbRun(sql, params = []) {
  return Promise.reject(new Error("dbRun is deprecated. Use Mongoose ORM."));
}

function dbGet(sql, params = []) {
  return Promise.reject(new Error("dbGet is deprecated. Use Mongoose ORM."));
}

function dbAll(sql, params = []) {
  return Promise.reject(new Error("dbAll is deprecated. Use Mongoose ORM."));
}

function backupDatabase() {
  return Promise.reject(new Error("Backup is not supported in MongoDB integration yet."));
}

function startDatabaseBackupSchedule() {
  return () => {};
}

module.exports = {
  initializeDatabase,
  getDb,
  dbRun,
  dbGet,
  dbAll,
  backupDatabase,
  startDatabaseBackupSchedule
};
