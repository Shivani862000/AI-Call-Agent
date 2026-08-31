require('dotenv').config();
const supabaseAdmin = require('./src/supabase');
async function test() {
  const { data, error } = await supabaseAdmin.from('users').select('email').eq('username', 'webmaster').single();
  console.log('Test using src/supabase:', { data, error });
}
test();
