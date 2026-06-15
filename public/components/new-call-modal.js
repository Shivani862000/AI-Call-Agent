(function() {
  let callbacks = {};

  function normalizePhoneForApi(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    if (digits.length > 12) return `+${digits.slice(-12)}`;
    return `+${digits}`;
  }

  function isMobileModalLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function formatPhoneForInput(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('91') && digits.length === 12) {
      digits = digits.slice(2);
    }
    return digits;
  }

  function getSelectedCallType() {
    const active = document.querySelector('.saas-campaign-card.selected');
    return active ? active.dataset.value : 'REVIEW_CALL';
  }

  function setCallTypeSelection(value) {
    document.querySelectorAll('.saas-campaign-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.value === value);
    });
    const hidden = document.getElementById('hiddenCallType');
    if (hidden) hidden.value = value;
    
    const reviewCtx = document.getElementById('reviewCallContext');
    const followupCtx = document.getElementById('followUpContext');
    if (value === 'REVIEW_CALL') {
      if (reviewCtx) reviewCtx.style.display = 'block';
      if (followupCtx) followupCtx.style.display = 'none';
    } else {
      if (reviewCtx) reviewCtx.style.display = 'none';
      if (followupCtx) followupCtx.style.display = 'block';
    }
    updateAiPreview();
  }

  function updateAiPreview() {
    const type = getSelectedCallType();
    const nameInput = document.getElementById('callCustomerName');
    const name = nameInput?.value?.trim() || '...';
    const preview = document.getElementById('aiPreviewText');
    if (!preview) return;

    if (type === 'REVIEW_CALL') {
      preview.innerHTML = `Good Morning.<br>Main Apna Blood Centre se baat kar rahi hoon.<br>Kya main <strong>${AppShell.escapeHtml(name)}</strong> ji se baat kar rahi hoon?`;
    } else {
      preview.innerHTML = `Namaste.<br>Apna Blood Centre se bol rahi hoon.<br>Kya main <strong>${AppShell.escapeHtml(name)}</strong> ji se baat kar rahi hoon? Aapka next visit due hai.`;
    }
  }

  function clearFormErrors() {
    const fields = ['callCustomerName', 'callCustomerPhone', 'callCustomerTime', 'careDob', 'careLastVisit', 'careTreatment'];
    AppShell.clearFieldErrors(fields);
  }

  function validateNewCallForm() {
    const name = document.getElementById('callCustomerName')?.value.trim();
    const phone = document.getElementById('callCustomerPhone')?.value.trim();
    const time = document.getElementById('callCustomerTime')?.value.trim();
    const isValid = name && phone && time;
    const submitBtn = document.getElementById('scheduleCallSubmit');
    if (submitBtn) submitBtn.disabled = !isValid;
  }

  function getNewCallPayload() {
    const toggle = document.getElementById('videoSentToggle');
    const videoSent = toggle ? toggle.checked : false;
    
    return {
      name: document.getElementById('callCustomerName')?.value.trim() || '',
      phone: normalizePhoneForApi(document.getElementById('callCustomerPhone')?.value || ''),
      preferred_slot: document.getElementById('callCustomerTime')?.value.trim() || '',
      callType: getSelectedCallType(),
      video_sent: videoSent,
      last_visit_date: document.getElementById('careLastVisit')?.value || ''
    };
  }

  function getCarePayload(customerPayload) {
    if (isMobileModalLayout()) {
      return {
        name: customerPayload.name,
        phone: customerPayload.phone,
        date_of_birth: '',
        last_visit_date: '',
        treatment_type: '',
        annual_reminder_enabled: 1,
        annual_reminder_slot: customerPayload.preferred_slot || '10:00',
        notes: '',
        status: 'active'
      };
    }

    return {
      name: customerPayload.name,
      phone: customerPayload.phone,
      date_of_birth: document.getElementById('careDob')?.value || '',
      last_visit_date: document.getElementById('careLastVisit')?.value || '',
      treatment_type: document.getElementById('careTreatment')?.value.trim() || '',
      annual_reminder_enabled: 1,
      annual_reminder_slot: customerPayload.preferred_slot || '10:00',
      notes: document.getElementById('customNotes')?.value.trim() || '',
      status: 'active'
    };
  }

  function validateNewCall(payload) {
    const fieldErrors = {};
    if (!payload.name || payload.name.length < 2) fieldErrors.callCustomerName = 'Patient name is required';
    if (!/^\+\d{12}$/.test(payload.phone)) fieldErrors.callCustomerPhone = 'Use a valid Indian mobile number';
    if (!payload.preferred_slot) fieldErrors.callCustomerTime = 'Call time is required';
    return fieldErrors;
  }

  function validateCareDetails(payload) {
    if (isMobileModalLayout()) return {};

    const hasAny = payload.date_of_birth || payload.last_visit_date || payload.treatment_type;
    if (!hasAny) return {};
    const fieldErrors = {};
    if (!payload.last_visit_date) fieldErrors.careLastVisit = 'Last visit is required when adding care details';
    if (!payload.treatment_type) fieldErrors.careTreatment = 'Treatment type is required when adding care details';
    return fieldErrors;
  }

  async function saveClientRecord(payload) {
    const endpoint = callbacks.getClientIdByPhone 
      ? (() => {
          const id = callbacks.getClientIdByPhone(payload.phone);
          return id ? `${AppShell.API_BASE}/clients/${id}` : `${AppShell.API_BASE}/clients`;
        })()
      : `${AppShell.API_BASE}/clients`;
      
    const method = endpoint.includes('/clients/') ? 'PUT' : 'POST';
    await AppShell.fetchJson(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function submitNewCall() {
    clearFormErrors();
    const payload = getNewCallPayload();
    const carePayload = getCarePayload(payload);
    const fieldErrors = {
      ...validateNewCall(payload),
      ...validateCareDetails(carePayload)
    };

    if (Object.keys(fieldErrors).length) {
      AppShell.applyFieldErrors(fieldErrors);
      AppShell.showAlert('Please fix the highlighted fields', 'error');
      return;
    }

    const customerId = document.getElementById('editingCustomerId')?.value;
    const endpoint = customerId ? `${AppShell.API_BASE}/customers/${customerId}` : `${AppShell.API_BASE}/customers`;
    const method = customerId ? 'PUT' : 'POST';

    const submitBtn = document.getElementById('scheduleCallSubmit');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
    }

    try {
      await AppShell.fetchJson(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (carePayload.last_visit_date || carePayload.treatment_type || carePayload.date_of_birth) {
        await saveClientRecord(carePayload);
      }

      AppShell.showAlert(customerId ? 'Call updated successfully' : 'Call scheduled successfully');
      window.SharedCallModal.close();
      if (callbacks.onSuccess) {
        await callbacks.onSuccess();
      }
    } catch (error) {
      if (error.fieldErrors) {
        AppShell.applyFieldErrors(error.fieldErrors, {
          phone: 'callCustomerPhone',
          name: 'callCustomerName',
          preferred_slot: 'callCustomerTime'
        });
      }
      AppShell.showAlert(error.message, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Schedule Call';
      }
    }
  }

  function resetNewCallForm(mode = 'call') {
    const editingInput = document.getElementById('editingCustomerId');
    if (editingInput) editingInput.value = '';
    
    const title = document.getElementById('newCallModalTitle');
    if (title) title.textContent = mode === 'customer' ? 'Add Customer' : 'Schedule New Follow-up Call';
    
    const submit = document.getElementById('scheduleCallSubmit');
    if (submit) submit.textContent = mode === 'customer' ? 'Add Customer' : 'Schedule Call';
    
    ['callCustomerName', 'callCustomerPhone', 'callCustomerTime', 'callCustomerDate', 'careDob', 'careLastVisit', 'careTreatment', 'customNotes'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    
    const videoToggle = document.getElementById('videoSentToggle');
    if (videoToggle) videoToggle.checked = false;
    
    const accordion = document.querySelector('.saas-accordion');
    if (accordion) accordion.open = false;
    
    setCallTypeSelection('REVIEW_CALL');
    clearFormErrors();
    updateAiPreview();
    validateNewCallForm();
  }

  window.SharedCallModal = {
    open: function(customer = null, client = null, cb = {}) {
      callbacks = cb;
      resetNewCallForm('call');
      
      if (customer) {
        document.getElementById('editingCustomerId').value = customer.id;
        document.getElementById('newCallModalTitle').textContent = 'Edit Scheduled Call';
        document.getElementById('scheduleCallSubmit').textContent = 'Save Changes';
        document.getElementById('callCustomerName').value = customer.name || '';
        document.getElementById('callCustomerPhone').value = formatPhoneForInput(customer.phone || '');
        document.getElementById('callCustomerTime').value = customer.preferred_slot || '';
        setCallTypeSelection(customer.call_type || 'REVIEW_CALL');
      }
      if (client) {
        const acc = document.querySelector('.saas-accordion');
        if (acc) acc.open = !isMobileModalLayout();
        document.getElementById('careDob').value = client.date_of_birth || '';
        document.getElementById('careLastVisit').value = client.last_visit_date || '';
        document.getElementById('careTreatment').value = client.treatment_type || '';
      }
      
      const modal = document.getElementById('newCallModal');
      if (modal) {
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
      }
      updateAiPreview();
      validateNewCallForm();
    },
    close: function() {
      const modal = document.getElementById('newCallModal');
      if (modal) {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
      }
    },
    init: function() {
      // Event listeners
      document.getElementById('closeNewCallModal')?.addEventListener('click', () => this.close());
      document.getElementById('cancelNewCallModal')?.addEventListener('click', () => this.close());
      document.getElementById('scheduleCallSubmit')?.addEventListener('click', submitNewCall);
      
      document.querySelectorAll('.saas-campaign-card').forEach(card => {
        card.addEventListener('click', () => {
          setCallTypeSelection(card.dataset.value);
        });
      });
      
      ['callCustomerName', 'callCustomerPhone', 'callCustomerTime'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => {
          updateAiPreview();
          validateNewCallForm();
        });
      });
    }
  };
})();
