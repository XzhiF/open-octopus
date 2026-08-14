# Spec: Workflow Execution Observability — 执行可观测性增强

## Problem Statement

当前 workflow harness 浮动面板只监控 harness 自身行为（干预/诊断/阻断事件），显示的 token 仅是 harness 委派的消耗。用户无法在一个视图中看到：
1. **完整执行的 token/cost 总量** — 需要手动去多个页面拼凑
2. **轮次概览** — LLM 调用轮次、loop 迭代、swarm 讨论轮数、重试次数分散在不同地方
3. **预算 vs 实际** — 预算只在 YAML 定义，执行完就丢失，无法回溯分析
4. **错误时间线** — 错误信息分散在多个表/页面，缺乏时间维度的可视化

## Solution

在现有 harness 浮动面板基础上增加**两层观测能力**：

```
Layer 1: 浮动面板增强（摘要层）
  → 一眼可见：总 token、总轮次、预算进度、错误计数

Layer 2: 独立观测详情页（分析层）
  → 多维图表：token 趋势折线图、节点消耗柱状图、模型占比饼图
  → 错误时间线、轮次展开明细
  → 实时 SSE 更新 + 历史只读分析
```

数据链路：
```
YAML budget → 执行开始快照 → 节点结束时聚合 → SSE 推送 → 前端图表渲染
                    ↓
              executions.budget_snapshot（持久化）
```

## Projects Involved

- [ ] `@octopus/shared` — workflow schema 增加 budget 字段（Zod）
- [ ] `@octopus/engine` — 执行开始时传递 budget 到回调
- [ ] `@octopus/server` — DB migration + 预算快照写入 + 聚合 API + SSE 增强 + 预算预警通知
- [ ] `@octopus/web-app` — 浮动面板摘要增强 + 观测详情页 + 图表组件
- [ ] `@octopus/cli` — workflow validate 支持 budget 字段
- [ ] `@octopus/core-pack` — octo-workflow-dev skill 文档更新

## Feature Scope

**Do:**
- workflow YAML 顶层 `budget` 可选字段（max_tokens / max_duration / max_cost_usd）
- 执行级预算快照持久化（executions.budget_snapshot）
- 浮动面板摘要卡片（总 token / 总轮次 / 预算进度 / 错误计数）
- 独立观测详情页（4 卡片 + 折线图 + 柱状图 + 饼图 + 错误时间线 + 轮次明细）
- 实时 SSE 更新（复用现有 /executions/events）
- 历史只读分析（执行完成后可随时查看）
- 预算预警通知（80% 阈值，通过 agent notify 模块，可配置）
- 预算强制执行仅限 max_tokens（节点边界检查）
- octo-workflow-dev skill 文档更新
- CLI validate 支持 budget 字段

