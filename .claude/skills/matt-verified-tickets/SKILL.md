---
name: matt-verified-tickets
description: Enhanced to-tickets. Splits a spec into vertical-slice tickets, each with acceptance criteria AND verification methods. Auto-invoked by matt-dev-runner agent, not user-triggered.
disable-model-invocation: true
---

# Verified Tickets

This skill is auto-invoked by the `matt-dev-runner` agent. It reads a Verified Spec and produces **tracer bullet vertical-slice tickets**, each with a complete Verification Method.

## Input

Read `<artifacts.dir>/<feature-slug>/spec.md` (from `matt-verified-spec`).

## Output

Each ticket written to `<artifacts.dir>/<feature-slug>/issues/<NN>-<slug>.md`.

## Process

### 1. Gather Context

Read the spec, explore the codebase. Ticket titles and content use project domain terminology.

### 2. Split into Vertical Slices

Follow **tracer bullet** principles:

- Each slice is a narrow end-to-end path from schema -> API -> UI
- Completed slices can be independently verified and demonstrated
- Each slice fits in one agent session
- Prefer prefactoring: "Make the change easy, then make the easy change"

**Split ordering** (by dependency):

```
1. Database changes (tables, indexes)
2. Backend Entity / Mapper / BO / VO
3. Backend Service (business logic + unit tests)
4. Backend Controller (API endpoints)
5. Frontend API files
6. Frontend pages / components
7. E2E integration verification
```

### 3. Bind Verification Method to Each Ticket

**This is the core difference from the original to-tickets.**

Each ticket has Acceptance Criteria AND a Verification Method — telling the executing agent exactly how to verify the ticket is done correctly.

### 4. Publish Tickets

Write to `<artifacts.dir>/<feature-slug>/issues/`, one file per ticket, numbered by dependency order (starting from 01).

## Ticket Template

```markdown
# <NN> — <Ticket Title>

## What to build

Describe the end-to-end behavior this ticket implements, from the user's perspective. Not a layer-by-layer implementation checklist.

## Blocked by

Prerequisite ticket numbers/titles, or "None — can start immediately".

## Status

ready-for-agent

## Acceptance Criteria

- [ ] AC1: [specific verifiable condition]
- [ ] AC2: [specific verifiable condition]

## Verification Method

**Verification type**: [unit test / integration test / browser E2E / contract test / manual checklist]

**Prerequisites**:
- [ ] [e.g., backend compiles]
- [ ] [e.g., test data is ready]

**Verification steps**:

### Unit Tests (if applicable)

cd <project-root>
pnpm test  # Vitest

Pass criteria: All test methods PASS

### Integration Tests (if applicable)

Step 1: Get token
Step 2: Record pre-test state (DB query)
Step 3: Call API
Step 4: Verify API response (assert business fields)
Step 5: DB verification
Step 6: Cache verification
Step 7: Cross-validation: API <-> DB <-> Cache
Step 8: Cleanup

### Browser E2E (if applicable)

1. Playwright script: login -> navigate -> operate -> assert -> screenshot

### Contract Verification (if applicable)

- [ ] Backend VO fields <-> Frontend interface fields match
- [ ] API paths match between backend and frontend
- [ ] Field types match (watch String vs Number)

### Manual Checklist (if applicable)

- [ ] V1: [specific check]
- [ ] V2: [specific check]

**Pass criteria**: All verification steps PASS, evidence chain complete
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
```

## Key Rules

1. **Every ticket MUST have a Verification Method** — no verification = incomplete ticket
2. **Vertical Slice** — each ticket is a complete narrow path, not a single-layer slice
3. **Independently verifiable** — each ticket can be verified on its own
4. **Clear dependencies** — Blocked by explicitly declares prerequisites
5. **Executable verification** — specific commands, specific SQL, specific assertions
6. **One session size** — each ticket's implementation + verification fits in one agent call
