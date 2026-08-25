'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadWorkspaceController() {
  const document = {
    readyState: 'loading',
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return { classList: { add() {} }, setAttribute() {} }; }
  };
  const window = {
    document,
    location: {
      origin: 'https://console.example.test',
      pathname: '/admin.html',
      search: '',
      hash: '',
      replace() {}
    },
    addEventListener() {},
    history: { pushState() {}, replaceState() {} },
    setTimeout() { return 0; },
    clearTimeout() {}
  };
  window.window = window;
  window.self = window;
  window.top = window;

  const source = fs.readFileSync(path.join(projectRoot, 'public', 'tenant-workspace.js'), 'utf8');
  vm.runInNewContext(source, {
    URL,
    URLSearchParams,
    console,
    document,
    fetch: async () => ({ ok: true, json: async () => ({ authenticated: true, role: 'CLIENT_ADMIN' }) }),
    window
  }, { filename: 'public/tenant-workspace.js' });
  return window.TenantWorkspace;
}

test('tenant agent policy contains only operational tenant routes', () => {
  const workspace = loadWorkspaceController();

  assert.deepEqual(
    Array.from(workspace.allowedRoutesForRole('CLIENT_AGENT')),
    ['/admin.html', '/customer-list.html', '/customers.html']
  );
  assert.deepEqual(
    Array.from(workspace.allowedRoutesForRole('CLIENT_ADMIN')),
    ['/admin.html', '/customer-list.html', '/customers.html', '/feedback.html', '/support-tickets.html', '/users.html']
  );
});

test('workspace converts only allowed canonical routes to embedded URLs without losing location state', () => {
  const workspace = loadWorkspaceController();

  assert.equal(
    workspace.routeToEmbeddedUrl('/customers.html?filter=open#queue'),
    '/customers.html?filter=open&embedded=1#queue'
  );
  assert.throws(
    () => workspace.routeToEmbeddedUrl('/webmaster.html'),
    /Unknown tenant workspace route/
  );
});

test('workspace leaves browser-native and external links to the browser', () => {
  const workspace = loadWorkspaceController();
  const plainEvent = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  assert.equal(workspace.shouldHandleFrameLink({ href: '/customers.html', target: '', hasAttribute: () => false }, plainEvent), true);
  assert.equal(workspace.shouldHandleFrameLink({ href: 'https://other.example.test/path', target: '', hasAttribute: () => false }, plainEvent), false);
  assert.equal(workspace.shouldHandleFrameLink({ href: '/customers.html', target: '_blank', hasAttribute: () => false }, plainEvent), false);
  assert.equal(workspace.shouldHandleFrameLink({ href: '/customers.html', target: '', hasAttribute: name => name === 'download' }, plainEvent), false);
  assert.equal(workspace.shouldHandleFrameLink({ href: '#section', target: '', hasAttribute: () => false }, plainEvent), false);
  assert.equal(workspace.shouldHandleFrameLink({ href: '/customers.html', target: '', hasAttribute: () => false }, { ...plainEvent, ctrlKey: true }), false);
});

test('workspace identifies a primary-sidebar route for capture-phase navigation', () => {
  const workspace = loadWorkspaceController();
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: {
      closest(selector) {
        assert.equal(selector, '[data-tenant-workspace-route]');
        return {
          href: '/users.html',
          target: '',
          getAttribute(name) { return name === 'href' ? '/users.html' : '/users.html'; },
          hasAttribute(name) { return name === 'data-tenant-workspace-route'; }
        };
      }
    }
  };

  assert.equal(workspace.shellNavigationTarget(event), '/users.html');
});

test('embedded legacy views have a dedicated presentation mode that suppresses duplicate chrome', () => {
  const shellSource = fs.readFileSync(path.join(projectRoot, 'public', 'app-shell.js'), 'utf8');
  const shellCss = fs.readFileSync(path.join(projectRoot, 'public', 'app-shell.css'), 'utf8');

  assert.match(shellSource, /function isEmbeddedTenantView\(/);
  assert.match(shellSource, /if \(isEmbeddedTenantView\(\)\) return/);
  assert.match(shellCss, /body\.embedded-tenant-view \.sidebar/);
  assert.match(shellCss, /body\.embedded-tenant-view \.mobile-dock/);
});

test('workspace loading and error panels respect their hidden state', () => {
  const shellCss = fs.readFileSync(path.join(projectRoot, 'public', 'tenant-workspace.css'), 'utf8');

  assert.match(shellCss, /\.tenant-workspace-error\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(shellCss, /\.tenant-workspace-main iframe\[hidden\]\s*\{\s*display:\s*none;/);
});
