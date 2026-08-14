## Workflow Execution Observability — 执行可观测性增强

为 workflow 执行添加完整的可观测性能力：token 消耗追踪、预算控制、错误时间线、轮次明细。支持实时 SSE 更新和历史分析。

### 核心功能

**浮动面板增强**
- 4 摘要卡片（总 Token / 总轮次 / 预算进度 / 错误计数）
- 预算进度条（绿/黄/红三级颜色）
- "📊 观测详情"导航按钮

**观测详情页** (`/workspaces/:id/executions/:eid/observability`)
- Token 消耗趋势折线图（input/output/cost 多线）
- 节点消耗分解水平柱状图
- 模型用量占比饼图
- 错误时间线（5 种分类：timeout/model_error/script_error/approval_rejected/other）
- 轮次明细可展开表格（LLM/loop/swarm/retry）

**工作流级预算控制**
- YAML 顶层 `budget` 字段：`max_tokens` / `max_duration` / `max_cost_usd` / `alert_threshold`
- 执行开始时快照持久化到 `executions.budget_snapshot`
- 80% 阈值预警（可配置）
- `max_tokens` 超限时自动阻断执行（`budget_exceeded` 状态）

**实时 SSE**
- `execution_metrics` 事件：每次 `node_end` 后推送累计指标（节流 500ms）
- `execution_status` 事件：预算阻断时推送状态变更

### E2E Verification

| AC | Condition | Status |
|----|-----------|--------|
| AC-1 | 浮动面板 4 摘要卡片 | PASS |
| AC-2 | 观测页图表渲染 | PASS |
| AC-3 | budget_snapshot 写入 DB | PASS |
| AC-4 | 预算预警/阻断 | SKIP (需低预算 workflow) |
| AC-5 | 错误时间线 | PARTIAL (BUG-1 已修复) |
| AC-6 | 轮次明细展开 | PASS |
| AC-7 | CLI validate budget | PASS |
| AC-8 | 历史观测数据 | PASS |

### Changed Files

| Package | Key Changes |
|---------|-------------|
| `@octopus/shared` | `BudgetSchema` + `budget` on `WorkflowSchema` |
| `@octopus/server` | `ObservabilityQueryService`, `execution_metrics` SSE, budget enforcement, `budget_exceeded` status, error persistence fix |
| `@octopus/web-app` | `useExecutionMetrics` hook, floating panel summary cards, observability detail page with Recharts |
| `.claude/skills` | `octo-workflow-dev` budget documentation |

### Development Iterations

| # | Feature | Date | Tickets |
|---|---------|------|---------|
| 40 | workflow-observability | 08-12 | 7/7 done, 5 stages |

<!-- MANUAL-START -->
<!-- MANUAL-END -->
