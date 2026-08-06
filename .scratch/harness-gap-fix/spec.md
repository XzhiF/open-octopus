# Spec: Harness Gap-Fix — 让悬浮窗口真正工作

## Problem Statement

Harness 功能已实现 ~90%：引擎回调、检测器、策略引擎、DAO、API 路由、前端组件全部就位。但悬浮面板只能**监控**，无法**干预**——因为关键的控制回路（StrategyEngine → 引擎回调）未连接。此外 chatbot 缺少必填字段、token 统计失效。

## Solution

修复 6 个 Gap，使 Harness 从"只读仪表盘"升级为"可干预控制系统"：

1. **连接决策回调** — Proxy 拦截 `onBeforeRetry`/`onFailureDecision`，将 StrategyEngine 的动作结果回传引擎
2. **注入 repairService** — 使 `inject_message` 动作可用
3. **修复 chatbot nodeId** — 让 chatbot 干预能到达真实服务端
4. **修复 token 统计** — `totalExtraTokens` 正确计算
5. **发射 harness_blocked 事件** — 进程冲突阻断时前端能收到通知
6. **清理死代码** — `getWrappedCallbacks()` 修复或删除

## Projects Involved

- [ ] `@octopus/server` — Gap #1, #2, #5, #6
- [ ] `@octopus/web-app` — Gap #3, #4

## Feature Scope

**Do:**
- 修复 6 个 Gap
- 编写/更新 E2E 测试覆盖真实干预场景
- 确保现有单元测试不被破坏

**Don't:**
- 不重写已有的检测器或策略引擎
- 不修改前端面板的 UI 设计
- 不添加新的检测器类型
- 不实现 Agent Delegation (Layer 3) 的完整流程

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 决策回调连接方式 | 在 Proxy 中追加 `onBeforeRetry`/`onFailureDecision` 拦截 | 复用现有 Proxy 架构，最小改动 |
| 2 | 干预结果传递 | StrategyEngine 维护 pendingActions map，`onBeforeRetry` 查询并消费 | 解耦诊断时机和决策时机 |
| 3 | repairService 注入 | 在 ExecutionLifecycle 构造时从 registry 获取并传给 HarnessController | 与现有依赖注入模式一致 |
| 4 | chatbot nodeId 策略 | chatbot 发送当前正在执行的失败/运行中节点 ID | 用户无需手动指定节点 |
| 5 | E2E 测试策略 | 在现有 harness-e2e.spec.ts 上追加真实干预测试 | 复用已有测试基础设施 |

## User Stories

1. **As a** 运维人员, **I want** harness 检测到傻重试后自动注入纠正指令并使引擎在下次重试时使用该指令, **so that** 干预不只是展示而是真正生效
2. **As a** 运维人员, **I want** harness 检测到模型不匹配后自动切换模型, **so that** 400 错误不会导致节点反复失败
3. **As a** 运维人员, **I want** 通过 chatbot 发送 inject 指令时请求能成功到达服务端, **so that** 我可以主动干预正在执行的节点
4. **As a** 运维人员, **I want** 悬浮面板显示正确的 harness token 消耗, **so that** 我能评估 harness 的成本
5. **As a** 运维人员, **I want** 进程冲突被阻断时面板显示 blocked 通知, **so that** 我能知道发生了什么

## Implementation Decisions

### Gap #1: 连接 onBeforeRetry / onFailureDecision

**文件**: `packages/server/src/services/harness/detector-pipeline.ts`

**改动**: 在 `wrapCallbacks()` 的 Proxy handler 中，追加对 `onBeforeRetry` 和 `onFailureDecision` 的拦截。

**数据流**:
```
onNodeRetry 触发 → StupidRetryDetector 产出 DiagnosisReport
  → StrategyEngine.handleReport() → 匹配 strategy → 执行 actions
    → actions 产出 InterventionResult { harnessHint?, modelOverride?, action? }
    → 存入 pendingActions[nodeId] map
    → SSE emit harness_intervention

onBeforeRetry 触发 → Proxy 拦截
  → 查询 pendingActions[nodeId]
  → 如有: 消费并返回 { action: "retry", harnessHint, modelOverride }
  → 如无: 调用原始 onBeforeRetry（如有）或返回 { action: "retry" }
```

**pendingActions 结构**:
```typescript
// 新增在 DetectorPipeline 类中
private pendingActions = new Map<string, {
  harnessHint?: string
  modelOverride?: string
  action: "retry" | "skip" | "abort" | "override"
  overrideResult?: NodeExecutionResult
}>()
```

**onFailureDecision 同理**: 查询 pendingFailureActions[nodeId]，返回 `{ action: "continue" | "abort" | "delegate" }`。

### Gap #2: 注入 repairService

**文件**: `packages/server/src/services/execution/ExecutionLifecycle.ts`

