---
name: matt-verified-spec
description: Enhancement of to-spec. Adds verification strategy block — every user story gets a concrete, executable verification method. Used as a guide by the main session during matt-verified-requirement.
reference-only: true
---

# Verified Spec — Enhancement of `to-spec`

> **This skill enhances `to-spec`.** Follow `to-spec` for the base process and template, then add the verification enhancements below.
> It is a methodology reference — the main session reads it when writing spec.md during `matt-verified-requirement`. NOT auto-invoked by any agent.

## Base Skill

Follow `to-spec` for:
- **Process**: Explore repo → Identify seams → Synthesize spec
- **Template sections**: Problem Statement, Solution, User Stories (exhaustive), Implementation Decisions, Testing Decisions, Out of Scope, Further Notes

## Enhancements (补充 Verification Methods)

The core enhancement: replace `to-spec`'s **Testing Decisions** section with a comprehensive **Verification Strategy** block.

### Add after Implementation Decisions:

```markdown
## Verification Strategy

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
```

## Additional Rules (beyond `to-spec`)

1. **Every User Story MUST have a verification method** — no verification = incomplete story
2. **Verification methods must be executable** — not "test the API" but "POST /api/xxx, assert response.data.field == expected"
3. **Verification environment info must be complete** — MCP connections, test accounts, data strategy
4. **No scope reduction** — the spec MUST NOT silently reduce requirements using phrases like "for the initial implementation", "for now", "future iteration", "body: empty for now", "can be added later". If the brief requires it, the spec must design it. If a technical constraint prevents full implementation, state the constraint explicitly and propose a solution path — do NOT skip
