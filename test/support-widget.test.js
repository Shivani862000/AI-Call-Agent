'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('support popup close control never submits the required description form', () => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'public', 'support-widget.js'), 'utf8');
  assert.match(widget, /class="support-close" type="button"/);
});

test('mobile and iPad support launcher is a compact circular headphones button without the legacy chart glyph', () => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'public', 'support-widget.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'support-widget.css'), 'utf8');
  assert.doesNotMatch(widget, /◔/);
  assert.match(widget, /class="support-icon"/);
  assert.match(widget, /aria-label', 'Open support'/);
  assert.match(css, /@media\(max-width:1024px\)\s*\{\s*\.support-launcher\s*\{[^}]*width:\s*45px;[^}]*height:\s*45px;[^}]*border-radius:\s*50%/);
});

test('mobile Customers New Call control stays left of the right-side support launcher', () => {
  const shellCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.css'), 'utf8');
  assert.match(shellCss, /\.customers-page #mobileFloatingNewCallButton\.mobile-floating-cta\s*\{[^}]*left:\s*max\(14px, env\(safe-area-inset-left\)\);[^}]*right:\s*auto;/);
});

test('mobile Overview New Call control stays left of the right-side support launcher', () => {
  const shellCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.css'), 'utf8');
  assert.match(shellCss, /\.overview-page \.mobile-floating-cta\s*\{[^}]*left:\s*max\(14px, env\(safe-area-inset-left\)\);[^}]*right:\s*auto;/);
});

test('mobile Customers call-card actions keep Analysis and More in the same row', () => {
  const shellCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.css'), 'utf8');
  const actionsRule = shellCss.match(/\.customers-page \.mobile-call-actions \{[^}]*\}/)?.[0] || '';
  const moreRules = Array.from(shellCss.matchAll(/\.customers-page \.mobile-call-actions \.mobile-more-button \{[^}]*\}/g), (match) => match[0]).join('\n');

  assert.match(actionsRule, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(moreRules, /grid-column/);
});

test('mobile support dialog protects the title, fits the viewport, and scrolls its form safely', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'support-widget.css'), 'utf8');
  assert.match(css, /\.support-dialog\s+h2\s*\{[^}]*padding-right:\s*42px/);
  assert.match(css, /@media\(max-width:1024px\)\s*\{[\s\S]*?\.support-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 20px\)/);
  assert.match(css, /\.support-dialog\s+form\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.support-close\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px/);
});

test('admin session refreshes navigation after adding the Support Tickets link', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.js'), 'utf8');
  assert.match(shell, /NAV_ITEMS\.push\(\{ href: '\/support-tickets\.html'/);
  assert.match(shell, /if \(session\.role === 'ADMIN'[\s\S]*?NAV_ITEMS\.push\([\s\S]*?\);\s*buildMobileTabbar\(\)/);
});

test('admin session adds Support Tickets to the visible sidebar and mobile dock', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.js'), 'utf8');
  // Sidebar link and mobile dock entry, both gated on the admin role. Asserted
  // by behaviour rather than by the shape of the internals, which moved when
  // the admin links were grouped at the foot of the sidebar.
  assert.match(shell, /function addAdminSupportNavigation\(\)/);
  assert.match(shell, /selector: '\.mobile-dock'/);
  assert.match(shell, /addAdminNavLink\('\/support-tickets\.html', 'Support Tickets'/);
  assert.match(shell, /if \(session\.role === 'ADMIN'\)[\s\S]*?addAdminSupportNavigation\(\)/);
});

test('the administration links are grouped at the foot of the sidebar', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.css'), 'utf8');

  for (const href of ['/support-tickets.html', '/users.html', '/settings.html']) {
    assert.match(shell, new RegExp(`addAdminNavLink\\('${href.replace(/\//g, '\\/')}'[^)]*bottom: true`),
      `${href} must go in the bottom group`);
  }
  // Patients is day-to-day work, not administration: it stays at the top.
  assert.ok(!/addAdminNavLink\('\/patients\.html'[^)]*bottom: true/.test(shell));
  assert.match(css, /\.nav-list-secondary \{[\s\S]*?margin-top: auto/);
});

test('support tickets page shares the admin navigation shell', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'support-tickets.html'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.js'), 'utf8');
  assert.match(page, /<body class="poc-page support-tickets-page">/);
  assert.match(page, /<aside class="sidebar">/);
  assert.match(page, /<nav class="nav-list">/);
  assert.match(page, /<nav class="mobile-dock mobile-only" aria-label="Primary navigation">/);
  assert.match(page, /await AppShell\.ensureAuthenticatedSession\(\)/);
  assert.match(shell, /currentPath === '\/support-tickets\.html'/);
});

test('support tickets page provides one-click navigation to rendered ticket cards', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'support-tickets.html'), 'utf8');
  assert.match(page, /id="ticketJumpMenu"/);
  assert.match(page, /function renderTicketJumpMenu\(tickets\)/);
  assert.match(page, /link\.href = `#ticket-\$\{ticket\.ticket_id\}`/);
  assert.match(page, /id="ticket-\$\{AppShell\.escapeHtml\(ticket\.ticket_id\)\}"/);
});
