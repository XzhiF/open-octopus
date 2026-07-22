---
name: matt-verified-spec
description: Enhanced to-spec. Synthesizes a requirement brief into a full spec document where every user story has a bound verification strategy. Auto-invoked by matt-dev-runner agent, not user-triggered.
disable-model-invocation: true
---

# Verified Spec

This skill is auto-invoked by the `matt-dev-runner` agent. It reads a requirement brief and produces a full specification document. **The core enhancement is the Verification Strategy block** — every user story must have a concrete, executable verification method.

## Input

Read `<artifacts.dir>/<feature-slug>/brief.md` (from `matt-verified-requirement`).

Read `CLAUDE.md` to understand the project structure (TypeScript monorepo, pnpm, SQLite, Hono API).

## Output

Write `<artifacts.dir>/<feature-slug>/spec.md` (Verified Spec).

## Process

1. **Load domain model**: Read each project's `CONTEXT.md` (glossary) and `docs/adr/` (existing decisions). Ensure the spec uses the project's ubiquitous language.
2. **Explore codebase**: Read relevant module code to understand the current state.
3. **Identify seams**: Find the best places to test. Prefer existing seams; minimize new ones.
4. **Synthesize spec**: Use the template below. Write to `<artifacts.dir>/<feature-slug>/spec.md`.

## Spec Template

```markdown
# Spec: [Requirement Title]

## Problem Statement

The problem users face, described from the user's perspective.

## Solution

The solution, described from the user's perspective.

## User Stories

Numbered list:

1. As a [role], I want [capability], so that [benefit]

The list should be **exhaustive**, covering all aspects of the feature.

## Implementation Decisions

- Modules involved (new / modified)
- Inter-module interface definitions
- Data model changes (tables, fields, indexes)
- API contracts (paths, methods, params, response)
- Caching strategy
- Architecture decisions

Do NOT include specific file paths or code snippets (they become stale).
Exception: If a prototype produced something more precise than prose (state machines, reducers, schemas, type shapes), inline it.

## Verification Strategy

**This is the core difference from the original to-spec.**

### Verification Environment

| Item | Value |
|------|-------|
| Environment | [local dev: `pnpm dev`] |
| API prefix | `/api/` (Hono REST API, port 3001) |
| Database | SQLite: `~/.octopus/db/octopus.db` (use matt-sql-executor skill) |
| Cache | N/A (no Redis) |
| Admin UI | `http://localhost:3000` (Next.js web-app) |

**External services**: None — this project uses SQLite only, no MySQL/Redis/Figma MCP.

### Test Users & Data

| Item | Value |
|------|-------|
| Test account | [admin / regular user / guest] |
| Data prefix | E2E_TEST_ |
| Seed data | [what needs to be ready] |
| Cleanup | DELETE after test + verify cache rebuild |

### Acceptance Criteria to Verification Method Mapping

**Every User Story MUST have a concrete verification method.**

| US# | User Story | Acceptance Criteria | Verification Level | Verification Method |
|-----|-----------|---------------------|-------------------|---------------------|
| US1 | As a... | AC1: [condition] | Integration test | API call + DB verify |
| US2 | As a... | AC2: [condition] | Browser E2E | Playwright + screenshot |
| US3 | As a... | AC3: [condition] | Contract test | VO <-> TS interface field comparison |

### Verification Methods Detail

#### Backend Unit Tests (Service layer)

Test class: [full class name]
Mock objects: [list]
Run command: `pnpm test` (Vitest, from project root)
Pass criteria: All test methods PASS

#### Backend Integration Tests (API layer)

1. Auth: Obtain token (from cache or login)
2. Record pre-test state (DB + Cache query)
3. Call API (curl or script)
4. Verify API response (assert business fields, not just HTTP 200)
5. DB verification (SELECT ... WHERE ...)
6. Cache verification (GET / SCAN)
7. Cross-validation: API response <-> DB data <-> Cache state
8. Cleanup: DELETE test data, verify cache rebuild

#### Browser E2E (Admin Dashboard)

1. Playwright script: login -> navigate -> operate -> assert -> screenshot
2. Intercept API: page.on('response') to capture API calls
3. Cross-validate: UI data <-> intercepted API <-> DB data

#### Frontend Contract Verification

- [ ] Backend VO field names <-> Frontend interface field names match
- [ ] Backend VO field types <-> Frontend expected types match (watch String vs Number)
- [ ] API paths match between backend annotations and frontend enums
- [ ] New API endpoints have corresponding frontend API files

#### Manual Verification Checklist (fallback)

- [ ] V1: Page renders normally, no blank screen
- [ ] V2: Data displays correctly
- [ ] V3: Interactions respond normally
- [ ] V4: Edge cases handled correctly

### Anti-Fake-Run Standards (R1-R8)

Every integration/E2E test must satisfy ALL criteria:

| # | Criterion | Description |
|---|-----------|-------------|
| R1 | Real service | Use real UAT address, not localhost/mock |
| R2 | Business data | Assert specific field values, not just HTTP 200 |
| R3 | Cross-validation | API <-> DB <-> Cache, at least two-way comparison |
| R4 | Evidence | Include response body + DB query + screenshot (at least two) |
| R5 | Side effects | Write ops must verify DB change + cache invalidation |
| R6 | Real user path | Obtain token through login |
| R7 | Data isolation | Use E2E_TEST_ prefix, clean up after test |
| R8 | Repeatable | No manual pre-steps, script is self-contained |

## Out of Scope

Work not in scope for this requirement.

## Further Notes

Additional notes.
```

## Key Rules

1. **Every User Story MUST have a verification method** — no verification = incomplete story
2. **Verification methods must be executable** — not "test the API" but "POST /api/xxx, assert response.data.field == expected"
3. **Use project domain terminology** — consistent with CONTEXT.md and ADR
4. **No code snippets** — only decisions and interface definitions; code goes stale
5. **Verification environment info must be complete** — MCP connections, test accounts, data strategy
