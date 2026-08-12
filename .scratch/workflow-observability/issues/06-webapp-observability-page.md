# 06 — Web-app: 观测详情页（Observability Page）

## What to build
新建观测详情页面 `app/workspaces/[id]/executions/[eid]/observability/page.tsx`，包含：
1. 4 个摘要卡片（总 Token / 总轮次 / 总成本 / 预算状态）
2. Token 消耗趋势折线图（时间轴，input/output/cost 多线）
3. 节点消耗分解水平柱状图
4. 模型用量占比饼图（可选）
5. 错误时间线列表（时间、节点、错误类型、重试次数、最终结果）
6. 轮次明细可展开表格（每节点 LLM 轮次 / loop 迭代 / swarm 轮数 / 重试次数）
7. 非 LLM 节点提示："Token 指标仅反映 LLM 消耗节点"

## Blocked by
03-server-observability-api, 05-webapp-hook-floating-panel

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: 页面路由 `app/workspaces/[id]/executions/[eid]/observability/page.tsx` 可访问
- [ ] AC-2: 4 摘要卡片显示的数字与 `GET /executions/:eid/observability` API 返回一致
- [ ] AC-3: 折线图渲染成功（SVG 元素存在），数据点 > 0
- [ ] AC-4: 水平柱状图渲染成功，柱状数量 == byNode 数组长度
- [ ] AC-5: 错误时间线列表条目数 == API 返回 errors 数组长度
- [ ] AC-6: 轮次明细可展开，展开后显示正确的 LLM/loop/swarm/retry 数据
- [ ] AC-7: 历史执行（已完成的）页面正常渲染（非实时模式，一次性加载）
- [ ] AC-8: 无预算的执行：预算卡片显示"未设预算"或隐藏进度条
- [ ] AC-9: 页面底部或摘要区域显示"Token 指标仅反映 LLM 消耗节点"提示

## Verification Method
**Verification type**: Browser E2E

**Verification steps**:
```typescript
// 1. 前置：执行一个含 ≥3 节点的测试 workflow（含 agent + 会失败的节点）
// 2. 等待执行完成
// 3. 导航到 /workspaces/:id/executions/:eid/observability
// 4. 等待页面加载完成
// 5. 断言：4 摘要卡片可见，截图保存
// 6. 断言：折线图 SVG 元素存在（document.querySelector('.recharts-line') 或类似）
// 7. 断言：水平柱状图元素存在
// 8. 断言：错误时间线列表有 ≥1 条目
// 9. 点击轮次明细展开按钮 → 断言：展开内容可见
// 10. API 交叉验证：fetch observability API → 断言页面数字 == API 数字
// 11. 截图保存为 E2E evidence
```

**Pass criteria**: 所有 9 个 AC 断言通过，E2E 测试 PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
