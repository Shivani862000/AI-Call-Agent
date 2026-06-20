(function() {
  let callbacks = {};
  let searchTimeout = null;
  let currentSearchResults = [];

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

  function syncMobileOptionalSections() {
    const isMobile = isMobileModalLayout();
    document.querySelectorAll('#newCallModal .additional-care-details, #newCallModal .optional-notes-section, #newCallModal .saas-mobile-hidden').forEach(section => {
      section.hidden = isMobile;
      section.setAttribute('aria-hidden', String(isMobile));
      if (isMobile && section.tagName === 'DETAILS') {
        section.open = false;
      }
    });
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
      if (el) {
        el.value = '';
        el.disabled = false;
      }
    });
    
    const dropdown = document.getElementById('customerAutocompleteDropdown');
    if (dropdown) dropdown.style.display = 'none';
    
    const videoToggle = document.getElementById('videoSentToggle');
    if (videoToggle) videoToggle.checked = false;
    
    const accordion = document.querySelector('.saas-accordion');
    if (accordion) accordion.open = false;
    
    setCallTypeSelection('REVIEW_CALL');
    syncMobileOptionalSections();
    clearFormErrors();
    updateAiPreview();
    validateNewCallForm();
  }

  async function handleCustomerSearch(e) {
    const query = e.target.value; // don't trim right away so spaces can be typed
    const trimmed = query.trim();
    const dropdown = document.getElementById('customerAutocompleteDropdown');
    const phoneInput = document.getElementById('callCustomerPhone');
    const editingInput = document.getElementById('editingCustomerId');
    
    if (editingInput && editingInput.value) {
      editingInput.value = '';
      if (phoneInput) {
        phoneInput.disabled = false;
        phoneInput.value = '';
      }
    }

    if (trimmed.length < 2) {
      if (dropdown) dropdown.style.display = 'none';
      return;
    }

    if (dropdown) {
      dropdown.style.display = 'block';
      dropdown.innerHTML = '<div class="autocomplete-loading">Searching...</div>';
    }

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      try {
        const response = await AppShell.fetchJson(`${AppShell.API_BASE}/customers/search?q=${encodeURIComponent(trimmed)}`);
        renderCustomerDropdown(response || [], query);
      } catch (err) {
        console.error('Customer search error:', err);
        if (dropdown) dropdown.innerHTML = '<div class="autocomplete-loading">Error searching patients.</div>';
      }
    }, 300);
  }

  function renderCustomerDropdown(customers, query) {
    const dropdown = document.getElementById('customerAutocompleteDropdown');
    if (!dropdown) return;
    
    dropdown.innerHTML = '';
    
    if (!customers || customers.length === 0) {
      dropdown.innerHTML = `
        <div class="autocomplete-empty">No matching patients found.</div>
        <div class="autocomplete-create-new" id="autoCreateNewBtn">
          + Create New Patient
        </div>
      `;
      const btn = dropdown.querySelector('#autoCreateNewBtn');
      if (btn) btn.addEventListener('click', () => window.SharedCallModal.createNewPatient(query));
      return;
    }

    currentSearchResults = customers;
    customers.forEach(customer => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.innerHTML = `
        <div class="autocomplete-item-title">${AppShell.escapeHtml(customer.name)}</div>
        <div class="autocomplete-item-subtitle">${AppShell.escapeHtml(customer.phone)}</div>
      `;
      item.addEventListener('click', () => selectCustomerFromDropdown(customer));
      dropdown.appendChild(item);
    });

    const createNewBtn = document.createElement('div');
    createNewBtn.className = 'autocomplete-create-new';
    createNewBtn.innerHTML = '+ Create New Patient';
    createNewBtn.addEventListener('click', () => window.SharedCallModal.createNewPatient(query));
    dropdown.appendChild(createNewBtn);
  }

  function selectCustomerFromDropdown(customer) {
    const nameInput = document.getElementById('callCustomerName');
    const phoneInput = document.getElementById('callCustomerPhone');
    const editingInput = document.getElementById('editingCustomerId');
    const dropdown = document.getElementById('customerAutocompleteDropdown');

    if (nameInput) nameInput.value = customer.name;
    if (phoneInput) {
      phoneInput.value = formatPhoneForInput(customer.phone);
      phoneInput.disabled = true;
    }
    if (editingInput) editingInput.value = customer.id;
    if (dropdown) dropdown.style.display = 'none';

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
        syncMobileOptionalSections();
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
    createNewPatient: function(name) {
      const nameInput = document.getElementById('callCustomerName');
      const phoneInput = document.getElementById('callCustomerPhone');
      const editingInput = document.getElementById('editingCustomerId');
      const dropdown = document.getElementById('customerAutocompleteDropdown');

      if (nameInput) nameInput.value = name || '';
      if (phoneInput) {
        phoneInput.disabled = false;
        phoneInput.focus();
      }
      if (editingInput) editingInput.value = '';
      if (dropdown) dropdown.style.display = 'none';
      
      updateAiPreview();
      validateNewCallForm();
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
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('input', () => {
            updateAiPreview();
            validateNewCallForm();
          });
          if (id === 'callCustomerName') {
            el.addEventListener('input', handleCustomerSearch);
          }
        }
      });
      
      document.addEventListener('click', (e) => {
        const wrapper = document.querySelector('.autocomplete-wrapper');
        const dropdown = document.getElementById('customerAutocompleteDropdown');
        if (wrapper && dropdown && !wrapper.contains(e.target)) {
          dropdown.style.display = 'none';
        }
      });

      syncMobileOptionalSections();
      window.addEventListener('resize', syncMobileOptionalSections);
    }
  };
})();
