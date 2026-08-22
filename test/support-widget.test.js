'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('support popup close control never submits the required description form', () => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'public', 'support-widget.js'), 'utf8');
  assert.match(widget, /class="support-close" type="button"/);
});

test('admin session refreshes navigation after adding the Support Tickets link', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.js'), 'utf8');
  assert.match(shell, /NAV_ITEMS\.push\(\{ href: '\/support-tickets\.html'/);
  assert.match(shell, /if \(session\.role === 'ADMIN'[\s\S]*?NAV_ITEMS\.push\([\s\S]*?\);\s*buildMobileTabbar\(\)/);
});

test('admin session adds Support Tickets to the visible sidebar and mobile dock', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-shell.js'), 'utf8');
  assert.match(shell, /function addAdminSupportNavigation\(\)/);
  assert.match(shell, /selector: '\.nav-list'/);
  assert.match(shell, /selector: '\.mobile-dock'/);
  assert.match(shell, /if \(session\.role === 'ADMIN'\)[\s\S]*?addAdminSupportNavigation\(\)/);
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
