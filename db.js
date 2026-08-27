function initializeDatabase() {
  return Promise.resolve();
}

function getDb() {
  return null;
}

function dbRun() {
  return Promise.reject(new Error("dbRun is deprecated. Use Supabase."));
}

function dbGet() {
  return Promise.reject(new Error("dbGet is deprecated. Use Supabase."));
}

function dbAll() {
  return Promise.reject(new Error("dbAll is deprecated. Use Supabase."));
}

function backupDatabase() {
  return Promise.resolve();
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
