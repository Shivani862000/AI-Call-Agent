const fs = require('fs');
const path = require('path');

function replaceSqliteWithSupabase(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // UPDATE calls SET outcome = ?, outcome_detail = ? WHERE id = ?
  content = content.replace(/await dbRun\(\s*['"`]UPDATE\s+([a-zA-Z_]+)\s+SET\s+([a-zA-Z_]+)\s*=\s*\?,\s*([a-zA-Z_]+)\s*=\s*\?\s+WHERE\s+([a-zA-Z_]+)\s*=\s*\?['"`]\s*,\s*\[([^,]+),\s*([^,]+),\s*([^\]]+)\]\s*\)/g, 
    "(await supabase.from('$1').update({ $2: $5, $3: $6 }).eq('$4', $7))");

  // UPDATE table SET col = ? WHERE id = ?
  content = content.replace(/await dbRun\(\s*['"`]UPDATE\s+([a-zA-Z_]+)\s+SET\s+([a-zA-Z_]+)\s*=\s*\?\s+WHERE\s+([a-zA-Z_]+)\s*=\s*\?['"`]\s*,\s*\[([^,]+),\s*([^\]]+)\]\s*\)/g, 
    "(await supabase.from('$1').update({ $2: $4 }).eq('$3', $5))");

  // INSERT INTO table (col1, col2) VALUES (?, ?)
  content = content.replace(/await dbRun\(\s*['"`]INSERT INTO\s+([a-zA-Z_]+)\s*\(([a-zA-Z_]+),\s*([a-zA-Z_]+)\)\s*VALUES\s*\(\?,\s*\?\)['"`]\s*,\s*\[([^,]+),\s*([^\]]+)\]\s*\)/g, 
    "(await supabase.from('$1').insert([{ $2: $4, $3: $5 }]))");

  // DELETE FROM table WHERE col = ?
  content = content.replace(/await dbRun\(\s*['"`]DELETE FROM\s+([a-zA-Z_]+)\s+WHERE\s+([a-zA-Z_]+)\s*=\s*\?['"`]\s*,\s*\[([^\]]+)\]\s*\)/g, 
    "(await supabase.from('$1').delete().eq('$2', $3))");

  // SELECT * FROM table WHERE tenant_id = ? ORDER BY id DESC LIMIT 100
  content = content.replace(/await dbAll\(\s*['"`]SELECT\s+\*\s+FROM\s+([a-zA-Z_]+)\s+WHERE\s+tenant_id\s*=\s*\?\s+ORDER BY\s+([a-zA-Z_]+)\s+(DESC|ASC)\s+LIMIT\s+([0-9]+)['"`]\s*,\s*\[([^\]]+)\]\s*\)/gi, 
    "(await supabase.from('$1').select('*').eq('tenant_id', $5).order('$2', { ascending: false }).limit($4)).data");

  // SELECT * FROM table WHERE col = ?
  content = content.replace(/await dbAll\(\s*['"`]SELECT\s+\*\s+FROM\s+([a-zA-Z_]+)\s+WHERE\s+([a-zA-Z_]+)\s*=\s*\?['"`]\s*,\s*\[([^\]]+)\]\s*\)/g, 
    "(await supabase.from('$1').select('*').eq('$2', $3)).data");

  // SELECT * FROM table
  content = content.replace(/await dbAll\(\s*['"`]SELECT\s+\*\s+FROM\s+([a-zA-Z_]+)['"`]\s*\)/g, 
    "(await supabase.from('$1').select('*')).data");

  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Updated ' + filePath);
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
  const fullPath = path.join(process.cwd(), f);
  if (fs.existsSync(fullPath)) {
     replaceSqliteWithSupabase(fullPath);
  }
});
