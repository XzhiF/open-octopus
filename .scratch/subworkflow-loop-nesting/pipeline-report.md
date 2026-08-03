# Pipeline Execution Report

## Requirement: Nested Execution Hierarchy (subworkflow-loop-nesting)
## Status: PARTIAL

### Phase 1: Development
| Ticket | Title | Status | Fix Count |
|--------|-------|--------|-----------|
| 01-schema-migration | Add parent_node_id + iteration_index columns | ✅ done | 0 |
| 02-engine-propagation | Propagate meta through engine callbacks | ✅ done | 0 |
| 03-server-persistence | Persist meta in EngineCallbacks + API | ✅ done | 0 |
| 04-ui-grouping-fix | Fix iteration grouping in execution-log-viewer | ✅ done | 0 |
| 05-integration-test | Integration tests for nesting scenarios | ✅ done | 0 |

### Phase 2: Code Review
| Axis | Findings | Fixed | Noted | Cycles |
|------|----------|-------|-------|--------|
| Standards | 4 (all judgement calls) | 1 (type dedup) | 3 | 1 |
| Spec | 9 (3 real, 6 misattributed) | 0 | 9 | 1 |
| Completeness | 3 (1 critical, 2 enhancement) | 2 (API mapping + SSE) | 1 | 1 |

**Critical fix**: API step mapping was missing `parentNodeId` and `iterationIndex` — frontend couldn't receive hierarchy data. Fixed.

### Phase 3: Deploy
| Project | Build# | Result |
|---------|--------|--------|
| local dev | N/A | DB auto-migrates via ensureColumn |

### Phase 4: E2E Verification
| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|
| AC1 | Sub-workflow children have parent_node_id | ✅ PASS | DB: `call-analysis:prep→call-analysis` |
| AC2 | Loop inner nodes have iteration_index | ✅ PASS | DB: `iteration_index=0` (0-based) |
| AC3 | UI groups children per iteration | ✅ PASS | Browser: `prep-iter1`, `prep-iter2`, `prep-iter3` separate |
| AC4 | 3-layer nesting (A→B→C) | ⚠️ PARTIAL | A→B correct, C grandchildren not in DB |
| AC5 | Sub-workflow containing loop | ⚠️ PARTIAL | Children correct, inner loop steps not in DB |
| AC6 | Regression (non-nested workflows) | ✅ PASS | All new columns null |

**E2E bug fix**: `workflowResolver` + `visitedWorkflows` not propagated to LoopConfig — fixed during testing.

### Phase 5: Ship (Git PR)
PR #37: https://github.com/XzhiF/open-octopus/pull/37 (updated)

### Changed Files
| Package | File | Change Type |
|---------|------|-------------|
| engine | engine.ts | Modified (RuntimeNodeMeta interface) |
| engine | executor-factory.ts | Modified (meta forwarding) |
| engine | executors/executor-config.ts | Modified (LoopConfig + SubWorkflowConfig) |
| engine | executors/loop.ts | Modified (iteration injection) |
| engine | executors/sub-workflow.ts | Modified (parentNodeId + JSONL logging) |
| server | db/schema.sql | Modified (2 new columns) |
| server | db/schema.ts | Modified (SCHEMA_VERSION 31→32) |
| server | db/types.ts | Modified (NodeExecutionRow) |
| server | db/dao/execution-dao.ts | Modified (insert + update) |
| server | routes/execution.ts | Modified (step mapping + filter) |
| server | services/execution/EngineCallbacks.ts | Modified (persist + SSE) |
| web-app | execution-log-viewer.tsx | Modified (iteration suffix) |
| engine | __tests__/nested-hierarchy-callbacks.test.ts | New |
| server | __tests__/nested-execution-hierarchy.test.ts | New |

### Remaining Issues
| # | Issue | Impact | Suggestion |
|---|-------|--------|------------|
| 1 | Grandchild nodes not persisted (3+ layer nesting) | AC4/AC5 partial — only first-level sub-workflow children get DB records | Pass `ensureNodeExecution` through child engine constructor |
| 2 | Iteration deduplication — same nodeId across iterations | `iteration_index` always 0 for sub-workflow children in loops | Include iteration in node execution ID: `${execId}-${nodeId}-iter${N}` |
