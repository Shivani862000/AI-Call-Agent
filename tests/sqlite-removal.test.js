const assert = require('node:assert/strict');
const test = require('node:test');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function filesUnder(entry) {
  const absolute = path.join(ROOT, entry);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [absolute];
  return readdirSync(absolute).flatMap((name) => filesUnder(path.join(entry, name)));
}

test('Supabase Postgres is the only runtime persistence implementation', () => {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(Object.hasOwn(dependencies, ['sqlite', '3'].join('')), false);
  assert.equal(Object.hasOwn(dependencies, ['mongo', 'db'].join('')), false);

  for (const obsolete of ['db.js', 'repositories/sqlite-customers.js', 'routes/calls.js', 'routes/twiml.js', 'routes/whatsapp.js']) {
    assert.equal(existsSync(path.join(ROOT, obsolete)), false, `${obsolete} must be removed`);
  }

  const runtimeFiles = [
    'index.js', 'package.json', '.env.example', 'README.md',
    'auth', 'config', 'logging', 'middleware', 'persistence', 'repositories', 'routes', 'runtime', 'scripts', 'services'
  ].flatMap(filesUnder).filter((file) => /\.(?:js|json|md|example)$/.test(file) || file.endsWith('.env.example'));
  const forbidden = [
    ['sqlite', '3'].join(''),
    ['feedback', '.db'].join(''),
    ['DATABASE', '_URL'].join(''),
    ['MONGODB', '_URI'].join(''),
    ['MONGODB', '_DB_NAME'].join(''),
    ['mongo', 'db'].join(''),
    ['db', 'Run'].join(''),
    ['db', 'Get'].join(''),
    ['db', 'All'].join('')
  ];
  const violations = [];
  for (const file of runtimeFiles) {
    const source = readFileSync(file, 'utf8').toLowerCase();
    for (const token of forbidden) {
      if (source.includes(token.toLowerCase())) violations.push(`${path.relative(ROOT, file)}:${token}`);
    }
  }
  assert.deepEqual(violations, []);
});
