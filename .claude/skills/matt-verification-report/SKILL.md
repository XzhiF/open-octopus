---
name: matt-verification-report
description: >
  Implementation truth audit and test authenticity verification. Reads a feature's
  brief, spec, issues, code diff, and test artifacts to produce a confidence-scored
  verification report with GO/NO-GO/REVIEW decision. Tiered depth: static audit by
  default, optional --deep for dynamic mutation-inspired verification.
  Independent tool — callable at any pipeline stage.
---

# Implementation Verification Report

## How to Use

```
/matt-verification-report <artifacts.dir>/<feature-slug>/
/matt-verification-report <artifacts.dir>/<feature-slug>/ --deep
```

- **Default (static)**: Traceability matrix + test authenticity audit + quality gates + confidence score. Fast, no side effects.
- **`--deep`**: Adds mutation-inspired spot checks and live test execution. Slower but more trustworthy.

## When to Use

| Scenario | Depth | Purpose |
|----------|-------|---------|
| Mid-iteration progress check | Default | "How far along are we?" |
| After E2E verification | Default | "Is the pipeline-report truthful?" |
| Before PR merge | `--deep` | "Are tests real or superficial?" |
| Hand-off to another agent | Default | "What's actually done vs claimed?" |
| Post-pipeline audit | `--deep` | "Can we trust this delivery?" |

## Core Principles

1. **Evidence over claims** — a ticket marked "done" is a claim; code + test evidence is truth
2. **Test quality over test quantity** — 10 tautological tests < 3 meaningful ones
3. **Traceability is mandatory** — every requirement must trace to code AND tests
4. **Scoring is transparent** — every number in the report has a visible formula
5. **Decision is advisory** — GO/NO-GO/REVIEW is a recommendation; human decides

## Execution Flow

### Phase A: Artifact Collection

Read ALL available artifacts from `<artifacts.dir>/<feature-slug>/`:

```
Required:
  - brief.md          (requirements, scope, ACs)
  - spec.md           (user stories, verification methods)
  - issues/*.md       (implementation tickets with status)

Optional (use if present):
  - pipeline-report.md (claimed results from pipeline execution)
  - e2e-scripts/*.sh   (actual E2E test scripts)
  - e2e-screenshots/    (browser evidence)
  - e2e-data/           (test data/fixtures)
  - decisions/*.md      (wayfinder decisions)
```

Also collect from the codebase:
```
git diff main...HEAD --stat          (change scope)
git diff main...HEAD --name-only     (changed files)
git log main...HEAD --oneline        (commit history)
```

### Phase B: Requirements Parsing

Parse `spec.md` and `issues/*.md` into **requirement atoms**:

```
For each User Story in spec.md:
  Extract:
    - REQ-ID (e.g., US-001, US-002, ...)
    - Title / description
    - Acceptance Criteria (AC-1, AC-2, ...)
    - Verification Method (from spec's Verification Strategy block)

For each issue in issues/:
  Extract:
    - Issue ID
    - Status (open / in-progress / done / skip)
    - Linked ACs
    - Verification result (PASS / FAIL / SKIP)
```

Build a **requirement inventory table** — this is the foundation for traceability.

### Phase C: Traceability Matrix

For each requirement atom, trace forward and backward:

**Forward traceability** (requirement → code → test):
```
1. Search codebase for REQ-ID references in comments/annotations
2. Search for AC-related function names, API endpoints, UI components
3. Search test files for REQ-ID references in test names/describe blocks
4. Search e2e-scripts/ for test scripts that cover this AC

Classify each requirement:
  COVERED  — code references found AND test references found
  PARTIAL  — code references found but NO test references (or vice versa)
  MISSING  — no code references AND no test references
```

**Backward traceability** (test → requirement):
```
For each test file in the feature's scope:
  1. Parse test descriptions (describe/it/test blocks)
  2. Attempt to link each test to a requirement atom
  3. Flag unlinked tests as "orphan" (gold-plating detection)
```

