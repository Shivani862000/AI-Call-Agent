let allCustomers = [];

async function archiveCustomer(customerId) {
  try {
    const actions = CustomerArchival.createCustomerArchivalActions({
      confirmAction: window.confirm,
      fetchJson: AppShell.fetchJson,
      showAlert: AppShell.showAlert,
      reload: loadCustomerData,
      apiBase: AppShell.API_BASE
    });
    await actions.archiveCustomer(customerId);
  } catch (error) {
    AppShell.showAlert(error.message, 'error');
  }
}

async function loadCustomerData() {
  try {
    const response = await AppShell.fetchJson(`${AppShell.API_BASE}/customers`);
    
    // Deduplicate by phone number (keep only the first occurrence, which is the most recent due to backend ordering)
    const seenPhones = new Set();
    allCustomers = response.filter(customer => {
      const normalizedPhone = (customer.phone || '').trim().replace(/\D/g, '').slice(-10);
      if (seenPhones.has(normalizedPhone)) {
        return false;
      }
      seenPhones.add(normalizedPhone);
      return true;
    });

    renderCustomerTable(allCustomers);
  } catch (error) {
    console.error('Error loading customers:', error);
    AppShell.showAlert('Failed to load customers', 'error');
  }
}

function formatLanguage(langCode) {
  const map = { hi: 'Hindi', en: 'English', mixed: 'Mixed', hinglish: 'Hinglish' };
  return map[langCode?.toLowerCase()] || 'Hindi';
}

let currentCustomerPage = 1;
let editingCustomerId = null;
let editingOriginalSlot = '';
let editingScheduledDate = '';

