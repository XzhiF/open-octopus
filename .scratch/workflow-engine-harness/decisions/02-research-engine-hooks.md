# 02 — 引擎扩展点：怎么给 engine.ts 加钩子？

Type: research
Status: resolved
Blocked by: 01

## Question

engine.ts 是 2100 行的巨型类。要在不重构的前提下加扩展点：
- 在哪里加钩子？（executeSingleNodeWithRetry 前后？executeNodesSequential 循环内？）
- 什么形式？（middleware chain? EventEmitter? callback 注入?）
- 怎么保证向后兼容？

需要研究 engine.ts 的具体代码结构，找到最小侵入的注入点。

## Answer

### 1. engine.ts 关键方法定位

| 方法 | 行号 | 职责 |
|------|------|------|
| `run()` | L343-412 | 入口：precomputeHook → executeNodes → notify hooks → onComplete |
| `retryFrom()` | L414-~470 | 恢复入口：从失败节点重跑 topological sort 切片 |
| `executeSingleNode()` | L807-855 | 单节点执行：createExecutor → onNodeStart → execute → onNodeEnd → compact |
| `executeSingleNodeWithRetry()` | L859-937 | 重试包装：RetryPolicyResolver → retry loop → FailureClassifier → backoff → onNodeRetry |
| `executeNodes()` | L939-951 | 分发器：serial → Sequential, auto → Parallel |
| `executeNodesSequential()` | L954-1199 | 顺序循环：依赖检查 → execute_when → executeSingleNodeWithRetry → hooks → failure strategy |
| `executeNodesParallel()` | L1202-1551 | 层级并行：computeExecutionLevels → batches → Promise.allSettled → merge forks |

### 2. 现有回调机制

**EngineCallbacks 接口** (`packages/engine/src/engine.ts:51-67`) — 15 个回调：

```
onNodeStart, onNodeEnd, onNodeLog, onStatusChange, onError, onComplete,
onBranchStart, onBranchEnd, onAgentEvent, onSwarmEvent,
onNodeRetry, onNodeCompacted, onCheckpoint, onPipelineReloaded, onRuntimeNodeAdded
```

**回调使用链路**：
- Engine 内部调用 `this.callbacks?.onXxx?.(...)` (可选链调用)
- Server 侧 `EngineCallbacks` class (`packages/server/src/services/execution/EngineCallbacks.ts`) 实现了完整的回调构建：SSE 发射 + DB 持久化 + 可观测性
- `ExecutionLifecycle.buildCallbacks(id)` 委托给 `EngineCallbacksBuilder.buildCallbacks(executionId)`

**无 EventEmitter**：整个 engine/src 目录零 EventEmitter 使用。
**无 middleware 模式**：engine 内部没有 middleware chain 或 plugin 系统。
**Workflow Hooks**：`executeHooks()` (L1645) 执行 YAML 定义的 `on_node_success`/`on_node_failure` 等钩子，通过内联 bash/agent 节点执行。

### 3. 注入点分析 — 3 层 Harness 映射

#### 层 1：Detectors（观察层）— 零修改，纯回调包装

| Detector 需求 | 观察点 | 现有回调 | 注入方式 |
|---|---|---|---|
| 节点失败检测 | 节点执行结束 | `onNodeEnd(nodeId, status, ...)` L840 | 回调装饰器 |
| 重试消耗检测 | 重试触发时 | `onNodeRetry(nodeId, attempt, max, delay)` L923 | 回调装饰器 |
| Agent 异常检测 | Agent 事件流 | `onAgentEvent(nodeId, event)` | 回调装饰器 |
| 执行卡死检测 | 心跳停止 | `onAgentEvent` 中 `type: "heartbeat"` | 回调装饰器 |
| 错误升级检测 | 执行级错误 | `onError(nodeId, error)` L1145 | 回调装饰器 |

**注入方式**：在 `EngineCallbacks.buildCallbacks()` 返回的对象外包一层 Proxy/Decorator，拦截 `onNodeEnd`/`onNodeRetry`/`onAgentEvent`/`onError`，转发给 Detector pipeline。

**代码位置**：在 `ExecutionLifecycle.start()` (L218) 处，`this.buildCallbacks(id)` 返回后、传入 `engineFactory.createEngine()` 前插入包装层。

