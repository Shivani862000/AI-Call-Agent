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

const scriptTag = `  <script>
    if (localStorage.getItem('userRole') === 'AGENT' || localStorage.getItem('userRole') === 'CLIENT_AGENT') {
      document.documentElement.classList.add('role-agent');
    }
  </script>
`;

for (const file of targetFiles) {
  const p = path.join(__dirname, 'public', file);
  if (fs.existsSync(p)) {
    let content = fs.readFileSync(p, 'utf8');
    if (!content.includes("localStorage.getItem('userRole')")) {
      content = content.replace(/<head>/i, '<head>\n' + scriptTag);
      fs.writeFileSync(p, content, 'utf8');
      console.log('Fixed head in ' + file);
    }
  }
}
