# 05 — Web-app: useExecutionMetrics Hook + 浮动面板增强

## What to build
1. 新建 `useExecutionMetrics(workspaceId, executionId)` hook，订阅 `execution_metrics` SSE 事件
2. 在 `harness-floating-panel.tsx` 的 MonitorTab 顶部新增 4 个摘要卡片（总 Token / 总轮次 / 预算进度 / 错误计数）
3. 新增"📊 观测详情"导航按钮
4. 预算进度条：`budgetProgress` 非 null 时显示，null 时隐藏

## Blocked by
04-server-sse-budget-enforcement

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: `useExecutionMetrics` hook 订阅 `/executions/events` SSE 通道，过滤 `execution_metrics` 事件
- [ ] AC-2: hook 返回 `{ totalTokens, totalCost, totalTurns, budgetProgress, errorCount }`，实时更新
- [ ] AC-3: 浮动面板 MonitorTab 顶部显示 4 摘要卡片，数字与 SSE 数据一致
- [ ] AC-4: 预算进度条在 `budgetProgress.tokensPercent != null` 时显示，null 时隐藏
- [ ] AC-5: 进度条颜色：绿色 (<60%) → 黄色 (60-80%) → 红色 (>80%)
- [ ] AC-6: "📊 观测详情"按钮链接到 `/workspaces/:id/executions/:eid/observability`
- [ ] AC-7: 折叠状态的浮动面板显示总 token 摘要（替换现有仅 harness token 的显示）

## Verification Method
**Verification type**: Browser E2E

**Verification steps**:
```typescript
// 1. 启动 dev server + web-app
// 2. 在 workspace 页面触发一个含 budget 的 workflow 执行
// 3. 打开 harness 浮动面板
// 4. 断言：MonitorTab 顶部有 4 个摘要卡片
// 5. 等待 SSE 事件到达
// 6. 断言：总 Token 卡片数字 > 0 且在增长
// 7. 断言：预算进度条可见且百分比在增加
// 8. 断言："📊 观测详情"按钮可见
// 9. 点击按钮 → 断言：导航到 /workspaces/:id/executions/:eid/observability
// 10. 折叠面板 → 断言：折叠态显示总 token 数字
```

**Pass criteria**: 所有 7 个 AC 断言通过，E2E 测试 PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
