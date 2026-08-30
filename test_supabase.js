require('dotenv').config();
const supabase = require('./src/supabase');
async function test() {
  const { data, error } = await supabase.from('support_tickets').select('*');
  console.log("Error:", error);
}
test();
