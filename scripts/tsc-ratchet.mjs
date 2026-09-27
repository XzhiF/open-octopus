#!/usr/bin/env node
/**
 * tsc ratchet gate — per-package `tsc --noEmit` error counts may only go DOWN, never up.
 *
 * Usage:
 *   pnpm typecheck                # check current counts vs .tsc-baseline.json (fails on any increase)
 *   pnpm typecheck:update         # rewrite baseline with current counts (only after intentional fixes)
 *   node scripts/tsc-ratchet.mjs --only server,cli   # restrict to packages
 *
 * Rationale: builds run through tsup (transpile-only), so type errors never fail CI.
 * The SQLite->PG migration adds `await` across ~166 server files; a missing await is
 * a silent runtime failure unless the error count is pinned. Baseline today's debt,
 * refuse any increase.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = join(ROOT, '.tsc-baseline.json');
const PACKAGES = ['shared', 'cli', 'engine', 'providers', 'server', 'web-app'];

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : null;

function countErrors(pkg) {
  const project = join(ROOT, 'packages', pkg, 'tsconfig.json');
  const tscBin = join(ROOT, 'node_modules', '.bin', 'tsc');
  const res = spawnSync(tscBin, ['--noEmit', '--pretty', 'false', '-p', project], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  // Only real diagnostic lines: "path(line,col): error TSxxxx: ..."
  return out.split('\n').filter((l) => /\(\d+,\d+\): error TS\d+/.test(l)).length;
}

const units = ONLY ? PACKAGES.filter((p) => ONLY.includes(p)) : PACKAGES;

let baseline = { note: 'per-package tsc --noEmit error counts; ratchet: only decreases allowed', packages: {} };
if (existsSync(BASELINE_FILE)) {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  if (!baseline.packages) baseline.packages = {};
}

const current = {};
const failures = [];
const improvements = [];

console.log('tsc ratchet — per-package tsc --noEmit error counts (baseline may only shrink):');
for (const pkg of units) {
  const count = countErrors(pkg);
  current[pkg] = count;
  const base = baseline.packages[pkg];
  if (UPDATE) {
    console.log(`  ${pkg.padEnd(10)} ${String(count).padStart(4)}  recorded`);
    continue;
  }
  if (base === undefined) {
    console.log(`  ${pkg.padEnd(10)} ${String(count).padStart(4)}  NO BASELINE  FAIL`);
    failures.push(`${pkg}: no baseline entry (current ${count})`);
  } else if (count > base) {
    console.log(`  ${pkg.padEnd(10)} ${String(count).padStart(4)}  baseline ${base}  +${count - base}  FAIL`);
    failures.push(`${pkg}: ${count} errors, baseline ${base} (+${count - base})`);
  } else if (count < base) {
    console.log(`  ${pkg.padEnd(10)} ${String(count).padStart(4)}  baseline ${base}  -${base - count}  OK (run 'pnpm typecheck:update' to lock in)`);
    improvements.push(`${pkg}: ${base} -> ${count}`);
  } else {
    console.log(`  ${pkg.padEnd(10)} ${String(count).padStart(4)}  baseline ${base}  OK`);
  }
}

if (UPDATE) {
  for (const pkg of units) baseline.packages[pkg] = current[pkg];
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nbaseline updated -> ${BASELINE_FILE}`);
  process.exit(0);
}

if (failures.length) {
  console.error('\nRATCHET VIOLATION — typecheck error count increased vs baseline:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}

if (improvements.length) {
  console.log('\nErrors decreased in: ' + improvements.join(', '));
  console.log('Lock it in with: pnpm typecheck:update');
}
console.log('\nRatchet OK — no package exceeded its baseline.');
