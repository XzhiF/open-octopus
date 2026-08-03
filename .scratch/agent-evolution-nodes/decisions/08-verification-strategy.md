# 08 — Verification Strategy

Type: grilling
Status: resolved

## Question
What testing layers are required to verify this feature?

## Answer
Full layer testing:

1. **Unit Tests**: EvolutionRuntime logic, schema validation, patch diff generation, review gate decision logic
2. **Integration Tests**: system_agent node execution in workflow engine, evolution flow end-to-end (trigger → patch → review → apply), DB operations
3. **Playwright E2E**: Evolution panel operations (view history, trigger, rollback), workflow editor system_agent node creation, clone detail evolution stats

Test data: Dedicated test clone (`test-scheduler`) with isolated persona/memory/skills to avoid polluting real clones.

**Reason**: Evolution modifies persistent agent state — all layers needed to catch regressions at the right level.
