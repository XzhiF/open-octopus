## Sub-workflow Node + E2E Harness System

This PR delivers two major features on the `feat/sub-workflow-node` branch:

### 1. Sub-workflow Node (核心功能)
A new `sub_workflow` node type that references and executes another workflow within the same workspace. Supports variable passing via I/O mapping, child node rendering in the flow panel, and SSE event logging.

### 2. E2E Harness System (测试基础设施)
A reusable E2E testing Skill with 6 STABLE lib modules, self-tests, pattern guides, and recipes. Solves the pain of rewriting E2E infrastructure for every feature.

### Development Iterations

| # | Feature | Date | Description |
|---|---------|------|-------------|
| 21 | sub-workflow-node | 08-02 | 子工作流节点初始实现 |
| 22 | sub-workflow-node-r2 | 08-02 | Error scenarios + SSE prefix + linked mode |
| 24 | subworkflow-loop-nesting | 08-03 | Sub-workflow inside loop nesting support |
| 23 | e2e-harness-system | 08-03 | **E2E 可复用测试框架** (6 lib 模块 + 27 data-testid) |

### E2E Harness Highlights

| Module | Exports | Self-test |
|--------|---------|-----------|
| `api.mjs` | fetchJSON, healthCheck, resolvePorts | 5/5 ✅ |
| `workspace.mjs` | createWorkspace, cleanupWorkspace, listWorkspaces | 5/5 ✅ |
| `execution.mjs` | createExecution, startExecution, pollExecution | 6/6 ✅ |
| `browser.mjs` | launchBrowser, takeScreenshot, clickByTestId | 4/4 ✅ |
| `reporter.mjs` | record, printReport, saveResults | 6/6 ✅ |
| `db.mjs` | executeSQL, querySQL, listTables | 5/5 ✅ |

### E2E Verification
| AC | Condition | Status |
|----|-----------|--------|
| AC-1 | matt-e2e-tester auto-loads harness | ✅ |
| AC-2-7 | 6 module self-tests all pass | ✅ |
| AC-8 | 27 data-testid additions (≥20) | ✅ |
| AC-9-10 | index.md + Draft protocol | ✅ |
| AC-11-13 | integration-test + patterns + recipe | ✅ |

### Changed Files
119 files changed, 8,707 insertions(+), 89 deletions(-)

<!-- MANUAL-START -->
<!-- MANUAL-END -->
