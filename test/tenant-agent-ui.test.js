const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

async function loadAppShellForRole(role) {
  const bodyClasses = new Set();
  const document = {
    body: {
      classList: {
        add(...names) {
          names.forEach((name) => bodyClasses.add(name));
        },
      },
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        appendChild() {},
        classList: { add() {} },
        setAttribute() {},
      };
    },
  };

  const window = {
    document,
    innerWidth: 1280,
    location: {
      origin: 'http://local.test',
      pathname: '/admin.html',
      replace() {},
    },
    addEventListener() {},
    dispatchEvent() {},
  };

  const context = {
    CustomEvent: class CustomEvent {},
    clearTimeout() {},
    console,
    document,
    fetch: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ authenticated: true, role, username: 'tenant-agent' });
      },
    }),
    setTimeout() {
      return 0;
    },
    window,
  };

  const source = fs.readFileSync(path.join(projectRoot, 'public/app-shell.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'public/app-shell.js' });
  const session = await window.AppShell.ensureAuthenticatedSession();

  return { bodyClasses, session, shell: window.AppShell };
}

test('CLIENT_AGENT sessions activate tenant-agent UI restrictions', async () => {
  const { bodyClasses, session, shell } = await loadAppShellForRole('CLIENT_AGENT');

  assert.equal(session.role, 'CLIENT_AGENT');
  assert.equal(shell.isTenantAgent(), true);
  assert.equal(bodyClasses.has('role-agent'), true);
});

test('tenant-agent UI hides admin destinations and bulk import', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'public/app-shell.css'), 'utf8');
  const customerList = fs.readFileSync(path.join(projectRoot, 'public/customer-list.html'), 'utf8');

  assert.match(css, /body\.role-agent \[href="\/support-tickets\.html"\]/);
  assert.match(css, /body\.role-agent \[href="\/users\.html"\]/);

  const importButton = customerList.match(/<button[^>]*id="importCsvButton"[^>]*>/)?.[0] || '';
  assert.match(importButton, /admin-only-control/);
});

test('overview uses the shared tenant-agent role policy', () => {
  const overview = fs.readFileSync(path.join(projectRoot, 'public/admin.html'), 'utf8');

  assert.doesNotMatch(overview, /session\?\.role === 'AGENT'/);
  assert.equal((overview.match(/AppShell\.isTenantAgent\(\)/g) || []).length, 2);
});
