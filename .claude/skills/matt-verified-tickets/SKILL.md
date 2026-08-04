---
name: matt-verified-tickets
description: Enhancement of to-tickets. Adds verification method binding — every ticket gets executable verification steps. Used as a guide by the main session during matt-verified-requirement.
reference-only: true
---

# Verified Tickets — Enhancement of `to-tickets`

> **This skill enhances `to-tickets`.** Follow `to-tickets` for the base process (tracer bullet splitting, blocking edges, publishing), then add the verification enhancements below.
> It is a methodology reference — the main session reads it when writing issues/ during `matt-verified-requirement`. NOT auto-invoked by any agent.

## Base Skill

Follow `to-tickets` for:
- **Process**: Gather context → Explore codebase → Draft vertical slices → Quiz user → Publish
- **Tracer bullet principles**: narrow end-to-end path, demoable independently, one session size, prefactoring first
- **Blocking edges**: each ticket declares what blocks it (this creates the DAG)
- **Split ordering**: DB → Entity → Service → Controller → Frontend API → Pages → E2E
- **Publishing**: one file per ticket under `<artifacts.dir>/<feature-slug>/issues/<NN>-<slug>.md`

## Enhancements (补充 Verification Methods)

The core enhancement: each ticket gets a **Verification Method** section in addition to Acceptance Criteria.

### Add to `to-tickets` template — insert after Acceptance Criteria:

```markdown
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

## Additional Rules (beyond `to-tickets`)

1. **Every ticket MUST have a Verification Method** — no verification = incomplete ticket
2. **Executable verification** — specific commands, specific SQL, specific assertions (not "test the API")
3. **DAG structure** — tickets without mutual blockers can run concurrently in the same stage (consumed by `matt-dev-pipeline` Phase 1)
4. **One session size** — each ticket's implementation + verification fits in one matt-dev-runner agent call
