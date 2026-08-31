const fs = require('fs');
const path = require('path');

const targetFiles = [
  'admin.html',
  'customer-list.html',
  'customers.html',
  'feedback.html',
  'feedback-analysis.html',
  'support-tickets.html',
  'users.html'
];

const unifiedSidebar = `<nav class="nav-list" aria-label="Primary navigation">
          <a href="/admin.html" class="nav-link">Overview</a>
          <a href="/customer-list.html" class="nav-link">Customer List</a>
          <a href="/customers.html" class="nav-link">Outbound Calls</a>
          <a href="/feedback.html" class="nav-link admin-only-control">Feedback</a>
          <div class="nav-group-label admin-only-control" style="margin: 20px 0 8px; padding: 0 16px; font-size: 11px; font-weight: 700; color: #52606d; text-transform: uppercase; letter-spacing: 0.5px;">SETTINGS</div>
          <a href="/support-tickets.html" class="nav-link admin-only-control">Support Tickets</a>
          <a href="/users.html" class="nav-link admin-only-control">Users</a>
        </nav>`;

const unifiedMobileDock = `<nav class="mobile-dock mobile-only" aria-label="Primary navigation">
    <a href="/admin.html" class="mobile-dock-link">Overview</a>
    <a href="/customers.html" class="mobile-dock-link">Outbound</a>
    <a href="/feedback.html" class="mobile-dock-link admin-only-control">Feedback</a>
    <a href="/support-tickets.html" class="mobile-dock-link admin-only-control">Support</a>
    <a href="/users.html" class="mobile-dock-link admin-only-control">Users</a>
  </nav>`;

for (const file of targetFiles) {
  const p = path.join(__dirname, 'public', file);
  if (fs.existsSync(p)) {
    let content = fs.readFileSync(p, 'utf8');
    
    // Replace <nav class="nav-list"...> ... </nav>
    content = content.replace(/<nav class="nav-list"[\s\S]*?<\/nav>/, unifiedSidebar);
    
    // Replace <nav class="mobile-dock"...> ... </nav>
    content = content.replace(/<nav class="mobile-dock[\s\S]*?<\/nav>/, unifiedMobileDock);
    
    // Highlight the active tab for desktop
    const desktopLinkRegex = new RegExp(`(<a href="/${file}" class="nav-link)(">.*?</a>)`, 'g');
    content = content.replace(desktopLinkRegex, '$1 active$2');

    // Highlight the active tab for mobile
    const mobileLinkRegex = new RegExp(`(<a href="/${file}" class="mobile-dock-link)(">.*?</a>)`, 'g');
    content = content.replace(mobileLinkRegex, '$1 active$2');
    
    fs.writeFileSync(p, content, 'utf8');
    console.log('Fixed ' + file);
  }
}
