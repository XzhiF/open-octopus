# 04 — Server: SSE execution_metrics + 预算预警 + 预算阻断

## What to build
1. 在 `EngineCallbacks.onNodeEnd` 中，token 数据写入后，聚合 `llm_calls` 数据 emit `execution_metrics` SSE 事件（节流 500ms）
2. 预算预警：累计 token 超过 `budget_snapshot.max_tokens * alert_threshold` 时，通过 engine notify module 发送通知
3. 预算阻断：在 `onBeforeNode`（harness pipeline 之前）检查累计 token 是否超过 `max_tokens`，超过则设置 `budget_exceeded` 状态，emit `execution_status` SSE，终止执行
4. `budget_exceeded` 作为新执行状态在 ExecutionLifecycle 中处理
5. `max_duration` 追踪：使用 `executions.started_at` 计算已过时间

## Blocked by
02-server-budget-snapshot

## Status
done

## Acceptance Criteria
- [x] AC-1: 每个 `node_end` 后（最多 500ms 内），客户端收到 `execution_metrics` SSE 事件
- [x] AC-2: `execution_metrics.data` 包含正确的 `totalInputTokens` / `totalOutputTokens` / `totalCostUsd` / `totalLlmTurns` / `budgetProgress` / `errorCount`
- [x] AC-3: `budgetProgress.tokensPercent` == (累计 token / budget_snapshot.max_tokens * 100)，无预算时为 null
- [x] AC-4: 累计 token 达到 `max_tokens * alert_threshold` 时，engine notify module 发送预警通知
- [x] AC-5: 累计 token 超过 `max_tokens` 时，下一个顶层节点被阻断，执行状态变为 `budget_exceeded`
- [x] AC-6: 预算阻断时 emit `execution_status` SSE 事件（非 `status_change`）
- [x] AC-7: `budget_exceeded` 状态在 ExecutionLifecycle 中正确处理（写入 DB，onComplete 触发）
- [x] AC-8: `budgetProgress.durationPercent` 使用 `executions.started_at` 计算
- [x] AC-9: loop 内部节点不触发预算阻断（仅顶层节点边界）

## Verification Method
**Verification type**: Integration test

**Verification steps**:
```bash
# 1. SSE execution_metrics 验证
# 启动执行 → 监听 SSE 事件流
# 断言：每个 node_end 后收到 execution_metrics 事件
# 断言：totalInputTokens 单调递增

# 2. 预算预警验证
# 创建 budget: { max_tokens: 5000, alert_threshold: 0.8 } 的 workflow
# 执行到累计 token > 4000
# 断言：通知记录中有预警条目

# 3. 预算阻断验证
# 创建 budget: { max_tokens: 100 } 的 workflow（极低预算）
# 第一个 agent 节点消耗 > 100 tokens
# 断言：第二个节点未执行
# 断言：execution.status == "budget_exceeded"
# 断言：SSE 收到 execution_status { status: "budget_exceeded" }

# 4. max_duration 追踪验证
# 创建 budget: { max_duration: 1 } 的 workflow（1 秒超时）
# 执行一个耗时 > 1 秒的 workflow
# 断言：durationPercent > 100

# 5. loop 内部不阻断验证
# 创建含 loop 节点（3 次迭代）的 workflow，budget: { max_tokens: 100 }
# 断言：loop 的 3 次迭代全部执行（不在迭代中阻断）
# 断言：loop 结束后的下一个顶层节点被阻断
```

**Pass criteria**: 所有 9 个 AC 断言通过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
