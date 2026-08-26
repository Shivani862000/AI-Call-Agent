const { createClientsRepository } = require('./clients');
const { createCustomersRepository } = require('./customers');
const { createCallsRepository } = require('./calls');
const { createFeedbackRepository } = require('./feedback');
const { createSupervisorEventsRepository } = require('./supervisor-events');
const { createReportingRepository } = require('./reporting');
const { createAgentsRepository } = require('./agents');
const { createCampaignConfigurationsRepository } = require('./campaign-configurations');
const { createSupportTicketsRepository } = require('./support-tickets');
const { createApplicationStateRepository } = require('./application-state');

function createRepositories(database) {
  return {
    clients: createClientsRepository(database),
    customers: createCustomersRepository(database),
    calls: createCallsRepository(database),
    feedback: createFeedbackRepository(database),
    supervisorEvents: createSupervisorEventsRepository(database),
    reporting: createReportingRepository(database),
    agents: createAgentsRepository(database),
    campaignConfigurations: createCampaignConfigurationsRepository(database),
    supportTickets: createSupportTicketsRepository(database),
    applicationState: createApplicationStateRepository(database)
  };
}

module.exports = { createRepositories };
