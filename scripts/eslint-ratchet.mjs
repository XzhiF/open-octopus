#!/usr/bin/env node
/**
 * eslint ratchet gate — like scripts/tsc-ratchet.mjs, but for ESLint async-correctness rules:
 *   @typescript-eslint/no-floating-promises
 *   @typescript-eslint/await-thenable        (P1 B0.5 新增, §8 网②)
 *   @typescript-eslint/no-misused-promises   (P1 B0.5 新增, §8 网②)
 *
 * A package opts in via the PACKAGES list below; per-rule violation counts
 * may only go DOWN vs .eslint-baseline.json.
 *
 * Baseline shape (per-rule):
 *   { "packages": { "server": { "<rule>": <count>, ... } } }
 * 兼容旧结构：`packages.server: <number>` 视作 { RULES[0]: number }（读取时归一化，--update 落新格式）。
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

// Ratcheted rules (per package; each pinned in the baseline independently).
const RULES = [
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-misused-promises',
];

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : null;

// Packages gated by this ratchet. A new package opts in by: adding a minimal
// eslint.config.mjs (single-rule style, see packages/server) + listing it here.
// (No auto-discovery: web-app ships an unrelated eslint-config-next that doesn't fit this gate.)
const PACKAGES = ['server'];

/** @returns {Record<string, string[]>} rule -> ["file:line:col", ...] */
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
  const hits = Object.fromEntries(RULES.map((r) => [r, []]));
  for (const file of results) {
    for (const m of file.messages) {
      if (m.fatal) {
        // Parse failure — counting would silently under-report; fail loudly instead.
        console.error(`eslint parse failure in ${relative(ROOT, file.filePath)}: ${m.message}`);
        process.exit(1);
      }
      if (m.ruleId && hits[m.ruleId]) {
        hits[m.ruleId].push(`${relative(ROOT, file.filePath)}:${m.line}:${m.column}`);
      }
    }
  }
  return hits;
}

/** 旧结构（number）→ 新结构（per-rule map）。 */
function normalizeBaseline(entry) {
  if (typeof entry === 'number') return { [RULES[0]]: entry };
  return entry ?? {};
}

const units = ONLY ? PACKAGES.filter((p) => ONLY.includes(p)) : PACKAGES;
if (!units.length) {
  console.log('eslint ratchet — no package has an eslint config yet, nothing to check.');
  process.exit(0);
}

let baseline = { note: 'per-package, per-rule eslint violation counts; ratchet: only decreases allowed', packages: {} };
if (existsSync(BASELINE_FILE)) {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  if (!baseline.packages) baseline.packages = {};
}

const current = {};
const failures = [];
const improvements = [];

for (const pkg of units) {
  const ruleHits = countViolations(pkg);
  current[pkg] = Object.fromEntries(RULES.map((r) => [r, ruleHits[r].length]));
  const basePkg = normalizeBaseline(baseline.packages[pkg]);
  console.log(`eslint ratchet — ${pkg} (baseline may only shrink, per rule):`);
  for (const rule of RULES) {
    const n = ruleHits[rule].length;
    const base = basePkg[rule];
    const tag = rule.replace('@typescript-eslint/', '');
    if (UPDATE) {
      console.log(`  ${tag.padEnd(24)} ${String(n).padStart(4)}  recorded`);
      continue;
    }
    if (base === undefined) {
      console.log(`  ${tag.padEnd(24)} ${String(n).padStart(4)}  NO BASELINE  FAIL`);
      failures.push(`${pkg}/${rule}: no baseline entry (current ${n})`);
    } else if (n > base) {
      console.log(`  ${tag.padEnd(24)} ${String(n).padStart(4)}  baseline ${base}  +${n - base}  FAIL`);
      failures.push(`${pkg}/${rule}: ${n} violations, baseline ${base} (+${n - base})`);
      for (const h of ruleHits[rule]) console.log(`      ${h}`);
    } else if (n < base) {
      console.log(`  ${tag.padEnd(24)} ${String(n).padStart(4)}  baseline ${base}  -${base - n}  OK (run 'pnpm typecheck:update' to lock in)`);
      improvements.push(`${pkg}/${rule}: ${base} -> ${n}`);
    } else {
      console.log(`  ${tag.padEnd(24)} ${String(n).padStart(4)}  baseline ${base}  OK`);
    }
  }
}

if (UPDATE) {
  for (const pkg of units) baseline.packages[pkg] = current[pkg];
  baseline.note = 'per-package, per-rule eslint violation counts; ratchet: only decreases allowed';
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nbaseline updated -> ${BASELINE_FILE}`);
  process.exit(0);
}

if (failures.length) {
  console.error('\nRATCHET VIOLATION — eslint violation counts increased vs baseline:');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error(`\nFix the new sites, or (intentional only) re-record: node scripts/eslint-ratchet.mjs --update`);
  process.exit(1);
}

if (improvements.length) {
  console.log('\nViolations decreased in: ' + improvements.join(', '));
  console.log("Lock it in with: pnpm typecheck:update");
}
console.log('\nRatchet OK — no package exceeded its eslint baseline (per rule).');
