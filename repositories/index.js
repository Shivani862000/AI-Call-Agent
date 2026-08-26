const { createClientsRepository } = require('./clients');
const { createCustomersRepository } = require('./customers');

function createRepositories(database) {
  return {
    clients: createClientsRepository(database),
    customers: createCustomersRepository(database)
  };
}

module.exports = { createRepositories };
