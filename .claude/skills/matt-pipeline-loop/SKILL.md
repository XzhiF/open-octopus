---
name: matt-pipeline-loop
description: >
  Verification-driven iteration orchestrator. Reads a feature's verification-report,
  generates a gap-focused brief for the next iteration, invokes matt-dev-pipeline,
  and loops until confidence score ≥ 85 (GO) or hard stops are hit.
  Each iteration creates a new feature-slug (-r2, -r3, ...) with independent artifacts.
  Based on Anthropic EDD, Shumer Gauntlet, and Loop Engineering patterns.
  Anti-fake-convergence safeguards. Full pipeline re-execution per iteration.
  Carryover tracking ensures SKIP/PARTIAL ACs from previous rounds must reach PASS before convergence.
---

# Pipeline Loop — Verification-Driven Iteration Orchestrator

## How to Use

```
/matt-pipeline-loop <artifacts.dir>/<feature-slug>/
/matt-pipeline-loop <artifacts.dir>/<feature-slug>/ --max 3
/matt-pipeline-loop <artifacts.dir>/<feature-slug>/ --deep
```

- **Default**: Static verification per iteration, max 5 iterations
- **`--max N`**: Override max iterations
- **`--deep`**: Use deep verification (mutation spot checks) on final iteration

## When to Use

| Scenario | Purpose |
|----------|---------|
| After first pipeline run shows gaps | "Keep iterating until it's truly done" |
| Feature with complex UI | "Don't stop until the frontend actually works" |
| High-stakes delivery | "Loop until confidence is high enough to merge" |
| Catching up on tech debt | "Fix all the test gaps from previous features" |

## Core Principles

1. **Closed loop** — every iteration is verified; no iteration is trusted without evidence
2. **Fresh critic** — each verification-report uses a new analysis pass, never reuses stale claims
3. **Gap-focused** — each iteration's brief targets ONLY what failed, not the entire feature
4. **Progress on disk** — iteration state lives in `.scratch/` directories and git, not in conversation memory
5. **Bounded** — max iterations + no-progress detection + budget ceiling prevent infinite loops
6. **Auto-continue** — when score < convergence threshold, IMMEDIATELY generate gap brief and launch next iteration. Do NOT ask the user whether to continue. Only stop and present to user when: converged (GO), max reached, stalled, or regression detected.
7. **Context hygiene** — compact between iterations, not during. Write protected context to disk before compact, re-read after. The smart zone (~120k tokens) is the ceiling; don't let accumulated implementation details degrade reasoning quality.
8. **No partial credit** — tests written but not executed = 0% for that AC. "Written" ≠ "verified." Only execution evidence counts.
9. **Full pipeline mandatory** — each iteration must produce spec.md + issues/ + pipeline-report.md. A round with only brief.md + verification-report.md is INVALID.
10. **SKIP = hard block** — any AC with status SKIP blocks convergence, regardless of score. SKIP ACs become P0 targets.

## Carryover Tracking

Each iteration tracks which ACs were not PASS in the previous round.

### Carryover List
After reading the verification-report, extract all ACs that are:
- **SKIP** → P0 gap target (must fix, blocks convergence)
- **PARTIAL** → P1 gap target (must reach PASS, blocks convergence if critical)
- **FAIL** → P0 gap target (regression, must fix)

### Carryover File
Write `<artifacts.dir>/<feature-slug>/carryover.md`:
```
| AC# | Previous Status | Round Found | Round Fixed | Current Status |
|-----|----------------|-------------|-------------|---------------|
| AC-14 | SKIP | R1 | — | — |
| AC-6 | PARTIAL | R1 | R2 | PASS |
```

### Convergence Rule
Before checking score ≥ 85, verify ALL carryover ACs from the carryover list
are now PASS. Any carryover AC still SKIP/PARTIAL/FAIL → block convergence,
regardless of score.

## Theoretical Foundations

