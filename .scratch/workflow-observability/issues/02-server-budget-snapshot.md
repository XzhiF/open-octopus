# 02 — Server: Budget Snapshot 写入

## What to build
在 `ExecutionLifecycle.start()` 中，`getWorkflow()` 之后、engine 创建之前，提取 `wf.parsed.budget` 并写入 `executions.budget_snapshot`。

## Blocked by
01-shared-schema-budget

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: 含 budget 的 workflow 执行后，`executions.budget_snapshot` 列包含正确的 JSON（与 YAML budget 一致）
- [ ] AC-2: 不含 budget 的 workflow 执行后，`executions.budget_snapshot` 为 NULL
- [ ] AC-3: budget_snapshot 在执行开始 100ms 内写入（在 engine 创建之前）

## Verification Method
**Verification type**: Integration test

**Verification steps**:
```bash
# 1. 启动 dev server
pnpm dev

# 2. 创建测试 workspace 和含 budget 的 workflow（通过 API）
# POST /api/workspaces 创建 workspace
# POST /api/workspaces/:id/workflows 创建含 budget 的 workflow

# 3. 触发执行
# POST /api/workspaces/:id/executions { workflow_ref: "test-budget-workflow" }

# 4. 立即查询 execution
# GET /api/workspaces/:id/executions/:eid
# 断言: response.budget_snapshot == '{"max_tokens":100000,"max_duration":300,"max_cost_usd":2,"alert_threshold":0.8}'

# 5. 直接 SQL 验证（交叉验证）
# sqlite3 ~/.octopus/db/octopus.db "SELECT budget_snapshot FROM executions WHERE id = ':eid'"
# 断言: 与 API 返回一致

# 6. 无 budget 的 workflow 执行
# POST /api/workspaces/:id/executions { workflow_ref: "no-budget-workflow" }
# GET /api/workspaces/:id/executions/:eid2
# 断言: response.budget_snapshot == null
```

**Pass criteria**: 所有断言通过，budget_snapshot 与 YAML budget 内容一致
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
