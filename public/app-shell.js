(function () {
  const API_BASE = `${window.location.origin}/api`;

  function redirectToLogin() {
    window.location.replace('/login.html');
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(path, {
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.headers || {})
      }
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (response.status === 401) {
      redirectToLogin();
      throw new Error('Authentication required');
    }

    if (!response.ok) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }

    return payload;
  }

  async function ensureAuthenticatedSession() {
    return fetchJson('/api/auth/session');
  }

  async function logoutAdmin(button) {
    const originalText = button ? button.textContent : 'Logout';
    if (button) {
      button.disabled = true;
      button.textContent = 'Signing out...';
    }

    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
      redirectToLogin();
    }
  }

  function showAlert(message, type = 'success') {
    const alertContainer = document.getElementById('alertContainer');
    if (!alertContainer) return;
    const alertEl = document.createElement('div');
    alertEl.className = `alert ${type}`;
    alertEl.textContent = message;
    alertContainer.appendChild(alertEl);
    setTimeout(() => alertEl.remove(), 5000);
  }

  function clearFieldErrors(fieldIds) {
    fieldIds.forEach((id) => {
      const input = document.getElementById(id);
      const errorEl = document.getElementById(`${id}Error`);
      if (input) input.classList.remove('input-invalid');
      if (errorEl) errorEl.textContent = '';
    });
  }

  function applyFieldErrors(fieldErrors = {}, fieldIdMap = {}) {
    Object.entries(fieldErrors).forEach(([field, message]) => {
      const fieldId = fieldIdMap[field] || field;
      const input = document.getElementById(fieldId);
      const errorEl = document.getElementById(`${fieldId}Error`);
      if (input) input.classList.add('input-invalid');
      if (errorEl) errorEl.textContent = message;
    });
  }

  function formatStatusLabel(status) {
    return String(status || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Unknown';
  }

  function formatDate(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString();
  }

  function formatDateTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  function formatCurrencyInr(value) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0
    }).format(Number(value || 0));
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.AppShell = {
    API_BASE,
    applyFieldErrors,
    clearFieldErrors,
    ensureAuthenticatedSession,
    escapeHtml,
    fetchJson,
    formatCurrencyInr,
    formatDate,
    formatDateTime,
    formatStatusLabel,
    logoutAdmin,
    redirectToLogin,
    showAlert
  };
})();