**Traceability scoring:**
```
traceability_score = covered_requirements / total_requirements × 100

Ratings:
  ≥ 90%: EXCELLENT
  70-89%: ADEQUATE
  < 70%: GAP DETECTED
```

### Phase D: Test Authenticity Audit

Analyze all test files related to this feature (both unit tests and E2E scripts):

#### D1: Assertion Density

```
assertion_density = count(expect|assert calls) / lines_of_test_code

Ratings (based on van Beckhoven research):
  ≥ 0.30: HIGH (strong assertion coverage)
  0.15-0.29: MEDIUM (acceptable for E2E)
  < 0.15: LOW (likely superficial — flag warning)
```

**Per-file breakdown**: Report assertion density for each test file individually.

#### D2: Empty Test Detection

```
Find tests with ZERO expect/assert calls.
These are "smoke-only" or "dead tests" — they execute code but verify nothing.
Flag each as: EMPTY_TEST — file:line — test name
```

#### D3: Tautological Assertion Detection

```
Detect assertions that always pass regardless of implementation:
  - expect(true).toBe(true)
  - expect(x).toBeDefined() without further value checks
  - expect(response.status).toBe(200) without checking response body
  - expect(result).toBeTruthy() where result is always truthy

Flag each as: TAUTOLOGICAL — file:line — assertion text
```

#### D4: Negative Test Ratio

```
negative_ratio = count(error|boundary|invalid tests) / total_tests

For each test, classify:
  POSITIVE — tests happy path (valid input, success response)
  NEGATIVE — tests error path (invalid input, empty state, error response, boundary)

Ratings:
  ≥ 30%: HEALTHY
  20-29%: ACCEPTABLE
  < 20%: HAPPY-PATH-ONLY (flag warning)
```

#### D5: Test Smell Detection

Scan for common test smells:

| Smell | Detection Rule |
|-------|---------------|
| Assertion Roulette | >3 assertions without descriptive failure messages |
| Sleepy Test | Hard-coded `sleep`/`setTimeout` instead of proper waits |
| Mystery Guest | Test depends on external state not visible in test body |
| Duplicate Assert | Same assertion expression in multiple tests |
| Eager Test | Single test touches >3 unrelated modules |

#### D6: E2E Script Authenticity (if e2e-scripts/ exists)

```
For each script in e2e-scripts/:
  1. Check: Does it make real HTTP requests? (not just echo/print)
  2. Check: Does it verify response body? (not just status code)
  3. Check: Does it cross-validate? (API response ↔ DB state ↔ cache)
  4. Check: Does it test error scenarios? (not just happy path)
  5. Check: Does it have real assertions? (grep -c "assert\|expect\|should")

Score each script: AUTHENTIC / SUSPECT / SUPERFICIAL
```

**Test Authenticity composite score:**
```
authenticity_score = (
  assertion_density_score × 0.30 +
  empty_test_score × 0.15 +
  tautological_score × 0.20 +
  negative_ratio_score × 0.20 +
  smell_score × 0.15
) × 100

Where each sub-score is 0.0 to 1.0:
  assertion_density_score: min(density / 0.30, 1.0)
  empty_test_score: 1.0 if 0 empty tests, else 1.0 - (empty / total)
  tautological_score: 1.0 if 0 tautological, else 1.0 - (tautological / total_assertions)
  negative_ratio_score: min(ratio / 0.30, 1.0)
  smell_score: 1.0 - min(smells_found / 10, 1.0)
```

### Phase E: Quality Gate Evaluation

Evaluate each gate independently:

| Gate | Criteria | PASS Threshold | Source |
|------|----------|---------------|--------|
| Spec Completeness | All ACs have verification methods | 100% | spec.md |
| Code Completeness | Requirements with code references | ≥ 90% | Traceability matrix |
| Test Completeness | Requirements with test coverage | ≥ 80% | Traceability matrix |
| Test Authenticity | Assertion density + smell-free | score ≥ 70 | Phase D |
| Build Health | TypeScript compilation | 0 errors | `pnpm build` output or tsc |
| Ticket Resolution | Issues marked done | ≥ 80% done | issues/*.md |

**Gate result**: PASS / WARN (within 10% of threshold) / FAIL

### Phase F: Dynamic Verification (`--deep` only)

Only when `--deep` flag is provided:

#### F1: Live Test Execution

```bash
# Run unit tests
pnpm test 2>&1 | tee /tmp/test-output.log

# Count: passed, failed, skipped, duration
# Parse coverage if available
```

#### F2: Mutation-Inspired Spot Check

Select 2-3 **critical paths** from the spec (prioritize: auth, data mutation, business logic).

For each critical path:
```
1. Identify the key guard/condition/constant in the implementation
2. Create a temporary mutation:
   - Invert a boolean condition (if (x) → if (!x))
   - Change a magic number (limit = 100 → limit = 0)
   - Remove a null check (optional chaining → direct access)
   - Swap an API method (POST → PUT)
3. Run the relevant tests against the mutated code
4. Record: KILLED (tests failed — good) or SURVIVED (tests passed — bad)
5. REVERT the mutation immediately (git checkout -- <file>)
```

**Mutation score**: killed / total mutations × 100

⚠️ **Safety rules**:
- NEVER mutate production code without reverting
- Use `git stash` or `git checkout` to revert after each mutation
- Only mutate files in the feature's diff scope
- Abort if any mutation causes side effects (DB writes, file changes)

#### F3: E2E Re-execution Verification

If `e2e-scripts/` exists:
```bash
# Re-run each E2E script
for script in e2e-scripts/*.sh; do
  bash "$script" 2>&1 | tee "/tmp/e2e-rerun-$(basename $script).log"
done
```

Compare results against the original pipeline-report.md claims.

### Phase G: Confidence Scoring

**Composite confidence score** (weighted formula):

```
confidence = Σ(weight_i × score_i)

Dimensions and weights:
  traceability:       weight = 0.25, score = traceability_score / 100
  test_pass_rate:     weight = 0.25, score = (from pipeline-report or --deep run)
  assertion_density:  weight = 0.20, score = min(density / 0.30, 1.0)
  negative_tests:     weight = 0.15, score = min(negative_ratio / 0.30, 1.0)
  change_risk:        weight = 0.15, score = risk_score (see below)
```

**Change risk scoring:**
```
change_risk_score = 1.0 - risk_factor

risk_factor based on:
  Files changed:   < 10 = 0.0, 10-30 = 0.2, 30-80 = 0.4, > 80 = 0.6
  Sensitive areas: auth/payment/crypto +0.2 each
  New packages:    +0.1 per new dependency
  DB migrations:   +0.1 per migration file

Clamp risk_factor to [0.0, 1.0]
```

**When `--deep` is used, adjust weights:**
```
traceability:       0.20 (reduced)
test_pass_rate:     0.20 (reduced — now from live run)
assertion_density:  0.15 (reduced)
negative_tests:     0.10 (reduced)
mutation_score:     0.20 (NEW — from spot checks)
change_risk:        0.15 (same)
```

**Decision thresholds:**

| Score | Decision | Meaning |
|-------|----------|---------|
| ≥ 85 | **GO** | High confidence — safe to proceed |
| 70-84 | **REVIEW** | Moderate confidence — human should review gaps |
| < 70 | **NO-GO** | Low confidence — significant gaps or authenticity issues |

### Phase H: Report Generation

Write the report to `.scratch/<feature-slug>/verification-report.md`.

## Report Template

```markdown
# Verification Report: <feature-slug>

Generated: <timestamp>
Commit: <git-hash>
Branch: <branch-name>
Mode: static | deep
Artifacts: <artifacts.dir>/<feature-slug>/

---

## Executive Summary

| Metric | Value |
|--------|-------|
| **Confidence Score** | **<score>/100** |
| **Decision** | **<GO / REVIEW / NO-GO>** |
| Requirements Traced | <covered>/<total> (<pct>%) |
| Test Authenticity | <score>/100 |
| Quality Gates | <passed>/<total> passed |
| Top Risk | <primary risk factor> |

---

## 1. Requirements Traceability Matrix

| REQ-ID | Requirement | Code Ref | Test Ref | Status |
|--------|-------------|----------|----------|--------|
| US-001 | <title> | ✅ file.ts | ✅ test.ts | COVERED |
| US-002 | <title> | ✅ file.ts | ❌ — | PARTIAL |
| US-003 | <title> | ❌ — | ❌ — | MISSING |

**Coverage**: <covered>/<total> (<pct>%)

### Unimplemented Requirements
- <list any MISSING or PARTIAL requirements>

### Orphan Tests (no requirement link)
- <list any tests not traceable to a requirement>

---

## 2. Test Authenticity Audit

### 2.1 Assertion Analysis

| File | Lines | Assertions | Density | Rating |
|------|-------|-----------|---------|--------|
| test/file-a.test.ts | 120 | 45 | 0.375 | HIGH |
| test/file-b.test.ts | 80 | 8 | 0.100 | LOW ⚠️ |

**Overall assertion density**: <density> (<rating>)

### 2.2 Issues Detected

| Type | File | Line | Detail |
|------|------|------|--------|
| EMPTY_TEST | test/x.test.ts | 42 | Test has zero assertions |
| TAUTOLOGICAL | test/y.test.ts | 15 | expect(x).toBeDefined() — no value check |
| HAPPY_PATH_ONLY | test/z.test.ts | — | 0 negative tests out of 8 total |
| SLEEPY_TEST | e2e/a.sh | 23 | Hard-coded sleep 3000ms |

### 2.3 Negative Test Coverage

- Positive tests: <n>
- Negative tests: <n>
- **Negative ratio**: <pct>% (<rating>)

### 2.4 Test Smells

| Smell | Count | Severity |
|-------|-------|----------|
| Assertion Roulette | <n> | MEDIUM |
| Empty Test | <n> | HIGH |
| Duplicate Assert | <n> | LOW |
| Sleepy Test | <n> | MEDIUM |

**Authenticity score**: <score>/100

---

## 3. E2E Script Audit (if e2e-scripts/ exists)

| Script | Real Requests | Body Checks | Cross-Validates | Error Tests | Rating |
|--------|:------------:|:-----------:|:---------------:|:-----------:|--------|
| 001-create.sh | ✅ | ✅ | ❌ | ❌ | SUSPECT |
| 002-update.sh | ✅ | ✅ | ✅ | ✅ | AUTHENTIC |

---

## 4. Quality Gate Results

| Gate | Criteria | Threshold | Actual | Result |
|------|----------|-----------|--------|--------|
| Spec Completeness | ACs have verification methods | 100% | <pct>% | PASS/FAIL |
| Code Completeness | Requirements with code refs | ≥ 90% | <pct>% | PASS/FAIL |
| Test Completeness | Requirements with test refs | ≥ 80% | <pct>% | PASS/FAIL |
| Test Authenticity | Composite authenticity score | ≥ 70 | <score> | PASS/FAIL |
| Build Health | TypeScript compilation | 0 errors | <n> | PASS/FAIL |
| Ticket Resolution | Issues marked done | ≥ 80% | <pct>% | PASS/FAIL |

---

## 5. Confidence Score Breakdown

| Dimension | Weight | Score | Weighted |
|-----------|--------|-------|----------|
| Traceability | 25% | <score> | <w×s> |
| Test Pass Rate | 25% | <score> | <w×s> |
| Assertion Density | 20% | <score> | <w×s> |
| Negative Tests | 15% | <score> | <w×s> |
| Change Risk | 15% | <score> | <w×s> |
| **Total** | **100%** | | **<confidence>** |

---

## 6. Dynamic Verification (--deep only, omit if static)

### 6.1 Live Test Execution
- Total: <n> | Passed: <n> | Failed: <n> | Skipped: <n>
- Duration: <time>
- Coverage: <line>% line, <branch>% branch

### 6.2 Mutation Spot Checks

| Path | Mutation | Result | Detail |
|------|----------|--------|--------|
| <function> | Inverted condition | KILLED ✅ | Tests caught the change |
| <function> | Changed constant | SURVIVED ❌ | Tests missed — superficial coverage |

**Mutation score**: <killed>/<total> (<pct>%)

### 6.3 E2E Re-execution
- Scripts re-run: <n>
- Results match pipeline-report: YES/NO
- Discrepancies: <list>

---

## 7. Gap Analysis

### 7.1 Requirements Gaps (asked but not built)
- <list>

### 7.2 Testing Gaps (built but not tested)
- <list>

### 7.3 Authenticity Gaps (tested but superficially)
- <list>

---

## 8. Risk Factors (Top 3)

1. **<risk>** — <impact> — <mitigation>
2. **<risk>** — <impact> — <mitigation>
3. **<risk>** — <impact> — <mitigation>

---

## 9. Decision

**<GO / REVIEW / NO-GO>** — Confidence <score>/100

### Recommendation
<1-2 sentences explaining the decision and what should happen next>

### Required Actions Before Proceeding
1. <action item>
2. <action item>
3. <action item>
```

## Integration with Pipeline

This skill is **independent** — it does not modify the pipeline flow. However:

1. **matt-dev-pipeline Phase 5** MAY invoke this skill before creating a PR:
   ```
   Phase 4 (E2E) complete → invoke matt-verification-report → 
     GO: proceed to Phase 5 (Ship)
     REVIEW: warn user, let them decide
     NO-GO: stop and report gaps
   ```

2. **Pipeline-report.md** is a **claimed** result; this report is a **verified** result. When both exist, cross-reference them.

3. **Action items** from this report can be fed back to `matt-dev-runner` for remediation.

## Scoring Calibration Notes

The confidence thresholds (85/70) are starting points. Calibrate after 5-10 uses:
- If GO decisions consistently lead to clean PRs → thresholds are appropriate
- If REVIEW decisions frequently find real issues → raise the REVIEW threshold
- If NO-GO decisions are always overridden by the user → lower the NO-GO threshold

## Anti-Patterns to Avoid

1. **Trusting ticket status blindly** — "done" is a claim, not evidence
2. **Counting test files without reading them** — 20 test files with 0 assertions = 0 value
3. **Skipping traceability** — code coverage without requirement linkage is meaningless
4. **Ignoring negative tests** — happy-path-only suites miss 60%+ of production bugs
5. **Running deep mode on incomplete features** — wait until implementation is reasonably complete
6. **Treating the score as absolute** — confidence score is a heuristic, not a guarantee

## Glossary

| Term | Meaning |
|------|---------|
| Traceability | Bidirectional link: requirement ↔ code ↔ test |
| Assertion Density | Assertions per line of test code (≥ 0.22 is healthy) |
| Tautological Test | Test that always passes regardless of implementation |
| Mutation Score | % of injected bugs caught by tests |
| Quality Gate | Configurable checkpoint with pass/fail criteria |
| Confidence Score | Weighted composite of all verification dimensions |
| Orphan Test | Test with no traceable requirement (gold-plating) |
| Negative Test | Test that verifies error/boundary/invalid behavior |
| Spot Check | Targeted mutation test on a critical code path |

## Relationship to Other Skills

| Skill | Relationship |
|-------|-------------|
| matt-verified-requirement | Upstream — provides the brief this skill audits against |
| matt-verified-spec | Upstream — provides the spec with ACs and verification methods |
| matt-verified-tickets | Upstream — provides the issues with status and verification results |
| matt-dev-runner | Downstream — can receive action items for remediation |
| matt-e2e-tester | Peer — this skill audits e2e-tester's output for authenticity |
| matt-dev-pipeline | Integrator — may invoke this skill as a gate before Phase 5 |
| matt-e2e-test-methodology | Reference — R1-R8 anti-fake-run standards inform authenticity checks |
