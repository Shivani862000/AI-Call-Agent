function makeTestConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    port: 0,
    publicBaseUrl: 'https://example.test',
    supabaseDbUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseAnonKey: 'test-only-anon-key',
    cookieSecret: 'test-only-cookie-secret-at-least-32-bytes',
    sessionMaxAgeMs: 8 * 60 * 60 * 1000,
    twilioValidateSignatures: false,
    ...overrides
  };
}

module.exports = { makeTestConfig };