**改动**: 在构造 HarnessController 时传入 repairService：
```typescript
// 现有代码 (line ~122)
this.harnessController = new HarnessController({
  dao: harnessDAO,
  sse,
  configService: harnessConfigService,
  repairService: this.repairService,  // ← 新增
})
```

**前提**: `this.repairService` 需要从 ExecutionServiceRegistry 或构造函数获取。检查 ExecutionLifecycle 的依赖列表是否已有 repairService。

### Gap #3: 修复 chatbot nodeId

**文件**: `packages/web-app/components/workspace/harness-chatbot.tsx`

**改动**: 在 `handleSend` 中添加 `nodeId` 字段。

**策略**: chatbot 需要知道当前正在执行的节点。两种方式：
1. **从 execution tree 获取**: 找到 status 为 `running` 或最近 `failed` 的节点
2. **让用户选择**: 在 chatbot 中添加节点选择器

**推荐**: 方式 1（自动选择），回退到空字符串让服务端使用 nodeId 路由逻辑。

**Props 扩展**: HarnessChatbot 需要接收 `currentNodeId?: string` prop，由父组件 `WorkflowDetailPanel` 传入当前活跃节点 ID。

### Gap #4: 修复 totalExtraTokens

**文件**: `packages/web-app/hooks/use-harness-events.ts`

**改动**: 修复 reduce 逻辑，从 harness_intervention 或 harness_delegation 事件中提取 token 信息。

**当前问题**: reduce 的两个分支都返回 `sum`（无变化）。

**修复**: 从事件的 `result` 或 `tokenUsage` 字段中提取 token 数。具体字段取决于 harness_intervention 事件的 data 结构。

### Gap #5: 发射 harness_blocked 事件

**文件**: `packages/server/src/services/harness/strategy-engine.ts` 或 `actions/abort.ts`

**改动**: 当 strategy 匹配 `process_conflict` + severity `critical` 执行 `abort` 动作时，额外发射 `harness_blocked` SSE 事件。

### Gap #6: 清理 getWrappedCallbacks

**文件**: `packages/server/src/services/harness/harness-controller.ts`

**改动**: 修复 `getWrappedCallbacks` 方法：
```typescript
getWrappedCallbacks(executionId: string): EngineCallbacks | undefined {
  const pipeline = this.pipelines.get(executionId)
  return pipeline?.getWrappedCallbacks()  // 修复: 实际返回 wrapped callbacks
}
```
或者如果此方法无调用者，直接删除。

## Data Model Changes

无新增表或列。现有 `harness_events` 和 `harness_config` 表已在 Round 1 创建。

## API Contracts

无新增 API。现有 3 个 harness 端点已在 Round 1 实现：

| Method | Path | Status |
|--------|------|--------|
| GET | `/api/workspaces/:id/harness/config` | ✅ 已实现 |
| PUT | `/api/workspaces/:id/harness/config` | ✅ 已实现 |
| GET | `/api/workspaces/:id/harness/events/:execId` | ✅ 已实现 |
| POST | `/api/workspaces/:id/executions/:execId/harness-intervene` | ✅ 已实现（inject 已处理） |

## Verification Strategy

### Verification Environment

| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev` |
| API prefix | `/api/` |
| Database | SQLite: `~/.octopus/db/octopus.db` |
| Admin UI | `http://localhost:3000` |

### Test Users & Data

| Item | Value |
|------|-------|
| Test account | admin |
| Data prefix | harness_gap_ |
| Cleanup | DELETE harness_gap_* after test |

### AC to Verification Method Mapping

| # | AC | Verification Level | Method |
|---|----|-------------------|--------|
| AC1 | `onBeforeRetry` 返回 harnessHint 后，引擎下次重试使用 hint | 单元 + 集成 | 单元测试 mock + 集成测试验证 VarPool |
| AC2 | `onBeforeRetry` 返回 modelOverride 后，agent 节点使用新模型 | 单元 | Mock StrategyEngine 返回 modelOverride |
| AC3 | `onFailureDecision` 返回 "continue" 后，引擎继续执行 | 单元 | Mock + 引擎行为验证 |
| AC4 | `inject_message` 动作成功调用 repairService.intervene | 单元 | Mock repairService 验证调用 |
| AC5 | chatbot POST 请求包含 nodeId，服务端返回 200 | E2E | Playwright 操作 chatbot |
| AC6 | 悬浮面板 totalExtraTokens 显示非零值（当有 harness token 时） | E2E | Playwright 断言 |
| AC7 | process_conflict abort 时 SSE 发出 harness_blocked 事件 | 集成 | 运行测试 workflow + 检查 SSE |
| AC8 | 现有 harness 单元测试全部通过 | 单元 | `pnpm test` |

### Verification Methods Detail

#### Unit Tests

