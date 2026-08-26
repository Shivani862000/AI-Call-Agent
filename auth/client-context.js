const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithClient(clientId, work) {
  return storage.run({ clientId }, work);
}

function currentClientId() {
  return storage.getStore()?.clientId || null;
}

module.exports = { currentClientId, runWithClient };
