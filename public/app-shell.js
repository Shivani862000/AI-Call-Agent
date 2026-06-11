(function () {
  const API_BASE = `${window.location.origin}/api`;
  const NAV_ITEMS = [
    { href: '/admin.html', label: 'Overview', shortLabel: 'Overview' },
    { href: '/customers.html', label: 'Outbound Calls', shortLabel: 'Outbound' },
    { href: '/feedback.html', label: 'Feedback', shortLabel: 'Feedback' }
  ];

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
      const error = new Error(payload?.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      error.fieldErrors = payload?.fieldErrors || null;
      throw error;
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
    const rawStatus = String(status || '').toLowerCase();
    const statusMap = {
      called: 'Calling...',
      retry_scheduled: 'Scheduled',
      callback_scheduled: 'Scheduled',
      no_answer: 'No Answer',
      busy: 'Busy',
      failed: 'Failed',
      completed: 'Completed',
      pending: 'Pending',
      hot_lead: 'Hot Lead',
      churn_watch: 'Churn Watch',
      admin_review: 'Review Needed'
    };

    if (statusMap[rawStatus]) {
      return statusMap[rawStatus];
    }

    return String(status || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Unknown';
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString();
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    
    const day = date.getDate();
    const month = date.toLocaleString('default', { month: 'short' });
    const year = date.getFullYear();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toUpperCase();
    
    return `${day} ${month} ${year} • ${time}`;
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

  function buildMobileTabbar() {
    const currentPath = window.location.pathname || '/admin.html';
    const existing = document.querySelector('.mobile-tabbar');
    if (existing) {
      existing.remove();
    }

    const nav = document.createElement('nav');
    nav.className = 'mobile-tabbar';
    nav.setAttribute('aria-label', 'Primary');
    nav.innerHTML = `
      <div class="mobile-tabbar-inner">
        ${NAV_ITEMS.map((item) => {
          const isActive = currentPath === item.href;
          return `
            <a href="${item.href}" class="mobile-tab${isActive ? ' active' : ''}" aria-current="${isActive ? 'page' : 'false'}">
              <span class="mobile-tab-label">${item.shortLabel}</span>
            </a>
          `;
        }).join('')}
      </div>
    `;
    document.body.appendChild(nav);
  }

  function initializeShellChrome() {
    buildMobileTabbar();
    if (window.TestCallWidget && !window.__testCallWidgetInstance) {
      window.__testCallWidgetInstance = new window.TestCallWidget();
      if (typeof window.__testCallWidgetInstance.mount === 'function') {
        window.__testCallWidgetInstance.mount();
      }
    }
  }

  async function loadSharedNewCallModal() {
    if (document.getElementById('newCallModal')) return;
    try {
      const response = await fetch('/components/new-call-modal.html');
      if (response.ok) {
        const html = await response.text();
        document.body.insertAdjacentHTML('beforeend', html);
        const script = document.createElement('script');
        script.src = '/components/new-call-modal.js';
        script.onload = () => {
          if (window.SharedCallModal) window.SharedCallModal.init();
        };
        document.body.appendChild(script);
      }
    } catch (err) {
      console.error('Failed to load shared new call modal', err);
    }
  }

  function loadTestCallWidgetScript() {
    loadSharedNewCallModal();
    if (window.TestCallWidget || document.querySelector('script[data-test-call-widget-script]')) {
      initializeShellChrome();
      return;
    }

    const script = document.createElement('script');
    script.src = '/test-call-widget.js';
    script.defer = true;
    script.dataset.testCallWidgetScript = 'true';
    script.onload = initializeShellChrome;
    script.onerror = initializeShellChrome;
    document.head.appendChild(script);
  }

  document.addEventListener('DOMContentLoaded', loadTestCallWidgetScript);

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
    initializeShellChrome,
    logoutAdmin,
    redirectToLogin,
    showAlert
  };
})();