**Don't:**
- 不做 Agent 级 / 系统级预算配置（仅 workflow 级）
- 不做预算的多层级覆盖逻辑
- 不做 max_cost_usd / max_duration 的自动阻断（仅通知）
- 不修改 harness 干预/诊断/阻断的现有逻辑
- 不引入新的图表库以外的可视化依赖
- 不实现跨执行的聚合分析（每个执行独立）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| KD-1 | 观测面板架构 | 浮动面板摘要 + 独立详情页 | 摘要一眼可见，详情深度分析，不拥挤 |
| KD-2 | Token 指标粒度 | 多维分解 + 时间线图表 | 按节点/模型/来源分解 + 时间趋势，定位"哪里烧钱" |
| KD-3 | 轮次展示 | 统一总数 + 按节点展开明细 | 顶部大数字 + 展开看每节点 LLM/loop/swarm/retry |
| KD-4 | 预算配置层级 | 仅 workflow YAML 顶层 | 简单优先，未来可扩展 Agent 级 / 系统级 |
| KD-5 | 预算持久化 | 执行开始时快照写入 executions 表 | 历史可回溯，不受 YAML 后续修改影响 |
| KD-6 | 预算预警 | 80% 阈值（可配置）+ engine notify 模块 | 默认通知不阻断，通知渠道配在 workflow YAML providers/channels |
| KD-7 | 错误展示 | 摘要 + 时间线 | 时间线最直观，分类聚合后续迭代 |
| KD-8 | 预算快照写入时机 | `ExecutionLifecycle.start()` 中 `getWorkflow()` 之后、engine 创建之前 | YAML 已解析，最早可靠写入点 |
| KD-9 | 执行指标聚合数据源 | 主源：`llm_calls` 表（有 `execution_id`）；备源：`node_token_usages` JOIN `node_executions` | `llm_calls` 直接关联执行，无需 JOIN |
| KD-10 | 前端 hook 架构 | 新 `useExecutionMetrics` hook（独立于 `useHarnessEvents`） | 关注点分离：harness 事件 ≠ 执行指标 |
| KD-11 | 预算检查注入点 | `onNodeEnd`（预警）+ `onBeforeNode`（阻断），在 harness pipeline 之前 | 预算是硬约束，先于 harness 干预 |
| KD-12 | 通知系统选择 | Engine notify module（workflow YAML providers/channels） | 自包含，不依赖 agent 配置系统 |
| KD-13 | 错误分类 | 关键词匹配 `classifyError(error, nodeType)` 函数 | 简单可扩展，无需改表 |
| KD-14 | Loop/Swarm 轮次计数 | 从子 `node_executions.iteration_index` 计算 | 避免 schema 变更，数据已有 |
| KD-15 | SSE 事件命名 | 使用 `execution_status`（不用 `status_change`） | `status_change` 是 shared schema 中的死代码，server 从未 emit |
| KD-16 | 预算阻断范围 | 仅顶层节点边界；loop 内部使用 `octopus_agent task.budget` 或 swarm `budget` | `onBeforeNode` 不对 loop 内部节点触发，架构限制 |
| KD-17 | `budget_exceeded` 状态 | 新增为有效执行状态 | 需要在 ExecutionLifecycle + 前端 badge 中处理 |

## User Stories

1. **US-1**: 作为工作流运行者，我希望在执行过程中，harness 浮动面板显示总 token 消耗、总轮次、预算进度和错误计数，这样我能一眼掌握执行健康状况
2. **US-2**: 作为工作流运行者，我希望点击浮动面板的"详情"进入独立观测页，看到 token 消耗趋势折线图和节点消耗柱状图，这样我能定位资源消耗瓶颈
3. **US-3**: 作为工作流运行者，我希望在 YAML 中设置工作流级预算（max_tokens / max_duration / max_cost_usd），执行时自动追踪预算 vs 实际，这样我能控制成本
4. **US-4**: 作为工作流运行者，我希望预算消耗达到 80% 时收到通知，max_tokens 超限时自动阻断执行，这样我不会意外超支
5. **US-5**: 作为工作流运行者，我希望在观测页看到错误时间线（时间、节点、错误类型、重试次数、最终结果），这样我能快速定位失败原因
6. **US-6**: 作为工作流运行者，我希望观测页的轮次明细可展开查看每个节点的 LLM 轮次 / loop 迭代 / swarm 轮数 / 重试次数，这样我能理解执行结构
7. **US-7**: 作为工作流开发者，我希望 `octopus workflow validate` 能校验 budget 字段格式，这样我在编写 YAML 时就能发现预算配置错误
8. **US-8**: 作为工作流运行者，我希望执行完成后仍能查看历史观测数据，这样我能事后分析执行表现

## Implementation Decisions

### 模块变更

#### `@octopus/shared` — Zod Schema

workflow schema 增加顶层 `budget` 可选字段：