```typescript
// 伪代码 — 在 ExecutionLifecycle.start() L218 附近
const rawCallbacks = this.buildCallbacks(id)
const harnessedCallbacks = HarnessDetectorLayer.wrap(rawCallbacks, detectorPipeline)
const engine = this.engineFactory.createEngine(exec, wf.parsed, harnessedCallbacks, signal)
```

**修改成本：零**。纯外部包装，不动 engine.ts。

#### 层 2：Strategies（干预层）— 需要 2-3 个新回调

| Strategy 需求 | 干预点 | 当前代码 | 需要的回调 |
|---|---|---|---|
| 重试前干预 | retry loop 内，executeSingleNode 之前 | L886-895 | **`onBeforeRetry(nodeId, attempt, lastResult)`** ← 新增 |
| 失败策略干预 | failure strategy 决策点 | L1142-1154 (seq) / L1503-1533 (par) | **`onFailureDecision(nodeId, error, strategy)`** ← 新增 |
| 节点执行前拦截 | executeSingleNode 之前 | L814 (inside executeSingleNode) | **`onBeforeNode(nodeId, nodeType)`** ← 可选 |

**新增回调设计**：

```typescript
// 追加到 EngineCallbacks 接口 (engine.ts:51-67)
export interface EngineCallbacks {
  // ... 现有 15 个回调 ...

  // ★ Harness 新增 — 全部可选，向后兼容
  onBeforeRetry?: (nodeId: string, attempt: number, lastResult: NodeExecutionResult) =>
    Promise<{ action: "retry" | "skip" | "abort" | "override", overrideResult?: NodeExecutionResult }>
  onFailureDecision?: (nodeId: string, error: string, currentStrategy: string) =>
    Promise<{ action: "continue" | "abort" | "delegate" }>
  onBeforeNode?: (nodeId: string, nodeType: string) =>
    Promise<{ action: "proceed" | "skip" | "override", overrideResult?: NodeExecutionResult }>
}
```

**engine.ts 修改**：3 处插入点，每处 ~5 行代码：

**1. `executeSingleNodeWithRetry()` L886 循环内，`executeSingleNode()` 调用前**：

```typescript
// L886: for (let attempt = 1; ...) {
  // ★ NEW: onBeforeRetry hook
  if (attempt > 1 && this.callbacks?.onBeforeRetry) {
    const decision = await this.callbacks.onBeforeRetry(node.id, attempt, lastResult!)
    if (decision.action === "skip") return { ...lastResult!, status: "skipped" }
    if (decision.action === "abort") return { ...lastResult!, status: "failed" }
    if (decision.action === "override" && decision.overrideResult) return decision.overrideResult
  }
  const result = await this.executeSingleNode(node, pool, effectiveSignal)
```

**2. `executeNodesSequential()` L1142 失败策略决策前**：

```typescript
// L1142: const strategy = ...
// ★ NEW: onFailureDecision hook
if (this.callbacks?.onFailureDecision) {
  const decision = await this.callbacks.onFailureDecision(
    node.id, nodeResult.logLines?.join("\n") ?? "", strategy
  )
  if (decision.action === "continue") { this.hasPartialFailure = true; continue }
  if (decision.action === "delegate") { /* Agent Delegation takes over */ }
}
```

**3. (可选) `executeSingleNode()` L814 executor 创建前**：

```typescript
// L814: const executor = this.createExecutor(node, pool, signal)
// ★ NEW: onBeforeNode hook
if (this.callbacks?.onBeforeNode) {
  const decision = await this.callbacks.onBeforeNode(node.id, node.type)
  if (decision.action === "skip")
    return { outputs: {}, status: "skipped", durationMs: 0, logLines: ["Skipped by harness"] }
  if (decision.action === "override" && decision.overrideResult) return decision.overrideResult
}
```

**修改成本：低**。~15 行新代码加入 engine.ts，全部在可选链下，零破坏性。

#### 层 3：Agent Delegation（委托层）— 复用 onFailureDecision

| 委托需求 | 触发点 | 机制 |
|---|---|---|
| Strategy 失败后委托 | `onFailureDecision` 返回 `"delegate"` | Harness 拦截后启动独立 Agent 子流程 |
| 重试耗尽后委托 | `onBeforeRetry` 返回 `"abort"` + 后续处理 | Detector 检测到 max retries → 触发 Agent |
| 执行级失败委托 | `ExecutionLifecycle.start()` catch 块 L488 | 在 workflow hooks `on_workflow_failure` 前插入 |