function renderCustomerTable(customers) {
  document.getElementById('totalCustomersMetric').textContent = customers.length;
  document.getElementById('tableMeta').textContent = `${customers.length} records found`;

  const paged = AppShell.Pagination.getPagedItems(customers, currentCustomerPage);
  currentCustomerPage = paged.currentPage;
  
  const tbody = document.getElementById('customersTableBody');
  tbody.innerHTML = '';

  if (paged.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px;">No customers found.</td></tr>';
    document.getElementById('customerPagination').innerHTML = '';
    return;
  }

  paged.items.forEach(customer => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${AppShell.escapeHtml(customer.name)}</strong></td>
      <td>${AppShell.escapeHtml(customer.phone)}</td>
      <td>${AppShell.escapeHtml(customer.preferred_slot || '--')}</td>
      <td><span class="status-badge active">${AppShell.escapeHtml(formatLanguage(customer.preferred_language))}</span></td>
      <td>
        <button class="secondary admin-only-control" type="button" data-edit-customer="${AppShell.escapeHtml(String(customer.id))}" aria-label="Edit ${AppShell.escapeHtml(customer.name)}" title="Edit customer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
        </button>
        <button class="danger admin-only-control" type="button" data-archive-customer="${AppShell.escapeHtml(String(customer.id))}">Archive</button>
      </td>
    `;
    tr.querySelector('[data-edit-customer]').addEventListener('click', () => openEditCustomerModal(customer));
    tr.querySelector('[data-archive-customer]').addEventListener('click', () => archiveCustomer(customer.id));
    tbody.appendChild(tr);
  });

  const paginationContainer = document.getElementById('customerPagination');
  if (paginationContainer) {
    paginationContainer.innerHTML = AppShell.Pagination.renderControls(currentCustomerPage, paged.totalItems, 'changeCustomerPage');
  }
}

function changeCustomerPage(pageNumber) {
  currentCustomerPage = pageNumber;
  handleSearch(); // render based on current search filter
}

window.changeCustomerPage = changeCustomerPage;
window.archiveCustomer = archiveCustomer;
window.addEventListener('app:pagination:resize', handleSearch);

function handleSearch() {
  const searchTerm = document.getElementById('customerSearch').value.toLowerCase().trim();
  const filtered = allCustomers.filter(customer => {
    const searchableString = `${customer.name || ''} ${customer.phone || ''}`.toLowerCase();
    return searchableString.includes(searchTerm);
  });
  renderCustomerTable(filtered);
}

function getNextScheduledDate(slot) {
  if (!slot) return '';
  const [hours, minutes] = slot.split(':').map(Number);
  const scheduled = new Date();
  scheduled.setHours(hours, minutes, 0, 0);
  if (scheduled.getTime() <= Date.now()) scheduled.setDate(scheduled.getDate() + 1);
  return `${scheduled.getFullYear()}-${String(scheduled.getMonth() + 1).padStart(2, '0')}-${String(scheduled.getDate()).padStart(2, '0')}`;
}

function openAddCustomerModal() {
  const modal = document.getElementById('addCustomerModal');
  editingCustomerId = null;
  editingOriginalSlot = '';
  editingScheduledDate = '';
  document.getElementById('addCustomerForm').reset();
  document.getElementById('addCustomerModalTitle').textContent = 'Add Customer';
  document.getElementById('addCustomerModalSubtitle').textContent = 'Create a patient record manually.';
  document.getElementById('submitAddCustomerBtn').textContent = 'Add Customer';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('addCustomerName').focus();
}

function dateValueFromIso(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function openEditCustomerModal(customer) {
  editingCustomerId = customer.id;
  editingOriginalSlot = customer.preferred_slot || '';
  editingScheduledDate = dateValueFromIso(customer.scheduled_datetime);
  document.getElementById('addCustomerName').value = customer.name || '';
  document.getElementById('addCustomerPhone').value = customer.phone || '';
  document.getElementById('addCustomerPreferredSlot').value = editingOriginalSlot;
  document.getElementById('addCustomerPreferredLanguage').value = customer.preferred_language || 'hi';
  document.getElementById('addCustomerModalTitle').textContent = 'Update Customer';
  document.getElementById('addCustomerModalSubtitle').textContent = 'Edit this patient record.';
  document.getElementById('submitAddCustomerBtn').textContent = 'Update Customer';
  const modal = document.getElementById('addCustomerModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('addCustomerName').focus();
}

function closeAddCustomerModal() {
  const modal = document.getElementById('addCustomerModal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

async function handleAddCustomerSubmit(event) {
  event.preventDefault();
  const name = document.getElementById('addCustomerName').value.trim();
  const phone = AppShell.normalizePhoneForApi(document.getElementById('addCustomerPhone').value);
  const preferredSlot = document.getElementById('addCustomerPreferredSlot').value;
  const submitButton = document.getElementById('submitAddCustomerBtn');
  const isEditing = Boolean(editingCustomerId);
  const endpoint = editingCustomerId ? `${AppShell.API_BASE}/customers/${editingCustomerId}` : `${AppShell.API_BASE}/customers`;
  submitButton.disabled = true;
  submitButton.textContent = isEditing ? 'Updating...' : 'Adding...';
  
  AppShell.clearFieldErrors([
    'addCustomerName', 
    'addCustomerPhone', 
    'addCustomerPreferredSlot', 
    'addCustomerPreferredLanguage'
  ]);

  try {
    await AppShell.fetchJson(endpoint, {
      method: editingCustomerId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, preferred_slot: preferredSlot, preferred_language: document.getElementById('addCustomerPreferredLanguage').value, scheduled_date: isEditing && preferredSlot === editingOriginalSlot ? editingScheduledDate : getNextScheduledDate(preferredSlot) })
    });
    closeAddCustomerModal();
    AppShell.showAlert(isEditing ? 'Customer updated successfully' : 'Customer added successfully');
    await loadCustomerData();
  } catch (error) {
    if (error.fieldErrors) {
      AppShell.applyFieldErrors(error.fieldErrors, {
        name: 'addCustomerName',
        phone: 'addCustomerPhone',
        preferred_slot: 'addCustomerPreferredSlot',
        preferred_language: 'addCustomerPreferredLanguage'
      });
    }
    AppShell.showAlert(error.message, 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = isEditing ? 'Update Customer' : 'Add Customer';
  }
}

// Bulk Import Modal Logic
function openBulkImportModal() {
  const modal = document.getElementById('bulkImportModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('importResults').style.display = 'none';
  document.getElementById('csvFileInput').value = '';
}

function closeBulkImportModal() {
  const modal = document.getElementById('bulkImportModal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

async function handleBulkImportSubmit(event) {
  event.preventDefault();
  
  const fileInput = document.getElementById('csvFileInput');
  const file = fileInput.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const submitBtn = document.getElementById('submitImportBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading...';
  
  try {
    const response = await fetch(`${AppShell.API_BASE}/customers/csv`, {
      method: 'POST',
      body: formData
    });
    
    // Attempt to read JSON error if status is not ok but it has a JSON body
    let result;
    try {
      result = await response.json();
    } catch (e) {
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      result = {};
    }
    
    if (!response.ok) {
      throw new Error(result.error || `Server error ${response.status}`);
    }

    // Show results
    document.getElementById('importResults').style.display = 'block';
    document.getElementById('importStats').innerHTML = `
      <span style="color: var(--success)">✅ Successfully imported: <strong>${result.successCount}</strong></span><br>
      <span style="color: var(--color-danger)">❌ Failed: <strong>${result.errorCount}</strong></span>
    `;

    const errorsDiv = document.getElementById('importErrors');
    errorsDiv.innerHTML = '';
    if (result.errors && result.errors.length > 0) {
      result.errors.forEach(err => {
        let errMsg = err.error || JSON.stringify(err.fieldErrors);
        errorsDiv.innerHTML += `<div>Row ${err.row}: ${errMsg}</div>`;
      });
      if (result.errorCount > 10) {
         errorsDiv.innerHTML += `<div>...and ${result.errorCount - 10} more errors.</div>`;
      }
    }

    AppShell.showAlert(`Import complete! ${result.successCount} added.`);
    loadCustomerData(); // Refresh list

  } catch (error) {
    console.error('Import error:', error);
    AppShell.showAlert(error.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Upload & Import';
    fileInput.value = '';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await AppShell.ensureAuthenticatedSession();
  } catch (error) {
    return; // Will redirect automatically
  }
  
  loadCustomerData();

  // Search Listener
  document.getElementById('customerSearch').addEventListener('input', handleSearch);

  // Refresh Button
  document.getElementById('refreshDataButton').addEventListener('click', loadCustomerData);

  // Bulk Import Listeners
  document.getElementById('addCustomerButton').addEventListener('click', openAddCustomerModal);
  document.getElementById('addCustomerModalClose').addEventListener('click', closeAddCustomerModal);
  document.getElementById('cancelAddCustomerBtn').addEventListener('click', closeAddCustomerModal);
  document.getElementById('addCustomerForm').addEventListener('submit', handleAddCustomerSubmit);
  document.getElementById('importCsvButton').addEventListener('click', openBulkImportModal);
  document.getElementById('bulkImportModalClose').addEventListener('click', closeBulkImportModal);
  document.getElementById('cancelImportBtn').addEventListener('click', closeBulkImportModal);
  document.getElementById('bulkImportForm').addEventListener('submit', handleBulkImportSubmit);

  // Mobile Menu Listeners
  const mobileMenuBtn = document.getElementById('mobileHeaderMenuButton');
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', () => {
      const sheet = document.getElementById('mobileMenuSheet');
      sheet.classList.add('open');
      sheet.setAttribute('aria-hidden', 'false');
    });
  }
  
  const closeMenuBtn = document.getElementById('closeMobileMenuSheet');
  if (closeMenuBtn) {
    closeMenuBtn.addEventListener('click', () => {
      const sheet = document.getElementById('mobileMenuSheet');
      sheet.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true');
    });
  }

  // Logout Listeners
  const logoutBtn = document.getElementById('logoutButton');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => AppShell.logoutAdmin(e.currentTarget));
  }
  
  const mobileLogoutBtn = document.getElementById('mobileMenuLogoutAction');
  if (mobileLogoutBtn) {
    mobileLogoutBtn.addEventListener('click', (e) => AppShell.logoutAdmin(e.currentTarget));
  }
});
