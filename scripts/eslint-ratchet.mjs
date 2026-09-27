#!/usr/bin/env node
/**
 * eslint ratchet gate — like scripts/tsc-ratchet.mjs, but for a single ESLint rule:
 *   @typescript-eslint/no-floating-promises (packages/server/eslint.config.mjs)
 *
 * A package opts in via the PACKAGES list below; counts of that rule's
 * violations may only go DOWN vs .eslint-baseline.json.
 *
 * Usage:
 *   pnpm typecheck                # tsc ratchet && eslint ratchet (root scripts chain both)
 *   node scripts/eslint-ratchet.mjs --update        # lock current counts into baseline
 *   node scripts/eslint-ratchet.mjs --only server   # restrict to packages
 *
 * NOTE: requires `pnpm -r --filter '!@octopus/web-app' build` first (workspace types
 * resolve via dist dts) — same precondition as the tsc ratchet.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = join(ROOT, '.eslint-baseline.json');
const RULE = '@typescript-eslint/no-floating-promises';

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : null;

// Packages gated by this ratchet. A new package opts in by: adding a minimal
// eslint.config.mjs (single-rule style, see packages/server) + listing it here.
// (No auto-discovery: web-app ships an unrelated eslint-config-next that doesn't fit this gate.)
const PACKAGES = ['server'];

function countViolations(pkg) {
  const cwd = join(ROOT, 'packages', pkg);
  const bin = existsSync(join(cwd, 'node_modules', '.bin', 'eslint'))
    ? join(cwd, 'node_modules', '.bin', 'eslint')
    : join(ROOT, 'node_modules', '.bin', 'eslint');
  const res = spawnSync(bin, ['src', '--format', 'json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  let results;
  try {
    results = JSON.parse(res.stdout);
  } catch {
    // Config error / crash — stdout is not JSON. Surface raw output and fail loudly.
    console.error(`eslint crashed for ${pkg} (exit ${res.status}):`);
    console.error(((res.stdout || '') + (res.stderr || '')).trim());
    process.exit(1);
  }
  const hits = [];
  for (const file of results) {
    for (const m of file.messages) {
      if (m.fatal) {
        // Parse failure — counting would silently under-report; fail loudly instead.
        console.error(`eslint parse failure in ${relative(ROOT, file.filePath)}: ${m.message}`);
        process.exit(1);
      }
      if (m.ruleId === RULE) {
        hits.push(`${relative(ROOT, file.filePath)}:${m.line}:${m.column}`);
      }
    }
  }
  return hits;
}

const units = ONLY ? PACKAGES.filter((p) => ONLY.includes(p)) : PACKAGES;
if (!units.length) {
  console.log('eslint ratchet — no package has an eslint config yet, nothing to check.');
  process.exit(0);
}

let baseline = { note: `per-package ${RULE} violation counts; ratchet: only decreases allowed`, packages: {} };
if (existsSync(BASELINE_FILE)) {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  if (!baseline.packages) baseline.packages = {};
}

const current = {};
const failures = [];
const improvements = [];

console.log(`eslint ratchet — per-package ${RULE} counts (baseline may only shrink):`);
for (const pkg of units) {
  const hits = countViolations(pkg);
  current[pkg] = hits.length;
  const base = baseline.packages[pkg];
  if (UPDATE) {
    console.log(`  ${pkg.padEnd(10)} ${String(hits.length).padStart(4)}  recorded`);
    continue;
  }
  if (base === undefined) {
    console.log(`  ${pkg.padEnd(10)} ${String(hits.length).padStart(4)}  NO BASELINE  FAIL`);
    failures.push(`${pkg}: no baseline entry (current ${hits.length})`);
  } else if (hits.length > base) {
    console.log(`  ${pkg.padEnd(10)} ${String(hits.length).padStart(4)}  baseline ${base}  +${hits.length - base}  FAIL`);
    failures.push(`${pkg}: ${hits.length} violations, baseline ${base} (+${hits.length - base})`);
    for (const h of hits) console.log(`      ${h}`);
  } else if (hits.length < base) {
    console.log(`  ${pkg.padEnd(10)} ${String(hits.length).padStart(4)}  baseline ${base}  -${base - hits.length}  OK (run 'pnpm typecheck:update' to lock in)`);
    improvements.push(`${pkg}: ${base} -> ${hits.length}`);
  } else {
    console.log(`  ${pkg.padEnd(10)} ${String(hits.length).padStart(4)}  baseline ${base}  OK`);
  }
}

if (UPDATE) {
  for (const pkg of units) baseline.packages[pkg] = current[pkg];
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nbaseline updated -> ${BASELINE_FILE}`);
  process.exit(0);
}

if (failures.length) {
  console.error(`\nRATCHET VIOLATION — ${RULE} count increased vs baseline:`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error(`\nFix the new sites, or (intentional only) re-record: node scripts/eslint-ratchet.mjs --update`);
  process.exit(1);
}

if (improvements.length) {
  console.log('\nViolations decreased in: ' + improvements.join(', '));
  console.log("Lock it in with: pnpm typecheck:update");
}
console.log('\nRatchet OK — no package exceeded its eslint baseline.');