```typescript
const BudgetSchema = z.object({
  max_tokens: z.number().int().positive().optional(),
  max_duration: z.number().int().positive().optional(),  // 秒
  max_cost_usd: z.number().positive().optional(),
  alert_threshold: z.number().min(0).max(1).optional().default(0.8),
}).optional();

// 加入 WorkflowSchema
budget: BudgetSchema
```

#### `@octopus/engine` — 无需改动

- Engine 不需要额外的 budget 参数——预算快照和检查都在 server 层（ExecutionLifecycle + EngineCallbacks）完成
- `onBeforeNode` 回调由 server 层注入预算检查逻辑
- **限制**：`onBeforeNode` 仅对顶层节点触发，loop 内部节点不经过此回调。loop 内部的预算控制需使用 `octopus_agent` 节点的 `task.budget` 或 swarm 节点的 `budget` 字段

#### `@octopus/server` — DB Migration

**executions 表新增字段**：
```sql
ALTER TABLE executions ADD COLUMN budget_snapshot TEXT DEFAULT NULL;
-- JSON: { "max_tokens": 100000, "max_duration": 300, "max_cost_usd": 2.0, "alert_threshold": 0.8 }
```

**预算快照写入**（BP-A/B 修复）：
- 在 `ExecutionLifecycle.start()` 中，`getWorkflow()` 之后、engine 创建之前：
  ```typescript
  if (wf.parsed.budget) {
    await dao.updateExecution(execId, {
      budget_snapshot: JSON.stringify(wf.parsed.budget)
    })
  }
  ```

**聚合查询**（BP-H 修复）：
- 主数据源使用 `llm_calls` 表（直接有 `execution_id` 列）
- 执行级 token 汇总：`SUM(input_tokens) + SUM(output_tokens)` FROM `llm_calls` WHERE `execution_id = :eid`
- 执行级 cost 汇总：`SUM(cost_usd)` FROM `llm_calls` WHERE `execution_id = :eid`
- 执行级轮次汇总：`COUNT(*)` + `MAX(turn_index)` FROM `llm_calls` WHERE `execution_id = :eid`
- 备数据源：`node_token_usages` JOIN `node_executions`（当 `llm_calls_persist` flag 关闭时）

