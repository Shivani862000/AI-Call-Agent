const fs = require('fs');
const path = require('path');

function replaceSqliteWithSupabase(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // If already imported supabase, skip import addition
  if (!content.includes('const { supabase }')) {
    content = content.replace(/const\s+\{\s*([^}]*?)dbGet([^}]*?)\}\s*=\s*require\(['"]\.\.?\/db['"]\);/g, "const { $1 dbGet $2} = require('../db');\nconst { supabase } = require('../src/supabase');");
    content = content.replace(/const\s+\{\s*([^}]*?)dbRun([^}]*?)\}\s*=\s*require\(['"]\.\.?\/db['"]\);/g, "const { $1 dbRun $2} = require('../db');\nconst { supabase } = require('../src/supabase');");
    content = content.replace(/const\s+\{\s*([^}]*?)dbAll([^}]*?)\}\s*=\s*require\(['"]\.\.?\/db['"]\);/g, "const { $1 dbAll $2} = require('../db');\nconst { supabase } = require('../src/supabase');");
    // Sometimes it's from ../db or ../../db
    content = content.replace(/require\('\.\/db'\)/g, "require('./db')");
  }

  // Very basic replacements for standard SQL queries to Supabase syntax
  // SELECT * FROM table WHERE col = ?
  content = content.replace(/await dbGet\(\s*['"`]SELECT\s+\*\s+FROM\s+([a-zA-Z_]+)\s+WHERE\s+([a-zA-Z_]+)\s*=\s*\?['"`]\s*,\s*\[([^\]]+)\]\s*\)/g, "(await supabase.from('$1').select('*').eq('$2', $3).maybeSingle()).data");
  
  // SELECT id FROM table WHERE col = ?
  content = content.replace(/await dbGet\(\s*['"`]SELECT\s+id\s+FROM\s+([a-zA-Z_]+)\s+WHERE\s+([a-zA-Z_]+)\s*=\s*\?['"`]\s*,\s*\[([^\]]+)\]\s*\)/g, "(await supabase.from('$1').select('id').eq('$2', $3).maybeSingle()).data");
  
  // SELECT count
  // E.g. SELECT COUNT(*) as count FROM calls c WHERE c.customer_id = ? AND DATE(c.called_at, 'localtime') = DATE('now', 'localtime') AND COALESCE(c.call_direction, 'outbound') = 'outbound'
  // Let's replace the dbGet with a custom helper function that we inject at the top of the file, OR we just let it be and replace it manually.
  
  // Actually, wait, replacing SQL queries via regex is incredibly brittle and will likely leave the app in a broken state for complex queries.

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated ${filePath}`);
}

const files = [
  'src/api-routes.js',
  'services/post-call-pipeline.js',
  'services/call-orchestration.js',
  'services/call-feedback.js',
  'services/test-call.js',
  'services/test-ai-call.js',
  'services/crm-sync.js',
  'services/reporting.js',
  'src/call-management.js',
  'src/websocket-bridge.js'
];

files.forEach(f => {
  const fullPath = path.join(__dirname, f);
  if (fs.existsSync(fullPath)) {
     replaceSqliteWithSupabase(fullPath);
  }
});
