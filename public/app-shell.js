(function () {
  const API_BASE = `${window.location.origin}/api`;
  const NAV_ITEMS = [
    { href: '/admin.html', label: 'Overview', shortLabel: 'Home' },
    // Incoming Calls page disabled.
    // { href: '/incoming-calls.html', label: 'Incoming Calls', shortLabel: 'Calls' },
    { href: '/customers.html', label: 'Outbound Calls', shortLabel: 'Outbound' },
    { href: '/feedback.html', label: 'Feedback', shortLabel: 'Feedback' }
    // Reports page disabled.
    // { href: '/reports.html', label: 'Reports', shortLabel: 'Reports' }
  ];
  const SHOW_TEST_AI_CALL_WIDGET = false;

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
    const session = await fetchJson('/api/auth/session');
    if (session.role === 'AGENT') {
      document.body.classList.add('role-agent');
    }
    window.AppShell.session = session;
    return session;
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

  function normalizePhoneForApi(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    if (digits.length > 12) return `+${digits.slice(-12)}`;
    return `+${digits}`;
  }

  function formatPhoneForInput(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(-12);
    const national = digits.startsWith('91') ? digits.slice(2) : digits;
    if (national.length <= 5) return national ? `+91 ${national}` : '';
    return `+91 ${national.slice(0, 5)} ${national.slice(5, 10)}`.trim();
  }

  function normalizeCallType(value) {
    return String(value || 'REVIEW_CALL').toUpperCase() === 'THREE_MONTH_FOLLOWUP'
      ? 'THREE_MONTH_FOLLOWUP'
      : 'REVIEW_CALL';
  }

  function createNewCallModal(options = {}) {
    const mount = document.getElementById(options.mountId || 'newCallModalMount');
    if (!mount) {
      throw new Error('NewCallModal mount element not found');
    }

    const modalId = options.modalId || 'sharedNewCallModal';
    const fieldPrefix = `${modalId}Field`;
    const ids = {
      backdrop: modalId,
      panelTitle: `${modalId}Title`,
      close: `${modalId}Close`,
      cancel: `${modalId}Cancel`,
      submit: `${modalId}Submit`,
      editingId: `${fieldPrefix}EditingId`,
      name: `${fieldPrefix}Name`,
      phone: `${fieldPrefix}Phone`,
      date: `${fieldPrefix}Date`,
      time: `${fieldPrefix}Time`,
      callType: `${fieldPrefix}CallType`,
      careToggle: `${fieldPrefix}CareToggle`,
      dob: `${fieldPrefix}Dob`,
      lastVisit: `${fieldPrefix}LastVisit`,
      treatment: `${fieldPrefix}Treatment`,
      notes: `${fieldPrefix}Notes`
    };

    mount.innerHTML = `
      <div id="${ids.backdrop}" class="modal-backdrop" aria-hidden="true">
        <div class="saas-modal-panel" role="dialog" aria-modal="true" aria-labelledby="${ids.panelTitle}">
          <div class="saas-modal-header">
            <div>
              <h3 id="${ids.panelTitle}" class="saas-modal-title">Schedule New Follow-up Call</h3>
              <div class="saas-modal-subtitle">Create and schedule a customer follow-up call.</div>
            </div>
            <button id="${ids.close}" class="saas-modal-close" type="button" aria-label="Close">
              <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          </div>

          <input id="${ids.editingId}" type="hidden">

          <div class="saas-modal-body">
            
            <div class="saas-form-section saas-card-section">
              <div class="saas-section-title">Patient Information</div>
              <div class="saas-grid-2">
                <div class="saas-field">
                  <label for="${ids.name}">Patient Name <span style="color:var(--color-danger)">*</span></label>
                  <input id="${ids.name}" type="text" maxlength="100" placeholder="e.g. Rahul Sharma" required>
                  <span class="error-text" id="${ids.name}Error"></span>
                </div>
                <div class="saas-field">
                  <label for="${ids.phone}">Phone Number <span style="color:var(--color-danger)">*</span></label>
                  <input id="${ids.phone}" type="tel" placeholder="+91 98765 43210" required>
                  <span class="error-text" id="${ids.phone}Error"></span>
                </div>
              </div>
            </div>

            <div class="saas-form-section">
              <div class="saas-section-title">Schedule Information</div>
              <div class="saas-grid-2">
                <div class="saas-field">
                  <label for="${ids.date}">Call Date</label>
                  <input id="${ids.date}" type="date">
                  <span class="error-text" id="${ids.date}Error"></span>
                </div>
                <div class="saas-field">
                  <label for="${ids.time}">Call Time <span style="color:var(--color-danger)">*</span></label>
                  <input id="${ids.time}" type="time" required>
                  <span class="error-text" id="${ids.time}Error"></span>
                </div>
              </div>
            </div>

            <div class="saas-form-section">
              <div class="saas-section-title">Call Configuration</div>
              
              <div class="saas-field">
                <label style="margin-bottom: 8px;">Call Type</label>
                <div class="saas-campaign-cards">
                  <label class="saas-campaign-card selected">
                    <input type="radio" name="${ids.callType}" value="REVIEW_CALL" checked style="display:none;">
                    <div class="saas-card-content">
                      <strong>Review Calling</strong>
                    </div>
                    <div class="saas-card-check">
                      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path></svg>
                    </div>
                  </label>
                  <label class="saas-campaign-card">
                    <input type="radio" name="${ids.callType}" value="THREE_MONTH_FOLLOWUP" style="display:none;">
                    <div class="saas-card-content">
                      <strong>3 Month Follow-up</strong>
                    </div>
                    <div class="saas-card-check">
                      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path></svg>
                    </div>
                  </label>
                </div>
                <span class="error-text" id="${ids.callType}Error"></span>
              </div>

              <details id="${ids.careToggle}" class="saas-accordion">
                <summary>Additional Care Details (Optional)</summary>
                <div class="saas-accordion-content">
                  
                  <div class="saas-field">
                    <textarea id="${ids.notes}" placeholder="Additional notes for the care team..." rows="3" style="width:100%; border:1px solid #cbd5e1; border-radius:8px; padding:12px; font-size:14px; font-family:inherit; resize:vertical; outline:none; transition:border-color 0.15s, box-shadow 0.15s;" onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59, 130, 246, 0.1)';" onblur="this.style.borderColor='#cbd5e1'; this.style.boxShadow='none';"></textarea>
                  </div>

                  <div id="additionalContextSection" style="margin-top: 8px; display: flex; flex-direction: column; gap: 16px;">
                    <div class="saas-grid-2">
                      <div class="saas-field">
                        <label for="${ids.dob}">Date of Birth</label>
                        <input id="${ids.dob}" type="date">
                        <span class="error-text" id="${ids.dob}Error"></span>
                      </div>
                      <div class="saas-field">
                        <label for="${ids.lastVisit}">Previous Donation Date</label>
                        <input id="${ids.lastVisit}" type="date">
                        <span class="error-text" id="${ids.lastVisit}Error"></span>
                      </div>
                      <div class="saas-field" style="grid-column: span 2;">
                        <label for="${ids.treatment}">Treatment Type</label>
                        <input id="${ids.treatment}" type="text" placeholder="e.g. Blood test">
                        <span class="error-text" id="${ids.treatment}Error"></span>
                      </div>
                    </div>
                  </div>

                </div>
              </details>
              
            </div>

          </div>

          <div class="saas-modal-footer">
            <button id="${ids.cancel}" class="btn-ghost-saas" type="button">Cancel</button>
            <button id="${ids.submit}" class="btn-primary-saas" type="button">Schedule Call</button>
          </div>
        </div>
      </div>
    `;

    const getEl = (key) => document.getElementById(ids[key]);
    let clientCache = [];

    async function ensureClientsLoaded() {
      if (clientCache.length) return clientCache;
      try {
        clientCache = await fetchJson(`${API_BASE}/clients`);
      } catch (error) {
        clientCache = [];
      }
      return clientCache;
    }

    function getClientByPhone(phone) {
      const normalized = normalizePhoneForApi(phone);
      return clientCache.find((client) => normalizePhoneForApi(client.phone) === normalized) || null;
    }

    function setCallTypeSelection(value) {
      const normalized = normalizeCallType(value);
      document.querySelectorAll(`input[name="${ids.callType}"]`).forEach((input) => {
        input.checked = input.value === normalized;
        input.closest('.saas-campaign-card')?.classList.toggle('selected', input.checked);
      });
    }

    function getSelectedCallType() {
      return document.querySelector(`input[name="${ids.callType}"]:checked`)?.value || 'REVIEW_CALL';
    }

    function allFieldIds() {
      return [ids.name, ids.phone, ids.date, ids.time, ids.callType, ids.dob, ids.lastVisit, ids.treatment, ids.notes];
    }

    function clearErrors() {
      clearFieldErrors(allFieldIds());
    }

    function todayDateValue() {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    function parseScheduledDateTime(dateValue, timeValue) {
      if (!dateValue || !timeValue) return null;
      const parsed = new Date(`${dateValue}T${timeValue}:00`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    function splitScheduledDateTime(customer = {}) {
      const status = String(customer.status || '').toLowerCase();
      const scheduledValue = ['retry_scheduled', 'callback_scheduled'].includes(status)
        ? (customer.next_retry_at || customer.scheduled_datetime || '')
        : (customer.scheduled_datetime || customer.next_retry_at || '');
      const parsed = scheduledValue ? new Date(scheduledValue) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) {
        return {
          date: `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`,
          time: `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
        };
      }

      return {
        date: todayDateValue(),
        time: customer.preferred_slot || ''
      };
    }

    function getPayload() {
      const scheduledDate = getEl('date').value;
      const scheduledTime = getEl('time').value.trim();
      const scheduledDateTime = parseScheduledDateTime(scheduledDate, scheduledTime);
      return {
        name: getEl('name').value.trim(),
        phone: normalizePhoneForApi(getEl('phone').value),
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        preferred_slot: scheduledTime,
        scheduled_datetime: scheduledDateTime ? scheduledDateTime.toISOString() : '',
        callType: getSelectedCallType()
      };
    }

    function getCarePayload(customerPayload) {
      return {
        name: customerPayload.name,
        phone: customerPayload.phone,
        date_of_birth: getEl('dob').value || '',
        last_visit_date: getEl('lastVisit').value || '',
        treatment_type: getEl('treatment').value.trim(),
        annual_reminder_enabled: 1,
        annual_reminder_slot: customerPayload.preferred_slot || '10:00',
        notes: getEl('notes').value.trim(),
        status: 'active'
      };
    }

    function validate(payload, carePayload) {
      const fieldErrors = {};
      if (!payload.name || payload.name.length < 2) fieldErrors[ids.name] = 'Patient name is required';
      if (!/^\+\d{12}$/.test(payload.phone)) fieldErrors[ids.phone] = 'Use a valid Indian mobile number';
      if (!payload.scheduled_date) fieldErrors[ids.date] = 'Call date is required';
      if (!payload.preferred_slot) fieldErrors[ids.time] = 'Call time is required';
      const scheduled = parseScheduledDateTime(payload.scheduled_date, payload.preferred_slot);
      if (payload.scheduled_date && payload.preferred_slot && (!scheduled || scheduled.getTime() <= Date.now())) {
        if (payload.scheduled_date === todayDateValue()) {
          fieldErrors[ids.time] = 'Choose a future time for today';
        } else {
          fieldErrors[ids.date] = 'Choose today or a future date';
        }
      }

      const hasCareDetails = carePayload.date_of_birth || carePayload.last_visit_date || carePayload.treatment_type;
      if (hasCareDetails) {
        if (!carePayload.last_visit_date) fieldErrors[ids.lastVisit] = 'Last visit is required when adding care details';
        if (!carePayload.treatment_type) fieldErrors[ids.treatment] = 'Treatment type is required when adding care details';
      }
      return fieldErrors;
    }

    function setSubmitting(isSubmitting) {
      const submit = getEl('submit');
      const cancel = getEl('cancel');
      const close = getEl('close');
      submit.disabled = isSubmitting;
      cancel.disabled = isSubmitting;
      close.disabled = isSubmitting;
      submit.textContent = isSubmitting ? 'Scheduling...' : (getEl('editingId').value ? 'Save Changes' : 'Schedule Call');
    }

    function reset() {
      getEl('editingId').value = '';
      getEl('panelTitle').textContent = 'Schedule New Follow-up Call';
      getEl('submit').textContent = 'Schedule Call';
      getEl('name').value = '';
      getEl('phone').value = '';
      getEl('date').value = todayDateValue();
      getEl('date').min = todayDateValue();
      getEl('time').value = '';
      getEl('dob').value = '';
      getEl('lastVisit').value = '';
      getEl('treatment').value = '';
      getEl('notes').value = '';
      getEl('careToggle').open = false;
      setCallTypeSelection('REVIEW_CALL');
      clearErrors();
      setSubmitting(false);
    }

    async function saveClientRecord(payload) {
      await ensureClientsLoaded();
      const existingClient = getClientByPhone(payload.phone);
      const endpoint = existingClient ? `${API_BASE}/clients/${existingClient.id}` : `${API_BASE}/clients`;
      const method = existingClient ? 'PUT' : 'POST';
      await fetchJson(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      clientCache = [];
    }

    async function submit() {
      clearErrors();
      const payload = getPayload();
      const carePayload = getCarePayload(payload);
      const fieldErrors = validate(payload, carePayload);

      if (Object.keys(fieldErrors).length) {
        applyFieldErrors(fieldErrors);
        showAlert('Please fix the highlighted fields', 'error');
        return;
      }

      const customerId = getEl('editingId').value;
      const endpoint = customerId ? `${API_BASE}/customers/${customerId}` : `${API_BASE}/customers`;
      const method = customerId ? 'PUT' : 'POST';

      try {
        setSubmitting(true);
        await fetchJson(endpoint, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (carePayload.last_visit_date || carePayload.treatment_type || carePayload.date_of_birth) {
          await saveClientRecord(carePayload);
        }

        showAlert(customerId ? 'Call updated successfully' : 'Call scheduled successfully');
        close();
        if (typeof options.onSaved === 'function') {
          await options.onSaved();
        }
      } catch (error) {
        if (error.fieldErrors) {
          applyFieldErrors(error.fieldErrors, {
            phone: ids.phone,
            name: ids.name,
            preferred_slot: ids.time,
            scheduled_date: ids.date,
            scheduled_datetime: ids.date,
            call_type: ids.callType
          });
        }
        showAlert(error.message, 'error');
      } finally {
        setSubmitting(false);
      }
    }

    async function open(customerId = null) {
      reset();
      if (customerId && typeof options.getCustomer === 'function') {
        const customer = options.getCustomer(customerId);
        if (customer) {
          getEl('editingId').value = customer.id;
          getEl('panelTitle').textContent = 'Edit Scheduled Call';
          getEl('submit').textContent = 'Save Changes';
          getEl('name').value = customer.name || '';
          getEl('phone').value = formatPhoneForInput(customer.phone || '');
          const scheduledParts = splitScheduledDateTime(customer);
          getEl('date').value = scheduledParts.date;
          getEl('time').value = scheduledParts.time;
          setCallTypeSelection(customer.call_type || 'REVIEW_CALL');

          await ensureClientsLoaded();
          const client = getClientByPhone(customer.phone);
          if (client) {
            getEl('careToggle').open = true;
            getEl('dob').value = client.date_of_birth || '';
            getEl('lastVisit').value = client.last_visit_date || '';
            getEl('treatment').value = client.treatment_type || '';
          }
        }
      }

      getEl('backdrop').classList.add('open');
      getEl('backdrop').setAttribute('aria-hidden', 'false');
      window.requestAnimationFrame(() => getEl('name').focus());
    }

    function close() {
      getEl('backdrop').classList.remove('open');
      getEl('backdrop').setAttribute('aria-hidden', 'true');
    }

    getEl('close').addEventListener('click', close);
    getEl('cancel').addEventListener('click', close);
    getEl('submit').addEventListener('click', submit);
    getEl('phone').addEventListener('input', (event) => {
      event.target.value = formatPhoneForInput(event.target.value);
    });
    getEl('backdrop').addEventListener('click', (event) => {
      if (event.target.id === ids.backdrop) close();
    });
    document.querySelectorAll(`input[name="${ids.callType}"]`).forEach((input) => {
      input.addEventListener('change', () => setCallTypeSelection(input.value));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && getEl('backdrop').classList.contains('open')) {
        close();
      }
    });

    return { open, close };
  }

  function initializeShellChrome() {
    buildMobileTabbar();
    if (!SHOW_TEST_AI_CALL_WIDGET) {
      document.querySelector('[data-test-ai-call-widget]')?.remove();
      window.__testCallWidgetInstance = null;
      return;
    }

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
    applyFieldErrors,
    clearFieldErrors,
    ensureAuthenticatedSession,
    escapeHtml,
    fetchJson,
    formatPhoneForInput,
    formatCurrencyInr,
    formatDate,
    formatDateTime,
    formatStatusLabel,
    initializeShellChrome,
    logoutAdmin,
    NewCallModal: createNewCallModal,
    normalizePhoneForApi,
    redirectToLogin,
    showAlert
  };
})();
