(function () {
  'use strict';

  const API_PATH = '/api/users';
  const ROLE_LABELS = { CLIENT_ADMIN: 'Tenant admin', CLIENT_AGENT: 'Agent' };
  const state = {
    session: null,
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
    filters: { search: '', role: '', status: '' },
    editing: null,
    passwordTarget: null,
    pendingAction: null
  };

  const byId = id => document.getElementById(id);
  const escape = value => window.AppShell.escapeHtml(value == null ? '' : String(value));

  function roleLabel(role) {
    return ROLE_LABELS[role] || 'User';
  }

  function statusLabel(status) {
    return String(status || '').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function formatUpdated(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function isSelf(item) {
    return Boolean(item && state.session && item.username === state.session.username);
  }

  function openModal(id, focusId) {
    const modal = byId(id);
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => byId(focusId)?.focus(), 0);
  }

  function closeModal(id) {
    const modal = byId(id);
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.modal-backdrop.open')) document.body.style.overflow = '';
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = busyLabel;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalLabel || button.textContent;
      button.disabled = false;
    }
  }

  function clearFormErrors(form) {
    form?.querySelectorAll('.input-invalid').forEach(input => input.classList.remove('input-invalid'));
    form?.querySelectorAll('.error-text, .form-error').forEach(node => { node.textContent = ''; });
  }

  function applyFormErrors(fieldErrors, map, fallbackId) {
    let applied = false;
    Object.entries(fieldErrors || {}).forEach(([field, message]) => {
      const inputId = map[field];
      const input = inputId ? byId(inputId) : null;
      const errorNode = inputId ? byId(`${inputId}Error`) : null;
      if (input && errorNode) {
        input.classList.add('input-invalid');
        errorNode.textContent = message;
        applied = true;
      }
    });
    if (!applied && fallbackId) byId(fallbackId).textContent = 'Please review the entered values.';
  }

  function actionButton(label, action, item, tone = 'secondary') {
    return `<button type="button" class="${tone} user-action-button" data-user-action="${action}" data-user-id="${escape(item.id)}">${escape(label)}</button>`;
  }

  function actionMarkup(item) {
    const ownAccount = isSelf(item);
    const actions = [actionButton('Edit', 'edit', item)];
    if (!ownAccount && item.status !== 'archived') actions.push(actionButton('Set password', 'password', item));
    if (!ownAccount && item.status === 'active') {
      actions.push(actionButton('Suspend', 'suspend', item));
      actions.push(actionButton('Archive', 'archive', item, 'danger'));
    }
    if (!ownAccount && item.status === 'suspended') {
      actions.push(actionButton('Reactivate', 'restore', item, 'primary'));
      actions.push(actionButton('Archive', 'archive', item, 'danger'));
    }
    if (!ownAccount && item.status === 'archived') actions.push(actionButton('Restore', 'restore', item, 'primary'));
    return `<div class="user-row-actions">${actions.join('')}</div>`;
  }

  function accountMarkup(item) {
    return `<div class="user-account-name">${escape(item.username)}${isSelf(item) ? ' <span class="user-self-note">(you)</span>' : ''}</div><div class="user-account-email">${escape(item.email)}</div>`;
  }

  function renderUsers() {
    const loading = byId('userLoading');
    const results = byId('userResults');
    const empty = byId('userEmpty');
    loading.hidden = true;
    results.hidden = state.items.length === 0;
    empty.hidden = state.items.length !== 0;
    byId('totalUserCount').textContent = String(state.total);
    byId('visibleUserCount').textContent = String(state.items.length);

    byId('userTableBody').innerHTML = state.items.map(item => `
      <tr>
        <td>${accountMarkup(item)}</td>
        <td><span class="user-badge ${item.role === 'CLIENT_ADMIN' ? 'user-badge--admin' : 'user-badge--agent'}">${escape(roleLabel(item.role))}</span></td>
        <td><span class="user-badge user-badge--${escape(item.status)}">${escape(statusLabel(item.status))}</span></td>
        <td><span class="user-updated-at">${escape(formatUpdated(item.updatedAt))}</span></td>
        <td>${actionMarkup(item)}</td>
      </tr>`).join('');

    byId('userCardList').innerHTML = state.items.map(item => `
      <article class="user-card">
        <div class="user-card-top"><div>${accountMarkup(item)}</div><span class="user-badge user-badge--${escape(item.status)}">${escape(statusLabel(item.status))}</span></div>
        <div class="user-card-meta"><span class="user-badge ${item.role === 'CLIENT_ADMIN' ? 'user-badge--admin' : 'user-badge--agent'}">${escape(roleLabel(item.role))}</span><span class="user-updated-at">Updated ${escape(formatUpdated(item.updatedAt))}</span></div>
        ${actionMarkup(item)}
      </article>`).join('');

    const previousDisabled = state.page <= 1 ? 'disabled' : '';
    const nextDisabled = state.page >= state.totalPages ? 'disabled' : '';
    byId('userPagination').innerHTML = state.total > 0 ? `
      <span>Page ${escape(state.page)} of ${escape(Math.max(1, state.totalPages))} · ${escape(state.total)} accounts</span>
      <div class="user-pagination-actions">
        <button class="secondary" type="button" data-user-page="${state.page - 1}" ${previousDisabled}>Previous</button>
        <button class="secondary" type="button" data-user-page="${state.page + 1}" ${nextDisabled}>Next</button>
      </div>` : '';
  }

  async function loadUsers() {
    byId('userLoading').hidden = false;
    byId('userResults').hidden = true;
    byId('userEmpty').hidden = true;
    const query = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
    Object.entries(state.filters).forEach(([key, value]) => { if (value) query.set(key, value); });
    try {
      const data = await window.AppShell.fetchJson(`${API_PATH}?${query}`);
      state.items = data.items || [];
      state.page = data.page || 1;
      state.total = data.total || 0;
      state.totalPages = Math.max(1, data.totalPages || 1);
      renderUsers();
    } catch (error) {
      byId('userLoading').hidden = true;
      byId('userEmpty').hidden = false;
      byId('userEmpty').textContent = error.message || 'Users could not be loaded.';
    }
  }

  function openCreateForm() {
    state.editing = null;
    const form = byId('userForm');
    form.reset();
    clearFormErrors(form);
    byId('userEditingId').value = '';
    byId('userEditingVersion').value = '';
    byId('userFormTitle').textContent = 'Add user';
    byId('userFormSubtitle').textContent = 'Create an administrator or agent account in this tenant.';
    byId('userCreatePasswordField').hidden = false;
    byId('userCreatePassword').required = true;
    byId('userRole').disabled = false;
    byId('saveUserButton').textContent = 'Create user';
    openModal('userFormModal', 'userUsername');
  }

  function openEditForm(item) {
    state.editing = item;
    const form = byId('userForm');
    form.reset();
    clearFormErrors(form);
    byId('userEditingId').value = item.id;
    byId('userEditingVersion').value = String(item.version);
    byId('userUsername').value = item.username;
    byId('userEmail').value = item.email;
    byId('userRole').value = item.role;
    byId('userRole').disabled = isSelf(item);
    byId('userCreatePasswordField').hidden = true;
    byId('userCreatePassword').required = false;
    byId('userCreatePassword').value = '';
    byId('userFormTitle').textContent = 'Edit user';
    byId('userFormSubtitle').textContent = isSelf(item) ? 'You can edit your identity, but not your own role.' : 'Update this account identity or tenant role.';
    byId('saveUserButton').textContent = 'Save changes';
    openModal('userFormModal', 'userUsername');
  }

  async function submitUserForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    clearFormErrors(form);
    const button = byId('saveUserButton');
    const input = {
      username: byId('userUsername').value.trim(),
      email: byId('userEmail').value.trim(),
      role: state.editing && isSelf(state.editing) ? state.editing.role : byId('userRole').value
    };
    if (!state.editing) input.password = byId('userCreatePassword').value;
    setBusy(button, true, state.editing ? 'Saving…' : 'Creating…');
    try {
      if (state.editing) {
        await window.AppShell.fetchJson(`${API_PATH}/${encodeURIComponent(state.editing.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patch: input, expectedVersion: state.editing.version })
        });
      } else {
        await window.AppShell.fetchJson(API_PATH, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
        });
      }
      closeModal('userFormModal');
      window.AppShell.showAlert(state.editing ? 'User updated.' : 'User created.');
      await loadUsers();
    } catch (error) {
      applyFormErrors(error.fieldErrors, {
        username: 'userUsername', email: 'userEmail', role: 'userRole', password: 'userCreatePassword'
      }, 'userFormError');
      byId('userFormError').textContent ||= error.message || 'The user could not be saved.';
    } finally {
      setBusy(button, false);
    }
  }

  function openPasswordForm(item) {
    if (isSelf(item)) return;
    state.passwordTarget = item;
    const form = byId('userPasswordForm');
    form.reset();
    clearFormErrors(form);
    byId('userPasswordSubtitle').textContent = `Set a replacement temporary password for ${item.username}.`;
    openModal('userPasswordModal', 'userPassword');
  }

  async function submitPasswordForm(event) {
    event.preventDefault();
    clearFormErrors(event.currentTarget);
    if (!state.passwordTarget) return;
    const button = byId('savePasswordButton');
    setBusy(button, true, 'Updating…');
    try {
      await window.AppShell.fetchJson(`${API_PATH}/${encodeURIComponent(state.passwordTarget.id)}/password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: byId('userPassword').value, expectedVersion: state.passwordTarget.version })
      });
      byId('userPassword').value = '';
      closeModal('userPasswordModal');
      window.AppShell.showAlert('Temporary password updated.');
      await loadUsers();
    } catch (error) {
      applyFormErrors(error.fieldErrors, { password: 'userPassword' }, 'userPasswordFormError');
      byId('userPasswordFormError').textContent ||= error.message || 'The password could not be updated.';
    } finally {
      setBusy(button, false);
    }
  }

  function openLifecycleConfirmation(item, transition) {
    if (isSelf(item)) return;
    state.pendingAction = { item, transition };
    const labels = { suspend: 'Suspend', archive: 'Archive', restore: item.status === 'archived' ? 'Restore' : 'Reactivate' };
    const descriptions = {
      suspend: `Suspend ${item.username}? They will lose access until reactivated.`,
      archive: `Archive ${item.username}? Their account will be retained and can be restored later.`,
      restore: `${labels.restore} ${item.username} and allow them to sign in again?`
    };
    byId('userLifecycleTitle').textContent = `${labels[transition]} user`;
    byId('userLifecycleMessage').textContent = descriptions[transition];
    byId('userLifecycleReason').value = '';
    byId('userLifecycleError').textContent = '';
    const button = byId('confirmLifecycleButton');
    button.textContent = labels[transition];
    button.className = transition === 'restore' ? 'primary' : 'danger';
    openModal('userLifecycleModal', 'confirmLifecycleButton');
  }

  async function confirmLifecycle() {
    if (!state.pendingAction) return;
    const { item, transition } = state.pendingAction;
    const button = byId('confirmLifecycleButton');
    byId('userLifecycleError').textContent = '';
    setBusy(button, true, 'Updating…');
    try {
      await window.AppShell.fetchJson(`${API_PATH}/${encodeURIComponent(item.id)}/lifecycle`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition, expectedVersion: item.version, reason: byId('userLifecycleReason').value.trim() })
      });
      closeModal('userLifecycleModal');
      window.AppShell.showAlert('Account access updated.');
      if (state.items.length === 1 && state.page > 1) state.page -= 1;
      await loadUsers();
    } catch (error) {
      byId('userLifecycleError').textContent = error.message || 'Account access could not be updated.';
    } finally {
      setBusy(button, false);
    }
  }

  function itemForAction(target) {
    return state.items.find(item => item.id === target.dataset.userId);
  }

  function bindEvents() {
    byId('addUserButton').addEventListener('click', openCreateForm);
    byId('usersLogoutButton').addEventListener('click', event => window.AppShell.logoutAdmin(event.currentTarget));
    byId('userForm').addEventListener('submit', submitUserForm);
    byId('userPasswordForm').addEventListener('submit', submitPasswordForm);
    byId('confirmLifecycleButton').addEventListener('click', confirmLifecycle);
    byId('userFilters').addEventListener('submit', event => {
      event.preventDefault();
      state.filters = {
        search: byId('userSearch').value.trim(),
        role: byId('userRoleFilter').value,
        status: byId('userStatusFilter').value
      };
      state.page = 1;
      loadUsers();
    });
    byId('userResults').addEventListener('click', event => {
      const target = event.target.closest('[data-user-action]');
      if (!target) return;
      const item = itemForAction(target);
      if (!item) return;
      const action = target.dataset.userAction;
      if (action === 'edit') openEditForm(item);
      else if (action === 'password') openPasswordForm(item);
      else openLifecycleConfirmation(item, action);
    });
    byId('userPagination').addEventListener('click', event => {
      const button = event.target.closest('[data-user-page]');
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.userPage) || 1;
      loadUsers();
    });
    document.querySelectorAll('[data-close-modal]').forEach(button => {
      button.addEventListener('click', () => closeModal(button.dataset.closeModal));
    });
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', event => { if (event.target === modal) closeModal(modal.id); });
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop.open').forEach(modal => closeModal(modal.id));
    });
  }

  async function initialize() {
    try {
      const session = await window.AppShell.ensureAuthenticatedSession();
      if (session.role !== 'CLIENT_ADMIN') {
        window.location.replace('/admin.html');
        return;
      }
      state.session = session;
      bindEvents();
      await loadUsers();
    } catch (_error) {
      // AppShell handles authentication redirects.
    }
  }

  document.addEventListener('DOMContentLoaded', initialize);
})();
