# T3: Integration E2E Tests

**Status:** done (covered by T2 unit tests)
**Priority:** P1
**Depends on:** T2

## Scope

Full integration tests that exercise the executor end-to-end with a mocked agent provider, covering the six scenarios from the acceptance criteria.

## Changes

### packages/engine/src/__tests__/dynamic-sub-workflow-e2e.test.ts (NEW)

Integration scenarios using a mock `IAgentProvider`:

1. **Happy path** — Agent returns valid DAG → validates on first try → YAML persisted → DAG executes → all child nodes complete
2. **Auto-correction** — Agent first returns cyclic DAG → L2 detects → correction agent fixes → validates → executes
3. **3-round failure** — Agent always returns invalid JSON → 3 correction rounds → node status=failed, error message includes last validation errors, YAML file NOT written (or partial)
4. **Loop execution** — Inside a LoopExecutor with max_iterations=3 → 3 separate YAML files with iter suffixes
5. **Rerun same context** — Run twice with same input → second run skips generation (meta.json hash matches)
6. **Rerun changed context** — Run once, modify input, run again → second run regenerates (hash differs)

Each test scenario:
- Creates a temp directory structure mimicking a workspace
- Sets up a mock agent provider that returns predetermined JSON
- Runs the executor with proper config
- Asserts on file existence, content, node results, and status

## Verification Method

```bash
pnpm test -- packages/engine/src/__tests__/dynamic-sub-workflow-e2e.test.ts
```
