require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function seed() {
  console.log("Seeding Webmaster Data...");

  // 1. Seed Platform Settings
  const defaultSettings = {
    singleton_key: 'platform',
    schema_version: 1,
    policies: {
      password: {
        minLength: 8,
        maxLength: 128
      }
    },
    application: {
        name: 'AI Call Agent Platform',
        supportEmail: 'support@vikitech.in'
    },
    feature_flags: {},
    providers: {
        gemini: { enabled: true },
        deepgram: { enabled: true },
        twilio: { enabled: true },
        bhashini: { enabled: true },
        sarvam: { enabled: true }
    },
    maintenance: {
        active: false,
        message: 'We are currently undergoing maintenance.'
    }
  };

  const { data: existingSettings } = await supabase
    .from('platform_settings')
    .select('singleton_key')
    .eq('singleton_key', 'platform')
    .maybeSingle();

  if (!existingSettings) {
    const { error } = await supabase.from('platform_settings').insert(defaultSettings);
    if (error) {
      console.error("Error seeding platform_settings:", error);
    } else {
      console.log("Successfully seeded platform_settings.");
    }
  } else {
    console.log("platform_settings already exists, skipping seed.");
  }
  
  // Create Webmaster user if not exists
  const { data: existingWebmaster } = await supabase.from('users').select('username').eq('username', 'webmaster').maybeSingle();
  if (!existingWebmaster) {
      const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
          email: 'webmaster@vikitech.in',
          password: 'USE_SUPABASE_AUTH',
          email_confirm: true
      });
      if (authErr) {
          console.error("Error creating webmaster auth user:", authErr);
      } else {
          const { error: insertErr } = await supabase.from('users').insert({
              id: authUser.user.id,
              username: 'webmaster',
              email: 'webmaster@vikitech.in',
              role: 'WEBMASTER',
              platform_access_level: 'OWNER',
              status: 'active'
          });
          if (insertErr) {
              console.error("Error creating webmaster user profile:", insertErr);
          } else {
              console.log("Successfully created webmaster user.");
          }
      }
  } else {
      console.log("webmaster user already exists, skipping seed.");
  }

  console.log("Seeding complete.");
}

seed().catch(console.error);