| Source | Pattern | How We Apply It |
|--------|---------|----------------|
| Anthropic EDD | Define → Develop → Conduct → Analyze → Improve cycle | Each iteration = one full EDD cycle |
| Matt Shumer Gauntlet | Builder vs Critic with fresh context | Pipeline builds, verification-report critiques with fresh eyes |
| Loop Engineering | Trigger → Scope → Action → Budget → Stop → Report | The 5-element loop contract |
| Ralph Loop | Fixed anchor files, one task per iteration, BLOCKED detection | Gap brief = one focused task per iteration |
| Walking Skeleton | End-to-end thin slice first, then thicken | Iteration 1 = full stack skeleton; later iterations thicken weak layers |
| Vibe Coding Research | "80-90% fast, last 10% hard" + context momentum | Gap brief breaks context momentum by forcing fresh scope |
| Smart Zone / Context Hygiene | ~120k token ceiling for sharp reasoning; compact between phases | Step 6.5 compact + handoff prevents context degradation across iterations |

## Execution Flow

```
INPUT: .scratch/<feature-slug>/  (must have pipeline-report.md or verification-report.md)
    │
    ▼
┌─────────────────────────────────────────────────┐
│  LOOP START                                      │
│                                                  │
│  1. Read latest iteration's artifacts             │
│  2. Run matt-verification-report (if not exists)  │
│     └── Validate pipeline completeness            │
│  3. Check convergence (5 layers):                 │
│     ├── L1: Pipeline completeness                 │
│     ├── L2: Carryover clearance                   │
│     ├── L3: No SKIP ACs                           │
│     ├── L4: E2E execution evidence                │
│     ├── L5: Score ≥ 85 (adjusted)                 │
│     ├── iteration ≥ max → EXIT (MAX_REACHED)     │
│     ├── 2 rounds no improvement → EXIT (STALLED) │
│     ├── score decreased → EXIT (REGRESSION)       │
│     └── else → CONTINUE                          │
│                                                  │
│  4. Generate gap brief (with carryover section)   │
│  5. Invoke matt-dev-pipeline (full 5 phases)      │
│  6. Record iteration results                      │
│  6.5 Context hygiene:                            │
│     ├── Write iteration-handoff.md               │
│     ├── Commit artifacts                         │
│     ├── /compact (summarize conversation)         │
│     └── Re-read loop-state + gap-brief + handoff │
│  7. Go to step 1                                  │
│                                                  │
└─────────────────────────────────────────────────┘
    │
    ▼
OUTPUT: Final verification-report.md with GO/STALLED/MAX_REACHED
       + iteration history summary
```

## Detailed Steps

### Step 1: Initialize Loop State

Create or read the loop tracking file:

**File**: `<artifacts.dir>/<feature-slug>/loop-state.json`

```json
{
  "root_feature": "chatbot-workflow-design",
  "branch": "feat/interaction-node",
  "iterations": [
    {
      "round": 1,
      "score": 81,
      "adjusted_score": 81,
      "decision": "REVIEW",
      "carryover_in": [],
      "carryover_out": ["AC-6", "AC-7", "AC-14"],
      "pipeline_complete": true,
      "e2e_executed": false
    }
  ],
  "max_iterations": 5,
  "convergence_threshold": 85,
  "status": "running"
}
```

If the file doesn't exist, create it with round 1 from the current feature.

### Step 2: Run Verification Report

If the current iteration doesn't have a `verification-report.md`:

```
Invoke: /matt-verification-report <current-feature-dir>/
(or --deep on the final iteration if --deep flag is set)
```

Parse the report to extract:
- Confidence score (numeric)
- Decision (GO / REVIEW / NO-GO)
- Quality gate results (PASS / FAIL per gate)
- Gap analysis (specific items from section 6)
- Risk factors (top 3)

#### Pipeline Completeness Check
Before trusting the verification-report score, verify the iteration produced full pipeline artifacts:
- [ ] `spec.md` exists (not just brief.md)
- [ ] `issues/` directory exists with tickets
- [ ] `pipeline-report.md` exists with all 5 phases documented
- [ ] Phase 4 (E2E) section in pipeline-report has actual test execution results

If ANY check fails → iteration is INVALID. Do NOT use the score.
Generate a gap brief targeting the missing pipeline phases and re-run.

### Step 3: Convergence Check (5 layers)

Check in order. ANY failure blocks convergence.

#### Layer 1: Pipeline Completeness
All 5 phases produced artifacts (see Step 2 validation above).

#### Layer 2: Carryover Clearance
All carryover ACs from previous rounds are now PASS.

#### Layer 3: No SKIP ACs
Zero ACs with status SKIP in the latest verification-report.