**新增 API 端点**：

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/workspaces/:id/executions/:eid/observability` | 完整观测数据（token 汇总 + 按节点分解 + 按模型分解 + 时间序列 + 预算快照 + 错误时间线 + 轮次明细） |

**新增 `ObservabilityQueryService`**：
- `getObservabilityData(executionId)`: 聚合查询入口
- `classifyError(error, nodeType)`: 错误分类函数（BP-M 修复）
  - `'timeout'` — error 包含 'timeout' / 'timed out'
  - `'model_error'` — error 包含 'model' / 'rate_limit' / 'overloaded'
  - `'script_error'` — nodeType 为 bash/python 且 exit_code != 0
  - `'approval_rejected'` — status 为 rejected
  - `'other'` — 兜底
- Loop 迭代次数：`SELECT MAX(iteration_index) FROM node_executions WHERE parent_node_id = :loopNodeId`（BP-N 修复）
- Swarm 讨论轮数：从 JSONL swarm 事件或 `agent_events` 中计算

**SSE 增强**（BP-C 修复）：
- 现有 `node_end` 事件已携带 `costUsd` / `turnCount` / `toolCount` / tokens
- 新增 `execution_metrics` SSE 事件：在 `EngineCallbacks.onNodeEnd` 中，token 数据写入 DB 后：
  1. 调用 `computeExecutionMetrics(executionId)` 从 `llm_calls` 聚合
  2. 与 `budget_snapshot` 对比计算 progress
  3. 节流（throttle）最多 500ms emit 一次
  4. 通过现有 SSE 通道推送

**预算预警**（BP-I/J 修复）：
- 在 `EngineCallbacks.onNodeEnd` 中，`execution_metrics` emit 之后：
  1. 检查累计 token 是否超过 `budget_snapshot.max_tokens * alert_threshold`（默认 0.8）
  2. 达到阈值 → 通过 **engine notify module**（workflow YAML 的 `providers`/`channels`）发送通知
  3. 如果 workflow YAML 未配置 `providers`/`channels`，仅 log warning 到 server console
- 超过 `max_tokens` → 在 `onBeforeNode`（harness pipeline 之前）阻断：
  1. 设置执行状态为 `budget_exceeded`（BP-L 修复）
  2. 通过 SSE emit `execution_status`（不是 `status_change`，BP-S 修复）
  3. 调用 `onComplete` 结束执行

**`budget_exceeded` 执行状态**（BP-L 修复）：
- 新增为有效执行状态值
- `ExecutionLifecycle.updateStatus()` 处理此状态
- 前端 status badge 渲染（红色，显示"预算超限"）

**`max_duration` 追踪**（BP-P 修复）：
- 使用 `executions.started_at` 计算已过时间
- `durationPercent = (Date.now() - started_at) / (max_duration * 1000) * 100`

#### `@octopus/web-app` — 前端组件

**新 hook：`useExecutionMetrics`**（BP-D 修复）：
- 独立于 `useHarnessEvents`，专门订阅 `execution_metrics` SSE 事件
- 返回 `{ totalTokens, totalCost, totalTurns, budgetProgress, errorCount }`
- 浮动面板 MonitorTab 消费此 hook

**浮动面板增强** (`harness-floating-panel.tsx`)：
- 现有"监控"tab 顶部新增 4 个摘要卡片
- 数据来源：`useExecutionMetrics` hook（非 `useHarnessEvents`）
- 预算进度条：当 `budgetProgress` 非 null 时显示，null 时隐藏（"不限"状态）
- 新增"📊 观测详情"按钮（BP-E 修复），链接到观测详情页

**观测详情页**（BP-F/O 修复，使用正确路径）：
- 路由：`app/workspaces/[id]/executions/[eid]/observability/page.tsx`（**workspaces** 复数）
- 4 摘要卡片（总 Token / 总轮次 / 总成本 / 预算状态）
- Token 消耗趋势折线图（时间轴，input/output/cost 多线）
- 节点消耗分解水平柱状图
- 模型用量占比饼图（可选区块）
- 错误时间线列表
- 轮次明细可展开表格
- 非 LLM 节点提示（BP-R 修复）："Token 指标仅反映 LLM 消耗节点"

**图表库选型**：
- 沿用项目现有图表库（确认 `components/charts/` 使用的库，如 Recharts）
- 与现有 cost-waterfall、llm-sankey 等图表风格保持一致

#### `@octopus/cli` — Validate 增强

- `octopus workflow validate` 调用 shared 的 Zod schema 解析，budget 字段格式错误时给出明确提示

#### `@octopus/core-pack` — Skill 更新

- `octo-workflow-dev` skill 文档增加 `budget` 字段说明和示例

### 接口定义

#### GET `/api/workspaces/:id/executions/:eid/observability`

**Response**:
```typescript
interface ObservabilityData {
  executionId: string;
  status: string;

  // Token 汇总
  tokens: {
    totalInput: number;
    totalOutput: number;
    totalCache: number;
    totalCostUsd: number;
  };

