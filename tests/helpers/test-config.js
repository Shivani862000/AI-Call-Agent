function makeTestConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    port: 0,
    publicBaseUrl: 'https://example.test',
    supabaseDbUrl: 'postgresql://test-user:test-password@db.test.invalid:5432/postgres',
    supabaseUrl: 'https://test-project.supabase.co',
    supabaseAnonKey: 'test-only-anon-key',
    cookieSecret: 'test-only-cookie-secret-at-least-32-bytes',
    sessionMaxAgeMs: 8 * 60 * 60 * 1000,
    twilioValidateSignatures: false,
    ...overrides
  };
}

module.exports = { makeTestConfig };
