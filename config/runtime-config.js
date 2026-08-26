function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw configError(`CONFIG_${name}_REQUIRED`, `${name} is required`);
  return value;
}

function loadRuntimeConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || 'development');
  const supabaseDbUrl = required(env, 'SUPABASE_DB_URL');
  const supabaseUrl = required(env, 'SUPABASE_URL');
  const supabasePublishableKey = required(env, 'SUPABASE_PUBLISHABLE_KEY');
  const cookieSecret = required(env, 'COOKIE_SECRET');
  if (cookieSecret.length < 32) throw configError('CONFIG_COOKIE_SECRET_TOO_SHORT', 'COOKIE_SECRET must be at least 32 characters');

  const allowInsecureTestTls = nodeEnv === 'test' && env.SUPABASE_DB_TLS_INSECURE_TEST_ONLY === 'true';
  const ca = String(env.SUPABASE_DB_CA_CERT || '').replaceAll('\\n', '\n').trim();
  if (!ca && !allowInsecureTestTls) {
    throw configError('CONFIG_SUPABASE_DB_CA_CERT_REQUIRED', 'SUPABASE_DB_CA_CERT is required');
  }

  const publicBaseUrl = String(env.NGROK_URL || env.WEBHOOK_URL || env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return Object.freeze({
    nodeEnv,
    port: Number(env.PORT || 3000),
    publicBaseUrl,
    supabaseDbUrl,
    supabaseUrl,
    supabasePublishableKey,
    cookieSecret,
    databaseSsl: allowInsecureTestTls ? { rejectUnauthorized: false } : { ca, rejectUnauthorized: true },
    sessionMaxAgeMs: 8 * 60 * 60 * 1000
  });
}

module.exports = { loadRuntimeConfig };