  // 按节点分解
  byNode: Array<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    llmTurns: number;
    loopIterations: number;
    swarmRounds: number;
    retryCount: number;
    durationMs: number;
    error: string | null;
  }>;

  // 按模型分解
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    callCount: number;
  }>;

  // 时间序列（用于折线图）
  timeSeries: Array<{
    timestamp: string;
    nodeId: string;
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
    cumulativeCostUsd: number;
    turnIndex: number;
  }>;

  // 预算
  budget: {
    snapshot: { max_tokens?: number; max_duration?: number; max_cost_usd?: number } | null;
    progress: {
      tokensPercent: number | null;   // null = 未设预算
      durationPercent: number | null;
      costPercent: number | null;
    };
    alerts: Array<{
      type: 'warning' | 'exceeded';
      metric: 'tokens' | 'duration' | 'cost';
      threshold: number;
      actual: number;
      timestamp: string;
    }>;
  };

  // 错误时间线
  errors: Array<{
    timestamp: string;
    nodeId: string;
    nodeName: string;
    errorType: string;       // 'timeout' | 'model_error' | 'script_error' | 'approval_rejected' | 'other'
    errorMessage: string;
    retryCount: number;
    finalStatus: string;     // 'recovered' | 'failed' | 'skipped'
  }>;

  // 轮次汇总
  rounds: {
    totalLlmTurns: number;
    totalLoopIterations: number;
    totalSwarmRounds: number;
    totalRetries: number;
  };
}
```

### SSE 事件增强

**新增事件类型 `execution_metrics`**：
```typescript
{
  type: 'execution_metrics',
  executionId: string,
  data: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    totalLlmTurns: number;
    budgetProgress: {
      tokensPercent: number | null;
      durationPercent: number | null;
      costPercent: number | null;
    };
    errorCount: number;
    timestamp: string;
  }
}
```

**`budget_exceeded` 状态变更**（使用 `execution_status`，非 `status_change`）：
```typescript
{
  type: 'execution_status',
  executionId: string,
  data: {
    status: 'budget_exceeded',
    reason: 'max_tokens exceeded',
    budgetSnapshot: { max_tokens: number, actual: number }
  }
}
```

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `executions` | ADD COLUMN | `budget_snapshot TEXT DEFAULT NULL` — JSON 存储预算快照 |

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/api/workspaces/:id/executions/:eid/observability` | Server | — | `ObservabilityData` | 完整观测数据 |

SSE 增强（复用现有 `/executions/events`）：
- 新增 `execution_metrics` 事件类型

## Design Specs

- Figma link: 无
- Fidelity: 以 spec 中 ASCII 布局为准
- 图表风格与现有 `components/charts/` 保持一致

## Verification Strategy

### Verification Environment

| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev` |
| API prefix | `/api/` |
| Server port | 3001 |
| Web port | 3000 |
| Database | SQLite: `~/.octopus/db/octopus.db` |
| Test workspace | 新建专用测试 workspace |
| Test workflow | 新建含 budget 的测试 workflow（≥3 节点，含 agent + 可失败节点） |

### Test Users & Data

| Item | Value |
|------|-------|
| Test account | 本地 dev 用户 |
| Data prefix | `OBS_TEST_` |
| Cleanup | 测试完成后删除测试 workspace |

### AC to Verification Method Mapping

| US# | User Story | AC | Verification Level | Verification Method |
|-----|-----------|-----|-------------------|---------------------|
| US-1 | 浮动面板摘要 | AC-1: 浮动面板显示 4 摘要卡片，数据与 API 一致 | Browser E2E | 执行测试 workflow → 打开浮动面板 → 截图对比 + API 交叉验证 |
| US-2 | 观测详情页图表 | AC-2: 观测页渲染折线图+柱状图+饼图，数据非空 | Browser E2E | 导航到观测页 → 等待图表渲染 → 截图 + DOM 断言 |
| US-3 | 预算追踪 | AC-3: executions.budget_snapshot 正确写入，API 返回预算对比数据 | Integration | 执行含 budget 的 workflow → SELECT executions → 断言 budget_snapshot JSON |
| US-4 | 预算预警 | AC-4: token 达到 80% 触发通知；max_tokens 超限阻断执行 | Integration | 执行低预算 workflow → 验证通知发送 + 执行被阻断 |
| US-5 | 错误时间线 | AC-5: 错误时间线显示所有失败/重试事件 | Browser E2E | 执行含失败节点的 workflow → 观测页错误时间线条目数与 DB 一致 |
| US-6 | 轮次明细 | AC-6: 轮次明细可展开，每节点 LLM/loop/swarm/retry 数据正确 | Browser E2E | 展开轮次明细 → 对比 API 返回的 byNode 数据 |
| US-7 | CLI validate | AC-7: `octopus workflow validate` 校验 budget 字段 | Integration | 对含非法 budget 的 YAML 运行 validate → 断言错误消息 |
| US-8 | 历史观测 | AC-8: 执行完成后观测 API 仍可访问，数据完整 | Integration | 执行完成 → GET observability API → 断言所有字段非空 |

### Verification Methods Detail

#### Integration Tests

```bash
# 预算快照写入
curl http://localhost:3001/api/workspaces/{wid}/executions/{eid} | jq '.budget_snapshot'
# 断言: { "max_tokens": 100000, "max_duration": 300, "max_cost_usd": 2.0 }