#### Layer 4: E2E Execution Evidence
Browser E2E tests (if any exist in the spec) have execution evidence:
- Playwright ran against a real browser (screenshots or test output logs)
- NOT just "tests written" (code existence ≠ verification)

#### Layer 5: Score Threshold
Confidence score ≥ 85 (after applying scoring overrides, see below).

#### Exit Conditions
| Condition | Action |
|-----------|--------|
| All 5 layers pass | **GO** — loop ends successfully |
| Layer 1-4 fail | **NO-GO** — generate gap brief targeting failures |
| Layer 5 fail but 1-4 pass | **REVIEW** — present to user with report |
| iteration ≥ max (default 5) | **MAX_REACHED** — present to user with full report |
| 2 consecutive rounds < 5pt improvement | **STALLED** — present to user |
| Score decreases from previous round | **REGRESSION** — present to user immediately |

**No-progress detection**: If the same specific gap appears in 2+ consecutive iterations without improvement, flag it as BLOCKED and exclude from the next gap brief (don't waste iterations on unfixable items).

## Scoring Override Rules

The loop applies these overrides to the verification-report score before convergence checks:

| Condition | Override |
|-----------|----------|
| Any AC: "tests written but not executed" | That AC = 0%, not 50% |
| Browser E2E tests exist but never ran | Browser E2E gate = FAIL, not PARTIAL |
| pipeline-report.md missing | Iteration invalid, adjusted score = 0 |
| Phase 4 skipped or incomplete | E2E dimension = 0% |

After overrides, recalculate the weighted total. Use the **adjusted score**
for Layer 5 (Score Threshold) convergence check.

Record both scores in loop-state.json: `"score": 88, "adjusted_score": 78`

### Step 4: Generate Gap Brief

This is the **core intelligence** of the loop. The gap brief is NOT a copy of the original brief — it's a surgical strike targeting only what failed.

**New feature slug**: `<root-feature>-r<N>` (e.g., `chatbot-workflow-design-r2`)

**Gap Brief Template**:

```markdown
# Requirement Brief — <root-feature> Iteration <N>

## Overview
Gap-fix iteration for <root-feature>. This iteration targets ONLY the gaps
identified in the previous verification report.

## Context
- Root feature: <root-feature>
- Previous iteration: <prev-feature-slug>
- Previous score: <score>/100 (adjusted: <adjusted_score>/100)
- Previous decision: <NO-GO/REVIEW>
- Branch: <same-branch> (all iterations share the same git branch)

## Carryover from Previous Rounds

| AC# | Status | Round | Priority |
|-----|--------|-------|----------|
| AC-14 | SKIP | R1 | P0 |
| AC-6 | PARTIAL | R1 | P1 |

## Gap Targets

### Gap 1: <gap-title>
**What failed**: <specific description from verification-report section 6>
**Why it matters**: <risk/impact>
**Required fix**: <concrete action items>
**Verification**: <how to verify this gap is closed>

### Gap 2: <gap-title>
...

## Prerequisites (mandatory when E2E gaps exist)
- Server must be running: `pnpm dev --isolated` (server:3001, web:3000)
- If prerequisites cannot be met, gap brief must include a "start dev server" task

## Feature Scope
**Do:**
- <only gap-fix items>

**Don't:**
- Do NOT modify working code from previous iterations
- Do NOT add new features beyond the gaps
- Do NOT refactor unless the gap requires it

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Scope | Gap-fix only | Minimize regression risk |

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| G1 | <gap from prev iteration> | <specific AC> | <verification> |

## Verification Strategy
### Global Config
- Environment: same as root feature
- Test user: same as root feature

### Per-layer Methods
<Only methods relevant to the gaps>

### Previous Iteration Evidence
Link to previous verification-report: <path>

---

> **Execution requirement**: All tests MUST be executed, not just written.
> Tests written but not executed = 0% credit. Pipeline must produce execution
> evidence (test output, screenshots, DB queries).
```

**Gap Brief Generation Rules**:

1. **Parse verification-report section 6 (Gap Analysis)** for specific items
2. **Parse verification-report section 4 (Quality Gates)** for FAIL gates
3. **Map gaps to brief sections**:
   - "Requirements Gaps" → new ACs in gap brief
   - "Testing Gaps" → new test tickets in gap brief
   - "Authenticity Gaps" → new test quality tickets
4. **Carry forward context**: reference the root brief for data model, API contracts
5. **Exclude working areas**: explicitly list what NOT to touch
6. **Preserve branch**: all iterations work on the same git branch

### Mandatory Gap Brief Sections

#### Carryover Section
List ALL ACs not PASS from previous rounds:
| AC# | Status | Round | Priority |
|-----|--------|-------|----------|
| AC-14 | SKIP | R1 | P0 |

#### Prerequisites Section (mandatory when E2E gaps exist)
- Server must be running: `pnpm dev --isolated` (server:3001, web:3000)
- If prerequisites cannot be met, gap brief must include a "start dev server" task

#### Anti-Fake-Run Clause (always included)
> **Execution requirement**: All tests MUST be executed, not just written.
> Tests written but not executed = 0% credit. Pipeline must produce execution
> evidence (test output, screenshots, DB queries).

### Step 5: Invoke Pipeline

```
Invoke: /matt-dev-pipeline <artifacts.dir>/<root-feature>-r<N>/
```

The pipeline runs its normal 5 phases (Development → Code Review → Deploy → E2E → Ship) on the gap-focused brief.

#### Mandatory Full Pipeline
Each iteration MUST invoke `matt-dev-pipeline` with the gap spec.
The pipeline runs ALL 5 phases — no skipping phases.

#### Phase 3 Prerequisite Validation
Before Phase 4 (E2E), the pipeline must check:
- Server running on port 3001? → if not, run `pnpm dev --isolated` in background
- Web-app running on port 3000? → wait for Next.js startup (max 60s)
- If either fails → log prerequisite failure, block convergence

**Never skip the pipeline.** An iteration producing only brief.md + verification-report.md
is incomplete and invalid.

### Step 6: Record Iteration

After the pipeline completes:

1. Run `matt-verification-report` on the new iteration
2. Update `loop-state.json` with the new iteration's results
3. Update `<artifacts.dir>/index.md` with the new feature-slug
4. Check convergence (Step 3)

### Step 6.5: Context Hygiene (Post-Iteration Compact)

**When**: After every completed iteration (Step 6), BEFORE starting the next loop cycle.
**Why**: Each iteration accumulates ~50-80k tokens of implementation details (sub-agent results, code-review reports, E2E logs, file reads). After 2-3 iterations the context approaches the smart zone ceiling and reasoning quality degrades. Compacting between iterations resets this — safely, because all essential state is already on disk.
**Rule**: Compact BETWEEN iterations, never DURING. Mid-iteration compact loses implementation context the agent needs to finish the current pipeline.

#### 6.5.1 Write Iteration Handoff

Write `<artifacts.dir>/<current-feature-slug>/iteration-handoff.md`. This file captures context that `/compact` would lose but the next iteration needs:

```markdown
# Iteration Handoff — <feature-slug> Round <N>

## Loop Position
- Round: <N> / <max>
- Score: <score>/100 (adjusted: <adjusted_score>/100) (<decision>)
- Next feature-slug: <root-feature>-r<N+1>
- Branch: <branch-name>

## Protected Architecture Decisions
<!-- These MUST survive compact — the gap-fix iteration must not contradict them -->

| # | Decision | Conclusion | Source |
|---|---------|-----------|--------|
| A1 | <e.g. Data model> | <e.g. SQLite with JSON columns> | <root-brief path> |
| A2 | <e.g. API contract> | <e.g. REST + SSE, no WebSocket> | <spec.md path> |
| A3 | <e.g. State management> | <e.g. Zustand, not Redux> | <ADR path if any> |

## Confirmed Interfaces (Do NOT Change)
<!-- Interfaces that passed verification — gap-fix must not break these -->

| Interface | Location | Verified In |
|-----------|----------|-------------|
| <e.g. GET /api/workflows> | <file:line> | Round <N> verification |
| <e.g. WorkflowNode type> | <file:line> | Round <N> code-review |

## Gap Targets for Next Iteration
<!-- Extracted from verification-report section 6 -->

1. <gap-1>: <one-line description>
2. <gap-2>: <one-line description>

## BLOCKED Gaps (Excluded from Next Iteration)
<!-- Gaps that persisted 2+ rounds without improvement -->

- <blocked-gap>: <reason it's blocked>

## Carryover List
<!-- ACs still not PASS from previous rounds -->

| AC# | Status | Round Found | Priority |
|-----|--------|-------------|----------|
| AC-14 | SKIP | R1 | P0 |

## Prerequisite Status
- Dev server running: <yes/no>
- E2E actually executed: <yes/no>
- E2E execution evidence: <path to screenshots/logs or "none">

## Pipeline Completeness
- All 5 phases produced artifacts: <yes/no>
- Missing phases: <list or "none">

## Key File Paths
- Root brief: <path>
- Current gap brief: <path>
- Spec: <path>
- Loop state: <path>
- Verification report: <path>
- Pipeline report: <path>
- Carryover: <path>

## What Worked (Do Not Re-implement)
<!-- Components that passed verification — next iteration must NOT touch these -->

- <component-1>: <why it's stable>
- <component-2>: <why it's stable>
```

#### Handoff Additions
The handoff file must also include:
- Carryover list (which ACs are still not PASS)
- Prerequisite status (was dev server running? was E2E actually executed?)
- Pipeline completeness (did all 5 phases produce artifacts?)

#### 6.5.2 Commit Artifacts

Ensure all iteration artifacts are on disk and committed before compacting:

```bash
git add <artifacts.dir>/
git commit -m "chore: iteration <N> artifacts + handoff"
```

#### 6.5.3 Invoke Compact

> ⚠️ **CHECKPOINT — You MUST invoke `/compact` now.**
> Do NOT skip this step. Do NOT proceed to the next iteration without compacting.
> The handoff file (6.5.1) and git commit (6.5.2) are already done — it is safe to compact.

```
/compact
```

This summarizes the conversation, discarding implementation details from the completed iteration. The handoff file preserves all critical context.

#### 6.5.4 Selective Context Re-load

After compact, re-read ONLY what the next iteration needs. **Do NOT re-read the full spec.md or pipeline-report.md** — they are large files that waste context.

**Always load** (~20k tokens total):

| File | Purpose | Size |
|------|---------|------|
| `loop-state.json` | Current round, scores, carryover | ~1k |
| Latest `iteration-handoff.md` | Protected decisions, confirmed interfaces | ~3k |
| `carryover.md` | Which ACs still not PASS from previous rounds | ~1k |
| Next iteration's gap brief/spec | Scope of work for next round | ~5k |
| Root `spec.md` — **relevant sections only** | Only the sections that relate to gap ACs | ~10k |

**How to load spec.md selectively**:
Instead of reading the full spec, read only:
1. The `## Acceptance Criteria` table (to know all ACs)
2. The `## Verification Strategy` section (to know how to verify)
3. Any `## Implementation Decisions` or `## API Contracts` sections that relate to the gap ACs

**Do NOT load** (waste context):
- Full `pipeline-report.md` from previous rounds (hundreds of lines of test output)
- Previous rounds' `issues/` tickets (already implemented, no longer needed)
- E2E screenshots or test logs (evidence is summarized in verification-report)
- Code review findings from previous rounds (already addressed)

#### 6.5.5 Verify Context Restoration

Print a 4-line sanity check confirming the agent is oriented:

```
📍 Round <N+1>/<max> | Score: <prev-score>/100 (adjusted: <adjusted-score>) | Branch: <branch>
🎯 Gap targets: <gap-1>, <gap-2>, <gap-3>
🔄 Carryover: <N> ACs still not PASS (<AC-14>, <AC-15>, ...)
📂 Artifacts: <artifacts.dir>/<next-feature-slug>/
```

If the sanity check reveals missing context (e.g. gap targets don't match verification-report), re-read the relevant files before proceeding.

## Gap Classification and Priority

Not all gaps are equal. The loop prioritizes gaps by impact:

| Priority | Gap Type | Example | Iteration Strategy |
|----------|----------|---------|-------------------|
| **P0** | BLOCKED functionality | "Frontend component not registered" | Fix first — blocks user value |
| **P0** | SKIP AC | "E2E tests skipped — never executed" | Fix first — blocks convergence |
| **P0** | Regression | "AC was PASS, now FAIL" | Fix first — something broke |
| **P1** | Missing verification | "Zero tests for core service" | Fix second — safety net |
| **P2** | Stale artifacts | "E2E scripts validate deleted architecture" | Fix third — false confidence |
| **P3** | Quality improvement | "Assertion density below threshold" | Fix last — polish |

**Per-iteration budget**: Target 3-5 gap items per iteration. More = context overload. Fewer = too slow.

## Iteration History Tracking

### Loop State File

`<artifacts.dir>/<feature-slug>/loop-state.json` tracks all iterations:

```json
{
  "root_feature": "chatbot-workflow-design",
  "branch": "feat/interaction-node",
  "iterations": [
    {
      "round": 1,
      "score": 50,
      "adjusted_score": 50,
      "decision": "NO-GO",
      "carryover_in": [],
      "carryover_out": ["AC-6", "AC-7", "AC-14"],
      "pipeline_complete": true,
      "e2e_executed": false
    },
    {
      "round": 2,
      "score": 72,
      "adjusted_score": 72,
      "decision": "REVIEW",
      "carryover_in": ["AC-6", "AC-7", "AC-14"],
      "carryover_out": ["AC-14"],
      "pipeline_complete": true,
      "e2e_executed": true
    },
    {
      "round": 3,
      "score": 88,
      "adjusted_score": 78,
      "decision": "REVIEW",
      "carryover_in": ["AC-14"],
      "carryover_out": ["AC-14"],
      "pipeline_complete": true,
      "e2e_executed": true
    }
  ],
  "max_iterations": 5,
  "convergence_threshold": 85,
  "status": "running"
}
```

### Index.md Integration

Each iteration is recorded in `<artifacts.dir>/index.md`:

```markdown
| # | feature-slug | Created | Branch | Status |
|---|-------------|---------|--------|--------|
| 19 | chatbot-workflow-design | 2026-08-01 | feat/interaction-node | done |
| 20 | chatbot-workflow-design-r2 | 2026-08-01 | feat/interaction-node | done (gap-fix: tests) |
| 21 | chatbot-workflow-design-r3 | 2026-08-01 | feat/interaction-node | done (gap-fix: negative tests) |
```

### Final Summary

When the loop exits, append a summary to the root feature's directory:

**File**: `<artifacts.dir>/<root-feature>/loop-summary.md`

```markdown
# Loop Summary — <root-feature>

## Iteration History

| Round | Feature Slug | Score | Adjusted | Decision | Key Fix |
|-------|-------------|-------|----------|----------|---------|
| 1 | chatbot-workflow-design | 50 | 50 | NO-GO | Initial implementation |
| 2 | chatbot-workflow-design-r2 | 72 | 72 | REVIEW | Added unit tests for 5 modules |
| 3 | chatbot-workflow-design-r3 | 88 | 78 | REVIEW | Added negative tests, E2E not fully executed |

## Convergence
- Final score: 88/100 (adjusted: 78/100)
- Total iterations: 3
- Status: REVIEW (Layer 5 failed on adjusted score)
- Duration: <time>

## Score Progression
50 → 72 (+22) → 88 (+16)
Adjusted: 50 → 72 (+22) → 78 (+6)

## Carryover History
| AC# | First Seen | Final Status | Rounds to Fix |
|-----|-----------|-------------|---------------|
| AC-6 | R1 | PASS | 2 |
| AC-7 | R1 | PASS | 2 |
| AC-14 | R1 | SKIP | — (still open) |

## Remaining Items
<Any items that were BLOCKED or deferred>
```

## Hard Stops (Anti-Infinite-Loop)

| Stop Condition | Detection | Action |
|---------------|-----------|--------|
| **Max iterations** | `iteration_count ≥ max_iterations` | Exit with MAX_REACHED, report current score |
| **No progress** | 2 consecutive rounds with < 5 point improvement | Exit with STALLED, report blocked gaps |
| **Score regression** | Current score < previous score | Exit with REGRESSION, flag what got worse |
| **Budget exhaustion** | User-specified token/cost limit reached | Exit with BUDGET_EXHAUSTED |

## Integration with Other Skills

```
matt-verified-requirement → spec.md (initial)
         │
         ▼
    ┌─────────────────────────────┐
    │  matt-pipeline-loop         │
    │                             │
    │  ┌─ matt-dev-pipeline ──┐   │
    │  │  Phase 1-5 (full)    │   │
    │  └──────────────────────┘   │
    │         │                    │
    │  ┌─ matt-verification- ─┐   │
    │  │  report (audit)      │   │
    │  └──────────────────────┘   │
    │         │                    │
    │  5-Layer Check:              │
    │  L1-L4 pass + L5 ≥ 85?     │
    │         │                    │
    │     NO ──→ Generate gap      │
    │            brief + carryover │
    │            New slug (-r2)    │
    │            Loop back ────┘   │
    │         │                    │
    │    YES ──→ Write summary     │
    │            EXIT (GO)         │
    └─────────────────────────────┘
```

## Anti-Patterns to Avoid

1. **Re-implementing what works** — gap brief must NOT include working areas; only target failures
2. **Growing scope** — each iteration should be SMALLER than the previous, not larger
3. **Ignoring BLOCKED items** — if a gap persists 2+ rounds, mark BLOCKED and move on
4. **Blindly trusting previous reports** — each verification-report must be a fresh analysis
5. **Changing branches** — all iterations must stay on the same git branch
6. **Skipping verification** — never skip the verification-report between pipeline runs
7. **Compacting mid-iteration** — never `/compact` while a pipeline phase is running. The agent loses implementation context and can't finish the current iteration. Compact ONLY between iterations (Step 6.5)
8. **Compacting without handoff** — never `/compact` without first writing `iteration-handoff.md`. Compact without protected context = amnesia about architecture decisions and confirmed interfaces
9. **Fake convergence** — never accept a score at face value without checking all 5 convergence layers. A score of 88 with SKIP ACs or unexecuted E2E tests is NOT a GO
10. **Partial credit for unexecuted tests** — tests written but not run = 0%. Code existence is not verification evidence
11. **Incomplete pipeline runs** — an iteration that produces only brief.md + verification-report.md without spec.md + issues/ + pipeline-report.md is INVALID

## Glossary

| Term | Meaning |
|------|---------|
| Gap Brief | A focused brief targeting only the failures from the previous iteration |
| Iteration | One complete pipeline run (dev → review → deploy → E2E → ship → verify) |
| Convergence | All 5 layers pass: pipeline complete, carryover cleared, no SKIPs, E2E executed, adjusted score ≥ 85 |
| Carryover | ACs from previous rounds that were not PASS and must be tracked until resolved |
| Adjusted Score | Score after applying scoring override rules (penalizes unexecuted tests and incomplete pipelines) |
| Stall | Two consecutive rounds with < 5 point score improvement |
| Regression | Score decreasing between rounds (something got worse) |
| Loop State | JSON file tracking all iteration results and metadata |
| Root Feature | The original feature-slug that started the loop |
| Iteration Handoff | Markdown file capturing protected context (decisions, interfaces, paths) before compact |
| Context Hygiene | Discipline of compacting between iterations with handoff write → compact → re-read cycle |
| Fake Convergence | When a loop appears to converge (high score) but underlying gaps are masked by partial credit or skipped phases |

## Relationship to Other Skills

| Skill | Relationship |
|-------|-------------|
| matt-verified-requirement | Upstream — produces the initial spec.md |
| matt-dev-pipeline | Inner loop — called per iteration |
| matt-verification-report | Gate — called after each iteration to score |
| matt-dev-runner | Indirect — called by pipeline within each iteration |
| matt-e2e-tester | Indirect — called by pipeline within each iteration |

## Artifacts Produced Per Iteration

| Artifact | Path | Purpose |
|----------|------|---------|
| `loop-state.json` | `<root-feature>/` | Loop control state (rounds, scores, carryover, gaps) |
| `carryover.md` | `<root-feature>/` | Tracking ACs not PASS across rounds |
| `brief.md` | `<feature-rN>/` | Gap-focused brief for this iteration |
| `spec.md` | `<feature-rN>/` | Synthesized spec (by matt-dev-runner) |
| `issues/` | `<feature-rN>/` | DAG-structured tickets for the iteration |
| `pipeline-report.md` | `<feature-rN>/` | 5-phase execution report |
| `verification-report.md` | `<feature-rN>/` | Confidence score + gap analysis |
| `iteration-handoff.md` | `<feature-rN>/` | Protected context for post-compact re-read |
| `loop-summary.md` | `<root-feature>/` | Final summary (only on loop exit) |
