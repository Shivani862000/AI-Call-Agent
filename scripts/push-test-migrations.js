const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getTestConnectionString } = require('../tests/helpers/postgres-test-context');

function migrationFlags(argv) {
  const unsupported = argv.filter((argument) => argument !== '--dry-run');
  if (unsupported.length > 0) {
    throw new Error('Hosted test migration push accepts only the optional --dry-run flag');
  }
  return argv;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const connectionString = getTestConnectionString(env);
  const cliPath = path.resolve(process.cwd(), 'node_modules/.bin/supabase');
  const result = spawnSync(
    cliPath,
    ['db', 'push', '--db-url', connectionString, '--skip-vault', ...migrationFlags(argv)],
    { cwd: process.cwd(), env, stdio: 'inherit' }
  );

  if (result.error) {
    throw new Error('Unable to execute the installed Supabase CLI');
  }

  return result.status ?? 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, migrationFlags };