# 观测 API
curl http://localhost:3001/api/workspaces/{wid}/executions/{eid}/observability | jq '.'
# 断言: tokens.totalInput > 0, byNode.length >= 3, budget.snapshot 非 null

# CLI validate
echo 'budget:\n  max_tokens: -1' > /tmp/bad.yaml
octopus workflow validate /tmp/bad.yaml
# 断言: 输出含 budget 格式错误提示

# 预算阻断
# 设置 max_tokens: 100（极低）→ 执行 agent 节点 → 第二个节点应被阻断
```

#### Browser E2E

```typescript
// 1. 执行测试 workflow
// 2. 打开浮动面板 → 断言 4 摘要卡片可见
// 3. 点击"详情" → 导航到观测页
// 4. 等待图表渲染 → 截图
// 5. 断言折线图、柱状图、饼图 SVG 元素存在
// 6. 展开错误时间线 → 断言条目数
// 7. 展开轮次明细 → 断言节点数
```

### Anti-Fake-Run Standards (R1-R8)

| # | Criterion | Description |
|---|-----------|-------------|
| R1 | Real service | 使用真实 dev server（localhost:3001），不 mock |
| R2 | Business data | 断言具体 token 数值 > 0，不仅断言字段存在 |
| R3 | Cross-validation | API 返回的 totalInput == DB `SUM(node_token_usages.input_tokens)` |
| R4 | Evidence | 保留 API response body + DB 查询结果 |
| R5 | Side effects | budget_snapshot 写入验证：API 断言 + 直接 SELECT |
| R6 | Real user path | 通过 UI 触发工作流执行，不直接 POST API |
| R7 | Data isolation | OBS_TEST_ 前缀标识测试数据 |
| R8 | Repeatable | 测试 workspace + workflow 脚本化创建，无需手动准备 |

### Prerequisites

- [ ] 本地 dev 环境可用（`pnpm dev`）
- [ ] Claude API key 已配置（真实执行 agent 节点）
- [ ] 测试 workspace 和测试 workflow 脚本化创建
- [ ] Playwright 已安装（E2E 测试）

## Risks & Notes

- R1: 实时 SSE 高频推送 execution_metrics 时，如果节点非常多，前端可能有渲染压力 → 节流（throttle）到每 500ms 最多一次
- R2: 图表库选型需确认项目现有依赖，避免引入冗余
- R3: 预算"不限"状态下进度条不显示，需确保 UI 优雅降级
- R4: max_tokens 阻断在节点边界执行，如果单个 agent 节点内部消耗过大，阻断可能不够及时 → 依赖心跳的 `auto_abort_on_budget` 机制（已有）

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **Budget Snapshot** | 执行开始时从 workflow YAML 复制的预算配置副本，持久化在 executions 表，不受后续 YAML 修改影响 |
| **Observability Page** | 独立的执行观测详情页，包含多维图表和时间线，从浮动面板"详情"入口进入 |
| **Execution Metrics Event** | SSE 事件类型，每次 node_end 后推送执行级累计汇总数据 |
| **Budget Progress** | 预算消耗百分比（tokens/duration/cost），null 表示未设置该维度预算 |

## Appendix: Core User Stories（闭环验证）

### Story 1: 执行中实时观测

```
[UI] 用户在 web-app 触发 workflow 执行
  → [API] POST /executions 创建执行（携带 budget 参数）
  → [Exec] ExecutionLifecycle.start() → getWorkflow() → 写入 budget_snapshot
  → [Data] executions 表写入 budget_snapshot JSON
  → [Exec] 节点 1（agent）开始执行
  → [Event] SSE: node_start
  → [Exec] 节点 1 LLM 调用，产生 token
  → [Event] SSE: node_end（携带 costUsd, turnCount, tokens）
  → [Exec] EngineCallbacks: 写入 llm_calls → computeExecutionMetrics()
  → [Event] SSE: execution_metrics（累计汇总 + budget_progress）
  → [UI] useExecutionMetrics hook 接收 → 浮动面板摘要卡片实时更新
  → [UI] 用户点击"📊 观测详情" → 导航到观测页
  → [API] GET /executions/:eid/observability
  → [UI] 折线图、柱状图渲染
  → 验证点: 摘要卡片数字 == API 返回数字
