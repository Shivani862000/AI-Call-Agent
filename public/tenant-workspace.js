(function (window) {
  'use strict';

  const NAV_ITEMS = [
    { path: '/admin.html', label: 'Overview', roles: ['CLIENT_AGENT', 'CLIENT_ADMIN'] },
    { path: '/customer-list.html', label: 'Customer List', roles: ['CLIENT_AGENT', 'CLIENT_ADMIN'] },
    { path: '/customers.html', label: 'Outbound Calls', roles: ['CLIENT_AGENT', 'CLIENT_ADMIN'] },
    { path: '/feedback.html', label: 'Feedback', roles: ['CLIENT_ADMIN'] },
    { path: '/support-tickets.html', label: 'Support Tickets', roles: ['CLIENT_ADMIN'], group: 'settings' },
    { path: '/users.html', label: 'Users', roles: ['CLIENT_ADMIN'], group: 'settings' }
  ];
  const TENANT_ROLES = new Set(['CLIENT_AGENT', 'CLIENT_ADMIN']);
  const ALL_ROUTE_PATHS = new Set(NAV_ITEMS.map(item => item.path));
  const document = window.document;
  let session = null;
  let currentTarget = null;
  let desktopNav = null;
  let desktopSettingsNav = null;
  let desktopSettings = null;
  let mobileNav = null;
  let frame = null;
  let status = null;
  let errorPanel = null;

  function canonicalTarget(target) {
    const url = new URL(target, window.location.origin);
    if (!ALL_ROUTE_PATHS.has(url.pathname)) throw new Error('Unknown tenant workspace route');
    return url;
  }

  function allowedRoutesForRole(role) {
    return NAV_ITEMS.filter(item => item.roles.includes(role)).map(item => item.path);
  }

  function routeToEmbeddedUrl(target) {
    const url = canonicalTarget(target);
    url.searchParams.delete('embedded');
    url.searchParams.set('embedded', '1');
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function currentCleanTarget() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function roleAllows(target) {
    if (!session) return false;
    return allowedRoutesForRole(session.role).includes(canonicalTarget(target).pathname);
  }

  function setStatus(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function setActiveNavigation() {
    if (!currentTarget) return;
    const activePath = canonicalTarget(currentTarget).pathname;
    document.querySelectorAll('[data-tenant-workspace-route]').forEach((link) => {
      const active = link.getAttribute('data-tenant-workspace-route') === activePath;
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function createNavigationLink(item) {
    const link = document.createElement('a');
    link.href = item.path;
    link.textContent = item.label;
    link.setAttribute('data-tenant-workspace-route', item.path);
    return link;
  }

  function renderNavigation() {
    const items = NAV_ITEMS.filter(item => item.roles.includes(session.role));
    const primaryItems = items.filter(item => item.group !== 'settings');
    const settingsItems = items.filter(item => item.group === 'settings');
    if (desktopNav) desktopNav.replaceChildren(...primaryItems.map(createNavigationLink));
    if (desktopSettingsNav) desktopSettingsNav.replaceChildren(...settingsItems.map(createNavigationLink));
    if (desktopSettings) desktopSettings.hidden = settingsItems.length === 0;
    if (mobileNav) mobileNav.replaceChildren(...items.map(createNavigationLink));
    if (mobileNav) mobileNav.style.setProperty('--nav-count', String(items.length));
    setActiveNavigation();
  }

  function shouldHandleFrameLink(link, event) {
    if (!link || !event || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (link.target || link.hasAttribute('download')) return false;
    const href = String(link.getAttribute ? link.getAttribute('href') : link.href || '');
    if (!href || href.startsWith('#')) return false;
    let url;
    try { url = new URL(href, window.location.origin); } catch (_error) { return false; }
    return url.origin === window.location.origin && ALL_ROUTE_PATHS.has(url.pathname);
  }

  function shellNavigationTarget(event) {
    const link = event?.target?.closest?.('[data-tenant-workspace-route]');
    if (!link || !link.hasAttribute('data-tenant-workspace-route')) return null;
    return shouldHandleFrameLink(link, event) ? link.getAttribute('href') : null;
  }

  function handleShellNavigationClick(event) {
    const target = shellNavigationTarget(event);
    if (!target) return;
    event.preventDefault();
    navigate(target, { history: 'push' });
  }

  function prepareFrame() {
    const frameDocument = frame?.contentDocument;
    if (!frameDocument?.body) throw new Error('Content view is unavailable');
    frameDocument.body.classList.add('embedded-tenant-view');
    frameDocument.addEventListener('click', (event) => {
      const link = event.target?.closest?.('a[href]');
      if (!shouldHandleFrameLink(link, event)) return;
      event.preventDefault();
      navigate(link.getAttribute('href'), { history: 'push' });
    });
    frame.hidden = false;
    if (status) status.hidden = true;
    const heading = frameDocument.querySelector('h1, h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      window.setTimeout(() => heading.focus(), 0);
    }
  }

  function showLoadFailure() {
    if (frame) frame.hidden = true;
    if (status) status.hidden = true;
    if (errorPanel) errorPanel.hidden = false;
  }

  function navigate(target, { history = 'push' } = {}) {
    const cleanUrl = canonicalTarget(target);
    if (!roleAllows(cleanUrl.href)) throw new Error('Tenant workspace route is not permitted');
    currentTarget = `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`;
    if (history === 'push') window.history.pushState({}, '', currentTarget);
    if (history === 'replace') window.history.replaceState({}, '', currentTarget);
    if (errorPanel) errorPanel.hidden = true;
    if (frame) frame.hidden = true;
    setStatus('Loading page…');
    setActiveNavigation();
    if (frame) frame.src = routeToEmbeddedUrl(currentTarget);
  }

  async function logout() {
    try { await window.fetch('/api/auth/logout', { method: 'POST' }); }
    finally { window.location.replace('/login.html'); }
  }

  async function boot() {
    desktopNav = document.getElementById('tenantWorkspaceDesktopNav');
    desktopSettingsNav = document.getElementById('tenantWorkspaceSettingsNav');
    desktopSettings = document.getElementById('tenantWorkspaceSettings');
    mobileNav = document.getElementById('tenantWorkspaceMobileNav');
    frame = document.getElementById('tenantContentFrame');
    status = document.getElementById('tenantWorkspaceStatus');
    errorPanel = document.getElementById('tenantWorkspaceError');
    document.getElementById('tenantWorkspaceLogout')?.addEventListener('click', logout);
    document.getElementById('tenantWorkspaceRetry')?.addEventListener('click', () => navigate(currentTarget || currentCleanTarget(), { history: 'replace' }));
    document.addEventListener('click', handleShellNavigationClick, true);
    frame?.addEventListener('load', () => { try { prepareFrame(); } catch (_error) { showLoadFailure(); } });
    frame?.addEventListener('error', showLoadFailure);

    try {
      const response = await window.fetch('/api/auth/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('Authentication required');
      session = await response.json();
      if (!session.authenticated || !TENANT_ROLES.has(session.role)) throw new Error('Tenant access required');
      renderNavigation();
      navigate(currentCleanTarget(), { history: 'replace' });
    } catch (_error) {
      window.location.replace('/login.html');
    }
  }

  window.TenantWorkspace = { allowedRoutesForRole, routeToEmbeddedUrl, navigate, boot, shouldHandleFrameLink, shellNavigationTarget };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
