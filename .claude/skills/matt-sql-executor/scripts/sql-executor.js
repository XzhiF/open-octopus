#!/usr/bin/env node

/**
 * SQLite Executor for Octopus project
 *
 * Usage:
 *   node sql-executor.js <sql-file-path>
 *   node sql-executor.js --sql "SELECT * FROM workflows"
 *   node sql-executor.js --db <path> --sql "..."
 *   node sql-executor.js --mode <dev|worktree|prod> --sql "..."
 *
 * DB path resolution (priority order):
 *   1. --db <path>
 *   2. OCTOPUS_DB_PATH env var
 *   3. --mode <dev|worktree|prod>
 *   4. Default: ~/.octopus/db/octopus.db
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── DB Path Resolution ─────────────────────────────────────────

function getBranchName() {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function safeName(branch) {
  return branch.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function resolveDbPath(args) {
  const dbDir = path.join(os.homedir(), '.octopus', 'db');

  // 1. Explicit --db
  const dbIdx = args.indexOf('--db');
  if (dbIdx !== -1 && args[dbIdx + 1]) {
    return path.resolve(args[dbIdx + 1]);
  }

  // 2. OCTOPUS_DB_PATH env var
  if (process.env.OCTOPUS_DB_PATH) {
    return process.env.OCTOPUS_DB_PATH;
  }

  // 3. --mode
  const modeIdx = args.indexOf('--mode');
  if (modeIdx !== -1 && args[modeIdx + 1]) {
    const mode = args[modeIdx + 1];
    switch (mode) {
      case 'prod':
        return path.join(dbDir, 'octopus-prod.db');
      case 'worktree': {
        const branch = getBranchName();
        return path.join(dbDir, `octopus-${safeName(branch)}.db`);
      }
      case 'dev':
      default:
        return path.join(dbDir, 'octopus.db');
    }
  }

  // 4. Default
  return path.join(dbDir, 'octopus.db');
}

// ─── SQL Parsing ────────────────────────────────────────────────

function parseStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('--'));
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage:');
    console.error('  node sql-executor.js <sql-file-path>');
    console.error('  node sql-executor.js --sql "SQL statement"');
    console.error('  node sql-executor.js --db <path> --sql "..."');
    console.error('  node sql-executor.js --mode <dev|worktree|prod> --sql "..."');
    process.exit(1);
  }

  // Parse SQL source
  let sql;
  const sqlIdx = args.indexOf('--sql');
  if (sqlIdx !== -1) {
    sql = args.slice(sqlIdx + 1).filter((a) => !a.startsWith('--')).join(' ');
  } else {
    const filePath = path.resolve(args.find((a) => !a.startsWith('--') && a !== args[args.indexOf('--db') + 1] && a !== args[args.indexOf('--mode') + 1]) || args[0]);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    sql = fs.readFileSync(filePath, 'utf-8');
    console.log(`File: ${filePath}`);
  }

  // Resolve DB
  const dbPath = resolveDbPath(args);
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error('Hint: run `pnpm dev` first to create the database, or use --db to specify a path.');
    process.exit(1);
  }

  // Load better-sqlite3 from the project
  let Database;
  // Find better-sqlite3 in pnpm's flat node_modules
  const pnpmDir = path.resolve('node_modules/.pnpm');
  const pnpmMatch = fs.existsSync(pnpmDir)
    && fs.readdirSync(pnpmDir).find((d) => d.startsWith('better-sqlite3@'));
  const searchPaths = [
    path.resolve('node_modules/better-sqlite3'),
    path.resolve('packages/server/node_modules/better-sqlite3'),
    pnpmMatch && path.join(pnpmDir, pnpmMatch, 'node_modules/better-sqlite3'),
    'better-sqlite3',
  ].filter(Boolean);

  for (const p of searchPaths) {
    try {
      Database = require(p);
      break;
    } catch {
      continue;
    }
  }

  if (!Database) {
    console.error('better-sqlite3 not found. Ensure the project is built (`pnpm build`).');
    process.exit(1);
  }

  // Execute
  console.log(`DB: ${dbPath}`);

  const db = new Database(dbPath, { readonly: false });
  const statements = parseStatements(sql);
  let totalChanges = 0;

  try {
    for (const stmt of statements) {
      console.log(`\nSQL: ${stmt.substring(0, 200)}${stmt.length > 200 ? '...' : ''}`);

      const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN)/i.test(stmt);

      if (isSelect) {
        const rows = db.prepare(stmt).all();
        if (rows.length > 0) {
          console.table(rows.slice(0, 20));
          console.log(`${rows.length} rows returned`);
        } else {
          console.log('No rows returned');
        }
      } else {
        const info = db.prepare(stmt).run();
        totalChanges += info.changes;
        console.log(`Changes: ${info.changes}`);
      }
    }

    if (totalChanges > 0) {
      console.log(`\nTotal changes: ${totalChanges}`);
    }
  } catch (error) {
    console.error(`\nSQL error: ${error.message}`);
    db.close();
    process.exit(1);
  }

  db.close();
  console.log('\nDone.');
}

main();
