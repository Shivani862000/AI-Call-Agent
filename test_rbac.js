const { initializeDatabase, dbAll, dbRun } = require('./db');

(async () => {
  try {
    await initializeDatabase();
    console.log('Database initialized');
    const users = await dbAll('SELECT * FROM users');
    console.log('Users:', users);
    
    // Add a test agent user
    if (!users.find(u => u.username === 'agent1')) {
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync('1234', 10);
      await dbRun('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['agent1', hash, 'AGENT']);
      console.log('Added test agent1');
    }
  } catch (err) {
    console.error(err);
  }
})();
