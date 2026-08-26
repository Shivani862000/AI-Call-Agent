const { createClientsRepository } = require('./clients');
const { createCustomersRepository } = require('./customers');
const { createCallsRepository } = require('./calls');
const { createFeedbackRepository } = require('./feedback');
const { createSupervisorEventsRepository } = require('./supervisor-events');
const { createReportingRepository } = require('./reporting');

function createRepositories(database) {
  return {
    clients: createClientsRepository(database),
    customers: createCustomersRepository(database),
    calls: createCallsRepository(database),
    feedback: createFeedbackRepository(database),
    supervisorEvents: createSupervisorEventsRepository(database),
    reporting: createReportingRepository(database)
  };
}

module.exports = { createRepositories };
