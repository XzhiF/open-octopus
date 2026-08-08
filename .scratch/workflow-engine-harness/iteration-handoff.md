# Iteration Handoff — workflow-engine-harness Round 1

## Loop Position
- Round: 1 / 5
- Score: PENDING (verification not run)
- Next feature-slug: workflow-engine-harness-r2
- Branch: feat/workflow-engine-harness

## Protected Architecture Decisions

| # | Decision | Conclusion | Source |
|---|---------|-----------|--------|
| A1 | 三层委托架构 | Detectors → Strategies → Agent Delegation | spec.md |
| A2 | 引擎回调扩展 | 3个可选回调，完全向后兼容 | spec.md |
| A3 | 配置全局化 | harness.yaml + 系统管理UI，不加workflow.yaml | spec.md |
| A4 | 5种干预模式 | inject/takeover/varpool/definition/switch_model | spec.md |
| A5 | 渐进式进程隔离 | 基础层(全平台) + 增强层(Linux/macOS) | spec.md |
| A6 | UI悬浮面板 | 可拖拽/缩放 + chatbot + DAG标记 | spec.md |

## Confirmed Interfaces (Do NOT Change)

| Interface | Location | Verified In |
|-----------|----------|-------------|
| EngineCallbacks (3 new) | packages/engine/src/engine.ts:67-96 | Round 1 build + 13 unit tests |
| HarnessDAO | packages/server/src/db/dao/harness-dao.ts | Round 1 build + 11 tests |
| HarnessConfigService | packages/server/src/services/harness/config-service.ts | Round 1 build + 11 tests |
| StrategyEngine | packages/server/src/services/harness/strategy-engine.ts | Round 1 build + 33 tests |
| AgentDelegationService | packages/server/src/services/harness/agent-delegation.ts | Round 1 build + 24 tests |
| HarnessFloatingPanel | packages/web-app/components/workspace/harness-floating-panel.tsx | Round 1 build + 9 tests |

## Gap Targets for Next Iteration

1. **E2E Browser Tests**: Playwright tests for floating panel, chatbot, DAG markers
2. **E2E Integration Tests**: Run test workflows against real dev server, verify SSE events
3. **Should-Fix items from code review**: ExecutionLifecycle cleanup paths, Python wrapper

## BLOCKED Gaps
_None yet_

## Carryover List
_Empty (first iteration)_

## Prerequisite Status
- Dev server running: No
- E2E actually executed: No
- E2E execution evidence: none

## Pipeline Completeness
- All 5 phases produced artifacts: Yes
- Missing phases: Phase 4 (E2E) was deferred

## Key File Paths
- Root spec: .scratch/workflow-engine-harness/spec.md
- Pipeline report: .scratch/workflow-engine-harness/pipeline-report.md
- Code review: .scratch/workflow-engine-harness/code-review.md
- Loop state: .scratch/workflow-engine-harness/loop-state.json
- PR: https://github.com/XzhiF/open-octopus/pull/45

## What Worked (Do Not Re-implement)
- Shared types + config schema (17 tests)
- Engine callbacks (13 tests, backward compatible)
- DB migration + API routes (32 tests)
- 4 detectors + pipeline (34 tests)
- Strategy engine + 5 actions (33 tests)
- Agent delegation (24 tests)
- Process isolation (20 tests)
- Config UI (26 tests)
- Floating panel + chatbot (9 tests)
- Integration tests (10 tests)
- Total: ~218 new tests
