# 03 — Server: Observability API + ObservabilityQueryService

## What to build
新增 `GET /api/workspaces/:id/executions/:eid/observability` 端点和 `ObservabilityQueryService`，返回完整观测数据（token 汇总、按节点分解、按模型分解、时间序列、预算快照、错误时间线、轮次明细）。主聚合数据源使用 `llm_calls` 表。

## Blocked by
02-server-budget-snapshot

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: `GET /executions/:eid/observability` 返回 `ObservabilityData` 结构，所有字段非空（对已完成的有 agent 节点的执行）
- [ ] AC-2: `tokens.totalInput` == `SELECT SUM(input_tokens) FROM llm_calls WHERE execution_id = :eid`（DB 交叉验证）
- [ ] AC-3: `byNode` 数组长度 == 执行的节点数，每个元素包含正确的 token/cost/turns 分解
- [ ] AC-4: `byModel` 数组包含每个使用过的模型及其 token/cost 分解
- [ ] AC-5: `timeSeries` 数组包含按时间排序的累计 token/cost 数据点
- [ ] AC-6: `errors` 数组包含所有失败/重试事件，`errorType` 经 `classifyError()` 正确分类
- [ ] AC-7: `rounds.totalLlmTurns` / `totalRetries` 数据正确；`byNode` 中的 `loopIterations` 从子 `node_executions.iteration_index` 计算
- [ ] AC-8: `budget.snapshot` 与 `executions.budget_snapshot` 一致；`budget.progress` 百分比计算正确

## Verification Method
**Verification type**: Integration test

**Verification steps**:
```bash
# 1. 前置：执行一个含 ≥3 节点的 workflow（包括 agent + 会失败的节点）
# 2. 等待执行完成
# 3. 调用 observability API
curl -s http://localhost:3001/api/workspaces/:wid/executions/:eid/observability | jq '.'

# 4. 断言结构完整性
# jq: .tokens.totalInput > 0, .tokens.totalCostUsd > 0
# jq: (.byNode | length) >= 3
# jq: (.byModel | length) >= 1
# jq: (.timeSeries | length) > 0
# jq: .rounds.totalLlmTurns > 0

# 5. DB 交叉验证
# sqlite3: SELECT SUM(input_tokens) FROM llm_calls WHERE execution_id = ':eid'
# 对比 API 返回的 tokens.totalInput

# 6. 错误分类验证
# 如果有失败节点：jq '.errors[] | .errorType' 应为 5 种之一
# 断言 .errors 长度 == DB 中 error IS NOT NULL 的记录数

# 7. 无 budget 的执行
# .budget.snapshot == null, .budget.progress 各字段 == null
```

**Pass criteria**: 所有 8 个 AC 断言通过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
