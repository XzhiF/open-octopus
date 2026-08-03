---
name: matt-pipeline-loop
description: >
  Verification-driven iteration orchestrator. Reads a feature's verification-report,
  generates a gap-focused brief for the next iteration, invokes matt-dev-pipeline,
  and loops until confidence score ≥ 85 (GO) or hard stops are hit.
  Each iteration creates a new feature-slug (-r2, -r3, ...) with independent artifacts.
  Based on Anthropic EDD, Shumer Gauntlet, and Loop Engineering patterns.
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

## Theoretical Foundations

| Source | Pattern | How We Apply It |
|--------|---------|----------------|
| Anthropic EDD | Define → Develop → Conduct → Analyze → Improve cycle | Each iteration = one full EDD cycle |
| Matt Shumer Gauntlet | Builder vs Critic with fresh context | Pipeline builds, verification-report critiques with fresh eyes |
| Loop Engineering | Trigger → Scope → Action → Budget → Stop → Report | The 5-element loop contract |
| Ralph Loop | Fixed anchor files, one task per iteration, BLOCKED detection | Gap brief = one focused task per iteration |
| Walking Skeleton | End-to-end thin slice first, then thicken | Iteration 1 = full stack skeleton; later iterations thicken weak layers |
| Vibe Coding Research | "80-90% fast, last 10% hard" + context momentum | Gap brief breaks context momentum by forcing fresh scope |

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
│  3. Check convergence:                            │
│     ├── score ≥ 85 → EXIT (GO)                   │
│     ├── iteration ≥ max → EXIT (MAX_REACHED)     │
│     ├── 2 rounds no improvement → EXIT (STALLED) │
│     └── else → CONTINUE                          │
│                                                  │
│  4. Generate gap brief for next iteration         │
│  5. Invoke matt-dev-pipeline on gap brief         │
│  6. Go to step 1                                  │
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
  "iterations": [
    {
      "round": 1,
      "feature_slug": "chatbot-workflow-design",
      "score": 50,
      "decision": "NO-GO",
      "top_gaps": ["Test Completeness", "Test Authenticity", "Negative Tests"]
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

### Step 3: Check Convergence

**IMPORTANT**: Do NOT ask the user whether to continue. This is a fully autonomous loop — proceed to the next iteration immediately unless one of the exit conditions is met.

```
IF score ≥ 85:
  → Parse pipeline-report.md AC table:
    a) Any AC with status "SKIP" → do NOT converge
       SKIP ACs become P1 gap targets in the next iteration's gap brief
    b) All ACs are PASS or explicitly "N/A (out of scope)" → proceed
  → Set status = "converged"
  → Write final summary
  → EXIT with GO

IF iteration_count ≥ max_iterations:
  → Set status = "max_reached"
  → Write final summary
  → EXIT with MAX_REACHED

IF iterations.length ≥ 2 AND score[n] - score[n-1] < 5 AND score[n-1] - score[n-2] < 5:
  → Set status = "stalled"
  → Write final summary
  → EXIT with STALLED (diminishing returns detected)

ELSE:
  → Continue to Step 4
```

**No-progress detection**: If the same specific gap appears in 2+ consecutive iterations without improvement, flag it as BLOCKED and exclude from the next gap brief (don't waste iterations on unfixable items).

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
- Previous score: <score>/100
- Previous decision: <NO-GO/REVIEW>
- Branch: <same-branch> (all iterations share the same git branch)

## Gap Targets

### Gap 1: <gap-title>
**What failed**: <specific description from verification-report section 6>
**Why it matters**: <risk/impact>
**Required fix**: <concrete action items>
**Verification**: <how to verify this gap is closed>

### Gap 2: <gap-title>
...

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

### Step 5: Invoke Pipeline

```
Invoke: /matt-dev-pipeline <artifacts.dir>/<root-feature>-r<N>/
```

The pipeline runs its normal 5 phases (Development → Code Review → Deploy → E2E → Ship) on the gap-focused brief.

### Step 6: Record Iteration

After the pipeline completes:

1. Run `matt-verification-report` on the new iteration
2. Update `loop-state.json` with the new iteration's results
3. Update `<artifacts.dir>/index.md` with the new feature-slug
4. Check convergence (Step 3)

## Gap Classification and Priority

Not all gaps are equal. The loop prioritizes gaps by impact:

| Priority | Gap Type | Example | Iteration Strategy |
|----------|----------|---------|-------------------|
| **P0** | BLOCKED functionality | "Frontend component not registered" | Fix first — blocks user value |
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
      "feature_slug": "chatbot-workflow-design",
      "score": 50,
      "decision": "NO-GO",
      "gates_passed": 3,
      "gates_total": 6,
      "top_gaps": ["Test Completeness (37.5%)", "Test Authenticity (28)", "Negative Tests (1.5%)"]
    },
    {
      "round": 2,
      "feature_slug": "chatbot-workflow-design-r2",
      "score": 72,
      "decision": "REVIEW",
      "gates_passed": 5,
      "gates_total": 6,
      "top_gaps": ["Negative Tests (12%)"]
    },
    {
      "round": 3,
      "feature_slug": "chatbot-workflow-design-r3",
      "score": 88,
      "decision": "GO",
      "gates_passed": 6,
      "gates_total": 6,
      "top_gaps": []
    }
  ],
  "final_score": 88,
  "final_decision": "GO",
  "total_iterations": 3,
  "status": "converged"
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

| Round | Feature Slug | Score | Decision | Key Fix |
|-------|-------------|-------|----------|---------|
| 1 | chatbot-workflow-design | 50 | NO-GO | Initial implementation |
| 2 | chatbot-workflow-design-r2 | 72 | REVIEW | Added unit tests for 5 modules |
| 3 | chatbot-workflow-design-r3 | 88 | GO | Added negative tests, replaced stale E2E |

## Convergence
- Final score: 88/100
- Total iterations: 3
- Status: CONVERGED
- Duration: <time>

## Score Progression
50 → 72 (+22) → 88 (+16)

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
matt-verified-requirement → brief.md (initial)
         │
         ▼
    ┌─────────────────────────────┐
    │  matt-pipeline-loop         │
    │                             │
    │  ┌─ matt-dev-pipeline ──┐   │
    │  │  Phase 1-5 (normal)  │   │
    │  └──────────────────────┘   │
    │         │                    │
    │  ┌─ matt-verification- ─┐   │
    │  │  report (audit)      │   │
    │  └──────────────────────┘   │
    │         │                    │
    │  Score ≥ 85? ── NO ──→      │
    │  Generate gap brief         │
    │  New feature-slug (-r2)     │
    │  Loop back ─────────────┘   │
    │         │                    │
    │  Score ≥ 85? ── YES ──→     │
    │  Write loop-summary.md      │
    │  EXIT                       │
    └─────────────────────────────┘
```

## Anti-Patterns to Avoid

1. **Re-implementing what works** — gap brief must NOT include working areas; only target failures
2. **Growing scope** — each iteration should be SMALLER than the previous, not larger
3. **Ignoring BLOCKED items** — if a gap persists 2+ rounds, mark BLOCKED and move on
4. **Blindly trusting previous reports** — each verification-report must be a fresh analysis
5. **Changing branches** — all iterations must stay on the same git branch
6. **Skipping verification** — never skip the verification-report between pipeline runs

## Glossary

| Term | Meaning |
|------|---------|
| Gap Brief | A focused brief targeting only the failures from the previous iteration |
| Iteration | One complete pipeline run (dev → review → deploy → E2E → ship → verify) |
| Convergence | Score reaching ≥ 85 (GO threshold) |
| Stall | Two consecutive rounds with < 5 point score improvement |
| Regression | Score decreasing between rounds (something got worse) |
| Loop State | JSON file tracking all iteration results and metadata |
| Root Feature | The original feature-slug that started the loop |

## Relationship to Other Skills

| Skill | Relationship |
|-------|-------------|
| matt-verified-requirement | Upstream — produces the initial brief |
| matt-dev-pipeline | Inner loop — called per iteration |
| matt-verification-report | Gate — called after each iteration to score |
| matt-dev-runner | Indirect — called by pipeline within each iteration |
| matt-e2e-tester | Indirect — called by pipeline within each iteration |
