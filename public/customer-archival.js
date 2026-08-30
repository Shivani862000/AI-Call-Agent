(function exposeCustomerArchival(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CustomerArchival = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function buildCustomerArchival() {
  'use strict';

  const ARCHIVE_CONFIRMATION = 'Archive this record? It will be retained and can be restored later.';

  function createCustomerArchivalActions({ confirmAction, fetchJson, showAlert, reload, apiBase }) {
    async function archiveCustomer(customerId) {
      if (!confirmAction(ARCHIVE_CONFIRMATION)) return false;
      const result = await fetchJson(`${apiBase}/customers/${encodeURIComponent(customerId)}/archive`, {
        method: 'POST'
      });
      showAlert(result.message || 'Customer archived successfully');
      await reload();
      return true;
    }

    return { archiveCustomer };
  }

  return { ARCHIVE_CONFIRMATION, createCustomerArchivalActions };
});