- **新增**: `detector-pipeline.test.ts` — 验证 `onBeforeRetry` 拦截逻辑：
  - 输入: pendingActions 有 harnessHint → 输出: `{ action: "retry", harnessHint: "..." }`
  - 输入: pendingActions 为空 → 输出: 调用原始回调或默认 `{ action: "retry" }`
  - 输入: pendingActions 有 modelOverride → 输出: `{ action: "retry", modelOverride: "..." }`

- **新增**: `detector-pipeline.test.ts` — 验证 `onFailureDecision` 拦截逻辑

- **更新**: `config-service.test.ts` — 验证 repairService 注入后 inject_message 成功

#### Browser E2E

- **更新**: `harness-e2e.spec.ts` — 追加测试：
  - chatbot 发送 inject → 请求 body 包含 nodeId → mock 返回 200
  - 面板 token 统计显示正确值

#### Integration Tests

- **新增**: 运行 `harness_test_stupid_retry` workflow → 验证：
  - `harness_events` 表有 diagnosis + intervention 记录
  - 节点的 VarPool 包含 `harness_hint`
  - SSE 发出 `harness_intervention` 事件

### Anti-Fake-Run Standards

| # | Criterion | Description |
|---|-----------|-------------|
| R1 | Real service | 使用 dev server 真实地址 |
| R2 | Business data | 验证 harness_hint 值，不只验证 HTTP 状态码 |
| R3 | Cross-validation | API ↔ DB: harness_events 记录 ↔ SSE 事件 |
| R4 | Evidence | 响应体 + DB 查询截图 |
| R5 | Side effects | inject_message 后验证 agent_events 有注入消息 |
| R6 | Real user path | 通过 UI 操作触发 workflow |
| R7 | Data isolation | harness_gap_ 前缀 |
| R8 | Repeatable | 无手动前置步骤 |

### Prerequisites

- [ ] `pnpm build` 通过
- [ ] dev 环境可启动 (`pnpm dev`)
- [ ] 现有 harness 单元测试通过

## Risks & Notes

- **R1: Proxy 性能** — 每个 retry 增加一次 pendingActions map 查询。影响可忽略（O(1) lookup）。
- **R2: 循环依赖** — repairService 注入可能引入循环依赖。需要在 ExecutionLifecycle 中通过 lazy import 或 registry 模式解决。
- **R3: pendingActions 内存泄漏** — 如果节点执行完毕但 pendingActions 未清理，可能泄漏。需要在 `onNodeEnd` 时清理对应 entry。

## Appendix: Core User Stories（闭环验证）

### Story 1: 傻重试自动纠正（Gap #1 修复后）

```
[Exec] bash-build 执行 "npm run build" → exit 1 "Cannot find module 'xyz'"
[Event] onNodeEnd(status: "failed")
[Exec] RetryPolicy 允许重试 → onNodeRetry(attempt: 2)

[Harness] DetectorPipeline Proxy 拦截 onNodeRetry:
  → StupidRetryDetector.observe() → DiagnosisReport
  → StrategyEngine.handleReport() → match: stupid_retry
  → Action: retry_with_hint → 产出 { harnessHint: "先 npm install" }
  → 存入 pendingActions["bash-build"]
  → SSE emit harness_intervention

[Exec] 第 3 次重试前:
  → onBeforeRetry(nodeId, attempt, lastResult) 触发
  → Proxy 拦截 → 查询 pendingActions["bash-build"]
  → 返回 { action: "retry", harnessHint: "先 npm install" }
  → 引擎 pool.set("harness_hint", "先 npm install")

[Exec] 第 3 次执行:
  → 脚本收到 $HARNESS_HINT → 先跑 npm install → npm run build → 成功
```

### Story 2: Chatbot 主动干预（Gap #2 + #3 修复后）

```
[UI] 用户在悬浮面板 Chatbot 输入: "告诉 agent-write 分两步写"
[Chatbot] POST /executions/:id/harness-intervene
  body: {
    nodeId: "agent-write",  ← Gap #3 修复: 现在包含 nodeId
    directive: { type: "inject", message: "分两步写...", issued_by: "user" }
  }
[Route] type === "inject" → repairService.intervene(executionId, "agent-write", message)
  ← Gap #2 修复: repairService 现在可用

[Agent] agent-write 收到注入消息 → 调整行为
```

### Story 3: 进程冲突阻断通知（Gap #5 修复后）

```
[Exec] bash-test 准备执行包含 kill $HOST_PID 的脚本
[Harness] ProcessConflictDetector (onBeforeNode):
  → DiagnosisReport { severity: "critical" }
  → StrategyEngine: match process_conflict → abort
  → SSE emit harness_intervention
  → SSE emit harness_blocked  ← Gap #5 修复: 现在发射
  → onBeforeNode 返回 { action: "skip" }

[UI] 悬浮面板显示:
  → 🚨 "进程冲突已阻断"
  → harness_blocked 事件出现在 timeline
```
