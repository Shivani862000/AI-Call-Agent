'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOTS = ['src', 'services', 'routes', 'scripts'];

// SQLite-only SQL that Postgres rejects at runtime. The negative lookbehind
// keeps JS helpers like formatHumanDateTime / buildScheduledDateTime out of it.
const BANNED = [
  { name: 'DATETIME()',     re: /(?<![A-Za-z])DATETIME\s*\(/i },
  { name: 'STRFTIME()',     re: /(?<![A-Za-z])STRFTIME\s*\(/i },
  { name: 'JULIANDAY()',    re: /(?<![A-Za-z])JULIANDAY\s*\(/i },
  { name: 'IFNULL()',       re: /(?<![A-Za-z])IFNULL\s*\(/i },
  { name: 'GROUP_CONCAT()', re: /(?<![A-Za-z])GROUP_CONCAT\s*\(/i },
  { name: 'INSERT OR ...',  re: /INSERT\s+OR\s+(REPLACE|IGNORE)/i }
];

function* jsFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

test('no SQLite-only SQL functions survive in the source', () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of jsFiles(path.join(__dirname, '..', root))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const { name, re } of BANNED) {
          if (re.test(line)) {
            offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1} ${name}`);
          }
        }
      });
    }
  }
  assert.deepStrictEqual(offenders, [], `SQLite-only SQL found:\n  ${offenders.join('\n  ')}`);
});