**Agent Delegation 最佳挂钩位置**：`onFailureDecision` 回调返回 `"delegate"` 时，Harness 层接管执行：
- 暂停当前执行（通过 AbortController）
- 启动 Agent 会话（复用 AgentExecutor 基础设施）
- Agent 决策结果写回 VarPool
- 通过 `engine.retryFrom()` 恢复执行

### 4. 重构成本评估

| 方案 | 修改范围 | 向后兼容 | 成本 |
|------|---------|----------|------|
| **A. 回调装饰器（Detector 层）** | 仅 `ExecutionLifecycle.start()` 包装 callbacks | ✅ 完全兼容 | **零** |
| **B. 新增 2-3 个回调（Strategy 层）** | engine.ts +3 处 ~5 行, EngineCallbacks 接口 +3 字段 | ✅ 可选回调，默认不触发 | **低** (~30 行) |
| C. Middleware chain | 重构 executeSingleNode → 管道模式 | ❌ 破坏性 | **高** (不推荐) |
| D. EventEmitter 改造 | 全 engine 替换 callbacks → emit | ❌ 破坏性 | **高** (不推荐) |

### 5. Server 如何创建和管理 Engine

**实例化链路**：
1. `ExecutionLifecycle.constructor()` → 创建 `EngineFactory`, `EngineCallbacksBuilder`, `ExecutionRunner`
2. `ExecutionLifecycle.start(id)` →
   - 解析 workflow YAML → 写 snapshot
   - `this.buildCallbacks(id)` → `EngineCallbacksBuilder.buildCallbacks(executionId)` → `EngineCallbacks` 对象
   - `this.engineFactory.createEngine(exec, wf.parsed, callbacks, signal)` → `new WorkflowEngine(...)`
   - `this.enginePool.create(id, engine, abortController)` → 存入 `EnginePool`
   - `engine.setPipelineConfig(config, checkpointStore, pipelinePath)` → 注入重试/检查点
   - `EngineInitPhase.run(...)` → 虚拟初始化节点
   - `engine.run()` → 实际执行
3. `ExecutionLifecycle.retry(id)` → 重建 engine (`reconstructEngine`) 或复用 EnginePool 中的实例 → `engine.retryFrom(failedNodeId)`

**生命周期管理**：
- `EnginePool` 管理活跃 engine 实例（`create/get/remove/cancel`）
- `AbortController` 控制取消
- `enginePool.startRun(id)` 返回 settle 函数，防止 resume 与正在运行的 engine 竞争
- `ExecutionRunner` 管理后台异步任务（resume/approve/reject）

**关键文件路径**：
- `packages/engine/src/engine.ts` — 2109 行引擎核心
- `packages/engine/src/executor-factory.ts` — 执行器工厂
- `packages/server/src/services/execution/ExecutionLifecycle.ts` — 1477 行生命周期管理
- `packages/server/src/services/execution/EngineFactory.ts` — 引擎创建 (198 行)
- `packages/server/src/services/execution/EngineCallbacks.ts` — 回调实现 SSE+DB+可观测性 (345 行)
- `packages/server/src/services/execution/ExecutionRunner.ts` — 后台执行器
- `packages/server/src/services/execution/EnginePool.ts` — 实例池
- `packages/server/src/services/execution/HookExecutor.ts` — 工作流钩子执行
- `packages/server/src/services/execution/interfaces.ts` — 接口定义

### 6. 推荐方案

**采用 A+B 组合方案**：

1. **Detector 层**：在 `ExecutionLifecycle.start()` 处用 Proxy 包装 callbacks → 零 engine.ts 修改
2. **Strategy 层**：在 `EngineCallbacks` 接口新增 3 个可选回调 → engine.ts +15 行
3. **Agent Delegation 层**：复用 `onFailureDecision` 回调 + `ExecutionLifecycle` 级 hook → 零 engine.ts 修改

总修改量：~30 行 engine.ts（3 个 if 块 + 接口扩展），~50 行 Harness 层代码。
向后兼容：所有新回调均为可选，不影响现有行为。