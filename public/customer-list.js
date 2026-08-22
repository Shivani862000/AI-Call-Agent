let allCustomers = [];

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

let currentCustomerPage = 1;

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
      <td><span class="status-badge active">${AppShell.escapeHtml(customer.preferred_language || 'hindi')}</span></td>
    `;
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
window.addEventListener('app:pagination:resize', handleSearch);

function handleSearch() {
  const searchTerm = document.getElementById('customerSearch').value.toLowerCase().trim();
  const filtered = allCustomers.filter(customer => {
    const searchableString = `${customer.name || ''} ${customer.phone || ''}`.toLowerCase();
    return searchableString.includes(searchTerm);
  });
  renderCustomerTable(filtered);
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