```

### Story 2: 预算预警 + 阻断

```
[UI] 用户创建含 budget: { max_tokens: 5000, providers: [hermes] } 的 workflow
  → [API] POST /executions
  → [Data] budget_snapshot = { "max_tokens": 5000, "alert_threshold": 0.8 }
  → [Exec] 节点 1（agent）执行，消耗 4200 tokens
  → [Event] SSE: execution_metrics（tokensPercent: 84%）
  → [Exec] EngineCallbacks.onNodeEnd: 检查 4200 > 5000*0.8 → 触发通知
  → [Notify] Engine notify module 读取 workflow YAML providers/channels → Hermes 发送预警
  → [Exec] 节点 1 完成，累计 4800 tokens
  → [Exec] 节点 2 开始前 → onBeforeNode 预算检查（在 harness pipeline 之前）
  → [Exec] 4800 < 5000 → 放行（如果超过则阻断）
  → [Event] SSE: execution_status { status: "budget_exceeded" }（如超限时）
  → [UI] 浮动面板预算卡片显示红色 + "已超限"
  → 验证点: notifications 有预警记录 + 执行状态为 budget_exceeded
```

### Story 3: 执行后历史分析

```
[UI] 用户选择一个已完成的执行
  → [UI] 进入观测详情页（从执行列表或浮动面板入口）
  → [API] GET /executions/:eid/observability
  → [Data] 返回完整历史数据（tokens, byNode, byModel, timeSeries, errors, rounds）
  → [Data] tokens 从 llm_calls 聚合（非 node_token_usages）
  → [Data] errors 经 classifyError() 分类为 5 种类型
  → [Data] rounds 中 loopIterations 从子 node_executions.iteration_index 计算
  → [UI] 所有图表正常渲染（非实时，一次性加载）
  → [UI] 错误时间线显示 2 个条目（1 次超时重试成功 + 1 次脚本错误失败）
  → [UI] 轮次明细展开 node-1: LLM 12 轮 / 重试 1 次
  → [UI] 底部注释："Token 指标仅反映 LLM 消耗节点"
  → 验证点: API 返回 byNode.length == 实际节点数, errors.length == DB 中 error 记录数
```

### Story 4: CLI 预算校验

```
[CLI] 用户编写 workflow.yaml 含 budget: { max_tokens: "abc" }
  → [CLI] octopus workflow validate workflow.yaml
  → [Shared] Zod schema 解析 budget → max_tokens 应为 number，实际为 string
  → [CLI] 输出: "budget.max_tokens: Expected number, received string"
  → 验证点: validate 命令退出码 != 0, 输出含 budget 错误提示
```
