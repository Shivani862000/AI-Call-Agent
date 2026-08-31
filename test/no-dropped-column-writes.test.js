'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Derives the live schema from the migration files, then asserts no code
 * writes a column that no longer exists.
 *
 * Dropping "dead" columns has now broken three separate runtime paths —
 * preferred_dialect in the scheduler, consent_status in the workflow patch,
 * and recording_consent_captured in the post-call pipeline. Each failed only
 * when that path actually ran, which for the pipeline meant after a real call
 * to a real patient. A grep for references is not enough: these are writes,
 * and they are only reachable under specific conditions.
 */
function schemaFromMigrations() {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const tables = new Map();

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');

    for (const m of sql.matchAll(/create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      const columns = new Set();
      for (const line of m[2].split('\n')) {
        const col = /^\s*([a-z_][a-z0-9_]*)\s+/i.exec(line.replace(/^\s*(constraint|primary|unique|foreign|check)\b.*/i, ''));
        if (col) columns.add(col[1].toLowerCase());
      }
      tables.set(m[1].toLowerCase(), columns);
    }
    // Each ALTER TABLE is handled as a unit: a migration drops several columns
    // in one statement, and the drops belong to that statement's table only.
    // Applying them to every table erases same-named columns elsewhere.
    for (const m of sql.matchAll(/alter table (?:public\.)?(\w+)([\s\S]*?);/gi)) {
      const cols = tables.get(m[1].toLowerCase());
      if (!cols) continue;
      for (const add of m[2].matchAll(/add column (?:if not exists )?(\w+)/gi)) cols.add(add[1].toLowerCase());
      for (const drop of m[2].matchAll(/drop column (?:if exists )?(\w+)/gi)) cols.delete(drop[1].toLowerCase());
    }
    for (const m of sql.matchAll(/drop table (?:if exists )?(\w+)/gi)) {
      tables.delete(m[1].toLowerCase());
    }
  }
  return tables;
}

test('no code writes a column that migrations have dropped', () => {
  const tables = schemaFromMigrations();
  assert.ok(tables.get('calls')?.size > 40, 'schema parse produced too few columns to trust');

  const roots = ['src', 'services', 'routes'];
  const offenders = [];

  for (const root of roots) {
    const dir = path.join(__dirname, '..', root);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');

      for (const stmt of source.matchAll(/UPDATE\s+(\w+)([\s\S]{0,1500}?)WHERE/gi)) {
        const table = stmt[1].toLowerCase();
        const known = tables.get(table);
        if (!known) continue;
        for (const assign of stmt[2].matchAll(/([a-z_][a-z0-9_]*)\s*=\s*[?$]/gi)) {
          const column = assign[1].toLowerCase();
          if (!known.has(column)) offenders.push(`${root}/${file}: UPDATE ${table} SET ${column}`);
        }
      }

      for (const stmt of source.matchAll(/INSERT INTO\s+(\w+)\s*\(([^)]*)\)/gi)) {
        const table = stmt[1].toLowerCase();
        const known = tables.get(table);
        if (!known) continue;
        for (const raw of stmt[2].split(',')) {
          const column = raw.trim().toLowerCase();
          if (/^[a-z_][a-z0-9_]*$/.test(column) && !known.has(column)) {
            offenders.push(`${root}/${file}: INSERT INTO ${table} (${column})`);
          }
        }
      }
    }
  }

  assert.deepStrictEqual([...new Set(offenders)], [], 'these writes target columns that no longer exist');
});
