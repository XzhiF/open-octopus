# Requirement Brief — Sub-Workflow Node Iteration R2

## Overview
Gap-fix iteration for sub-workflow-node. This iteration targets ONLY the gaps
identified in the previous pipeline run.

## Context
- Root feature: sub-workflow-node
- Previous iteration: sub-workflow-node (R1)
- Previous score: 72/100 (REVIEW)
- Branch: feat/sub-workflow-node (same branch, all iterations share)
- PR: https://github.com/XzhiF/open-octopus/pull/37

## Gap Targets

### Gap 1: Error Scenario E2E Tests
**What failed**: AC #6 (sub_workflow fail → parent failed) and AC #7 (on_error: continue) were SKIP — no error scenario tests exist.
**Why it matters**: The on_error behavior is core to the feature but has zero E2E evidence.
**Required fix**: Add E2E tests that:
  1. Create a child workflow with a failing bash node (exit 1)
  2. Execute parent with `on_error: fail` → verify parent status = failed
  3. Execute parent with `on_error: continue` → verify parent continues to next node
**Verification**: New E2E test assertions + screenshots in `.scratch/sub-workflow-node-r2/e2e-screenshots/`

### Gap 2: SSE Event Prefix Propagation
**What failed**: AC #9 (event panel shows `{sub_workflow_name}:{event_name}`) was PARTIAL — events are logged via onNodeLog with prefix, but not emitted as proper SSE events with the `{name}:{event}` format.
**Why it matters**: The user explicitly requested right-side event panel to show prefixed events.
**Required fix**: In SubWorkflowExecutor.createChildCallbacks(), call parent's `onNodeStart`/`onNodeEnd` callbacks with prefixed node IDs (e.g., `{workflowName}:{nodeId}`), so the server SSE layer emits properly prefixed events.
**Verification**: E2E test that checks SSE event stream for prefixed event names.

### Gap 3: Linked Execution Mode Stub
**What failed**: `execution_mode: "linked"` is declared in the schema but falls through to inline behavior — no differentiation.
**Why it matters**: User requested both modes. Linked mode creates a separate execution record with parent_execution_id, enabling independent audit trails.
**Required fix**: In SubWorkflowExecutor, when execution_mode === "linked":
  1. Call a `createChildExecution` callback to create a new DB execution record with parent_execution_id
  2. Run the child workflow in that separate execution context
  3. Poll/wait for child completion
  4. Return child results to parent
  Add `createChildExecution?: (workflowName: string, parentExecutionId: string) => Promise<{ executionId: string }>` to SubWorkflowConfig.
**Verification**: Unit test verifying linked mode calls createChildExecution; E2E test verifying separate execution record in DB.

## Feature Scope
**Do:**
- Add error scenario E2E tests (on_error: fail and on_error: continue)
- Implement SSE event prefix propagation in child callbacks
- Implement linked execution mode with separate execution record
- All changes on the SAME branch: feat/sub-workflow-node

**Don't:**
- Do NOT modify working inline execution path from R1
- Do NOT add visual node creation dialog (separate future feature)
- Do NOT refactor existing container node utilities (low priority)

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Scope | Gap-fix only | Minimize regression risk |
| D2 | Linked mode approach | Stub with createChildExecution callback | Server integration point for future full implementation |

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| G1 | Error handling | Child workflow fails → parent sub_workflow node = failed (on_error: fail) | E2E test + screenshot |
| G2 | Error continue | Child workflow fails → parent continues (on_error: continue) | E2E test + screenshot |
| G3 | SSE events | Event panel shows `{workflow_name}:{node_id}` prefixed events | E2E test checking SSE stream |
| G4 | Linked mode | execution_mode: linked creates separate execution record | Unit test + E2E |

## Verification Strategy

### Global Config
- Environment: local dev (server:3001, web:3000)
- Data prefix: E2E_SUBWF_R2_

### Per-layer Methods
#### Unit Tests
- SubWorkflowExecutor linked mode: verify createChildExecution is called

#### Browser E2E
- Error scenario tests: failing child → parent status check
- SSE event stream: check for prefixed event names

### Prerequisites
- Dev server running on 3001/3000
- R1 code already deployed (same branch)

## Risks & Notes
- R1: Linked mode requires server-side execution creation logic — may need to extend EngineFactory
- R2: SSE prefix changes could affect existing event consumers — ensure backward compatibility
