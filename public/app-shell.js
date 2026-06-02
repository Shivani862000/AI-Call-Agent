(function () {
  const API_BASE = `${window.location.origin}/api`;
  const NAV_ITEMS = [
    { href: '/admin.html', label: 'Overview', shortLabel: 'Home' },
    { href: '/incoming-calls.html', label: 'Incoming Calls', shortLabel: 'Calls' },
    { href: '/customers.html', label: 'Outbound Calls', shortLabel: 'Outbound' },
    { href: '/feedback.html', label: 'Feedback', shortLabel: 'Feedback' },
    { href: '/reports.html', label: 'Reports', shortLabel: 'Reports' }
  ];
  const now = new Date();
  const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60000).toISOString();
  const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  const todayAt = (hours, minutes) => {
    const date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
    return date.toISOString();
  };
  const DEMO_DATA = {
    customers: [
      { id: 901, name: 'Ananya Sharma', phone: '+919876543210', preferred_slot: '10:30', status: 'pending', created_at: todayAt(9, 15), updated_at: todayAt(9, 15) },
      { id: 902, name: 'Rajiv Mehta', phone: '+919812345670', preferred_slot: '12:15', status: 'completed', created_at: todayAt(8, 45), updated_at: todayAt(12, 40) },
      { id: 903, name: 'Neha Kapoor', phone: '+919765432109', preferred_slot: '16:00', status: 'retry_scheduled', created_at: daysAgo(1), updated_at: todayAt(11, 25) }
    ],
    clients: [
      { id: 801, name: 'Ananya Sharma', phone: '+919876543210', date_of_birth: '1991-04-14', last_visit_date: '2026-05-12', treatment_type: 'Thyroid profile', annual_reminder_enabled: 1, annual_reminder_slot: '10:30', status: 'active' },
      { id: 802, name: 'Rajiv Mehta', phone: '+919812345670', date_of_birth: '1984-09-02', last_visit_date: '2026-05-16', treatment_type: 'Full body checkup', annual_reminder_enabled: 1, annual_reminder_slot: '12:15', status: 'active' },
      { id: 803, name: 'Neha Kapoor', phone: '+919765432109', date_of_birth: '1996-01-23', last_visit_date: '2026-05-10', treatment_type: 'Vitamin D test', annual_reminder_enabled: 1, annual_reminder_slot: '16:00', status: 'active' }
    ],
    recentCalls: [
      {
        id: 701,
        customer_id: 902,
        customer_name: 'Rajiv Mehta',
        called_at: minutesAgo(28),
        outcome: 'completed',
        analysis_status: 'completed',
        transcript_status: 'completed',
        extracted_rating: 5,
        extracted_review_text: 'Collection was on time and the report was easy to understand.',
        analysis_summary: 'Patient appreciated timely collection and wants the annual reminder enabled.',
        report_excerpt: 'High satisfaction, good candidate for repeat preventive package.',
        follow_up_task: 'Send wellness package details',
        agent_name: 'AI Follow-up Agent'
      },
      {
        id: 702,
        customer_id: 903,
        customer_name: 'Neha Kapoor',
        called_at: minutesAgo(76),
        outcome: 'busy',
        analysis_status: 'pending',
        transcript_status: 'pending',
        extracted_rating: 0,
        analysis_summary: 'Patient was busy; retry after 4 PM.',
        follow_up_task: 'Retry after 4 PM',
        agent_name: 'AI Follow-up Agent'
      },
      {
        id: 703,
        customer_id: 901,
        customer_name: 'Ananya Sharma',
        called_at: daysAgo(1),
        outcome: 'completed',
        analysis_status: 'needs_review',
        transcript_status: 'completed',
        extracted_rating: 2,
        extracted_review_text: 'Report delivery was delayed and nobody called back.',
        analysis_summary: 'Service recovery needed due to delayed report communication.',
        report_excerpt: 'Negative sentiment around report delay.',
        follow_up_task: 'Supervisor callback today',
        agent_name: 'AI Follow-up Agent'
      }
    ],
    feedback: [
      { id: 601, customer_id: 902, customer_name: 'Rajiv Mehta', stars: 5, review_text: 'Collection was on time and the report was easy to understand.', source: 'ai_call', submitted_at: minutesAgo(24) },
      { id: 602, customer_id: 901, customer_name: 'Ananya Sharma', stars: 2, review_text: 'Report delivery was delayed and nobody called back.', source: 'ai_call', submitted_at: daysAgo(1) },
      { id: 603, customer_id: 903, customer_name: 'Neha Kapoor', stars: 4, review_text: 'Booking was smooth. Please call after office hours next time.', source: 'manual', submitted_at: daysAgo(2) }
    ],
    preview: {
      total_calls: 3,
      success_rate: 67,
      callback_backlog_count: 1,
      service_recovery_count: 1,
      hot_leads: 1,
      revenue_pipeline_estimate: 18000,
      report_headline: 'Daily operations snapshot: strong follow-up with one recovery case',
      summary_text: 'The AI team completed high-value follow-ups, captured patient sentiment, and highlighted one callback that needs attention before end of day.',
      priority_actions: ['Call Ananya for report-delay recovery', 'Send Rajiv the preventive package offer', 'Retry Neha after 4 PM'],
      hot_lead_queue: [{ customer_name: 'Rajiv Mehta', hot_lead_score: 88, follow_up_task: 'Share full body checkup renewal package' }],
      service_recovery_queue: [{ customer_name: 'Ananya Sharma', issue: 'Delayed report delivery', follow_up_task: 'Supervisor apology callback' }]
    },
    ownerPreview: {
      alerts: [
        { headline: 'One recovery callback should be closed today' },
        { headline: 'Review outbound queue with feedback trends' }
      ]
    }
  };

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
      window.__testCallWidgetInstance.mount();
    }
  }

  function loadTestCallWidgetScript() {
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
    DEMO_DATA,
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
