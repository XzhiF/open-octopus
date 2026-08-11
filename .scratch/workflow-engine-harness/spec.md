# Spec: WorkflowEngine Harness — Agentic 监督层

## Problem Statement

Octopus WorkflowEngine 在执行复杂工作流时存在三类致命问题：

1. **Agent 傻重试**: 节点失败后重试同样的方法（如 bash 缺依赖反复跑同样命令），10 分钟超时浪费，workflow 卡死
2. **进程冲突**: e2e 测试节点启动服务占用宿主端口，或脚本杀死宿主进程，导致整个 Octopus 服务崩溃
3. **能力不匹配**: agent 节点使用不支持的模型能力（如文本模型读图片），反复 400 错误无法自动纠正

根本原因：引擎缺少一个**有自主判断能力的监督层**——能检测异常、分析原因、主动干预。

## Solution

为 WorkflowEngine 增加一个 **Agentic Harness** —— 三层委托架构的监督层：

- **Layer 1: Detector Pipeline** — 可插拔的检测器，观察引擎事件，产出结构化诊断报告
- **Layer 2: Strategy Engine** — 可配置的策略表（harness.yaml），快速匹配常见异常并执行预定义动作
- **Layer 3: Agent Delegation** — 复杂场景委托给 Octopus 内置 Agent 分身，进行深度分析和纠正

所有干预过程通过 SSE 事件可观测，UI 提供悬浮面板实时监控 + chatbot 主动干预能力。

## Projects Involved

- [x] `@octopus/engine` — 新增 3 个可选回调 + 进程隔离增强
- [x] `@octopus/server` — Harness Controller 模块 + SSE 事件 + API
- [x] `@octopus/shared` — 新增类型定义 + harness-defaults.yaml
- [x] `@octopus/web-app` — 悬浮面板 + DAG 标记 + LogViewer 增强

## Feature Scope

**Do:**
- 三层委托架构 (Detectors → Strategies → Agent Delegation)
- 4 个 P0 检测器 (傻重试 / 模型不匹配 / 进程冲突 / 超时级联)
- 4 种干预模式 (注入指令 / Agent 接管 / 改 VarPool / 改定义) + 模型切换
- 全局 harness.yaml 配置 + 系统管理 UI 编辑面板
- 渐进式进程隔离 (基础层全平台 + 增强层 Linux/macOS)
- UI 悬浮面板 (可拖拽/缩放) + chatbot 干预 + DAG 节点标记
- 3 个新节点状态 (harness_intervening / harness_modified / harness_executed)
- Harness token 计费集成

**Don't:**
- 不修改 workflow.yaml 格式（harness 是系统层，不是 workflow 层）
- 不替换现有的重试策略和失败策略（harness 是增强层，不是替代）
- 不做容器级沙箱（Docker/K8s）
- 不做 OpenTelemetry 分布式追踪导出
- 不做经验升级（Phase 2+）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Harness 角色定位 | 三层委托: Detectors → Strategies → Agent Delegation | 常见场景规则快处理(80%)，复杂场景 Agent 智能处理(20%) |
| 2 | 引擎扩展方式 | 回调装饰(零改动) + 3 个新可选回调(~30 行) | 最小侵入，完全向后兼容 |
| 3 | 配置存储 | 全局 harness.yaml + 系统管理 UI + setup 智能合并 | harness 是系统层的事，不加 workflow.yaml |
| 4 | 干预方式 | 4 种模式: inject / takeover / varpool / definition | 不同场景需要不同干预深度 |
| 5 | DiagnosisReport | 纯诊断 (facts only)，按需升级到带建议/快照 | 起步简单，层间解耦 |
| 6 | 进程隔离 | 渐进式安全: 基础层(全平台) + 增强层(Linux/macOS) | Windows 开发 + Linux 部署的现实 |
| 7 | UI 设计 | 悬浮面板(拖拽/缩放) + chatbot + DAG 标记 | 不挤占已有 UI，agentic 交互 |
| 8 | 验证策略 | 四层全覆盖: 单元 + 集成 + E2E + 接口 | 高质量交付 |

## Decision Map Summary

Map: [map.md](./map.md)

| # | Ticket | Type | Decision |
|---|--------|------|----------|
| 01 | harness-brain | grilling | 三层委托架构 |
| 02 | engine-hooks | research | 回调装饰 + 3 个新可选回调 |
| 03 | strategy-config | grilling | 全局 harness.yaml + UI |
| 04 | intervention-actions | grilling | 4 种干预模式 + 新节点状态 |
| 05 | plugin-protocol | prototype | 延迟到实现阶段 |
| 06 | process-isolation | grilling | 渐进式安全模型 |
| 07 | ui-enhancement | grilling | 悬浮面板 + chatbot |
| 08 | verification | grilling | 四层验证全覆盖 |

## User Stories

1. **As a** workflow 执行者, **I want** harness 自动检测 agent 节点的傻重试并注入纠正指令, **so that** 工作流不会因为重复错误卡死 10 分钟
2. **As a** workflow 执行者, **I want** harness 检测模型能力不匹配并自动切换到支持该能力的模型, **so that** 400 错误不会导致节点反复失败
3. **As a** workflow 执行者, **I want** harness 阻止 bash/python 节点杀死宿主进程或占用宿主端口, **so that** Octopus 服务不会因为 e2e 测试崩溃
4. **As a** workflow 执行者, **I want** 连续多个节点超时时 harness 暂停工作流并通知我, **so that** 环境问题不会导致整个 workflow 白白执行完
5. **As a** 运维人员, **I want** 通过系统管理 UI 编辑 harness 配置, **so that** 我不用手动编辑 YAML 文件
6. **As a** 运维人员, **I want** 在 workflow 执行过程中通过悬浮面板的 chatbot 主动干预节点, **so that** 我可以在发现问题时立即纠正而不是等工作流失败
7. **As a** 运维人员, **I want** 看到 harness 干预的完整历史（诊断、策略、动作、结果）, **so that** 我可以审计和优化 harness 策略
8. **As a** 运维人员, **I want** harness agent 干预的 token 消耗独立统计并汇总到 workflow 总 token 中, **so that** 我能清楚 harness 的成本

## Implementation Decisions

### 模块结构

```
packages/shared/src/
  harness/
    types.ts              ← DiagnosisReport, InterventionAction, NodeStatus 扩展
    harness-defaults.yaml ← 随版本发布的默认配置

packages/engine/src/
  engine.ts               ← +3 个可选回调 (onBeforeRetry, onFailureDecision, onBeforeNode)
  executors/
    bash.ts               ← 进程隔离增强 (进程组 kill 确保)
    python.ts             ← 进程隔离增强 (修复进程组 kill)
  harness/
    sandbox/
      wrapper.ts          ← 全平台 Wrapper 拦截
      seatbelt.ts         ← macOS sandbox-exec
      bubblewrap.ts       ← Linux bwrap
      detect.ts           ← 自动检测可用沙箱

packages/server/src/
  services/harness/
    harness-controller.ts ← 主控制器: 编排三层
    detector-pipeline.ts  ← Layer 1: 检测器管道
    strategy-engine.ts    ← Layer 2: 策略引擎
    agent-delegation.ts   ← Layer 3: Agent 委托
    config-loader.ts      ← 配置加载 + 合并
  services/harness/detectors/
    stupid-retry.ts       ← 傻重试检测器
    model-mismatch.ts     ← 模型能力不匹配检测器
    process-conflict.ts   ← 进程冲突检测器
    timeout-cascade.ts    ← 超时级联检测器
    base-detector.ts      ← 检测器基类 (生命周期管理)
  services/harness/strategies/
    actions/
      inject-message.ts   ← 注入指令
      agent-takeover.ts   ← Agent 接管
      modify-varpool.ts   ← 修改 VarPool
      modify-definition.ts← 修改定义
  routes/
    harness.ts            ← Harness API 路由

packages/web-app/
  components/workspace/
    harness-floating-panel.tsx ← 悬浮面板主组件
    harness-chatbot.tsx        ← Chatbot 对话界面
    harness-timeline.tsx       ← 干预时间线
  hooks/
    use-harness-events.ts      ← Harness SSE 事件 hook
```

### 层间协议: DiagnosisReport

```typescript
interface DiagnosisReport {
  id: string                    // 唯一 ID
  timestamp: number             // 检测时间
  detector: string              // 检测器名称
  severity: 'info' | 'warning' | 'critical'
  
  // Facts — 发生了什么
  executionId: string
  nodeId: string
  nodeType: string              // bash | python | agent | ...
  pattern: string               // 异常模式标识
  
  evidence: Array<{             // 证据链
    attempt?: number
    errorCode?: string
    errorMessage?: string
    errorHash?: string          // 见下方 errorHash 计算规则
    [key: string]: any
  }>
  
  context: {                    // 执行上下文
    retryCount: number
    nodeDurationMs: number
    workflowProgress: number
    [key: string]: any
  }
}
```

**errorHash 计算规则**:
```typescript
function computeErrorHash(result: NodeExecutionResult): string {
  // 从 NodeExecutionResult 中提取错误特征
  const raw = [
    result.logLines?.filter(l => l.includes("error") || l.includes("Error")).join("\n") ?? "",
    result.error ?? "",
    result.outputs?.exitCode?.toString() ?? "",
  ].join("|")
  // 简单 hash (不需要加密级，只用于比较相同性)
  return simpleHash(raw.substring(0, 500))  // 取前 500 字符
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}
```

### 引擎回调扩展

```typescript
// 追加到 EngineCallbacks (packages/engine/src/engine.ts:51-67)
interface EngineCallbacks {
  // ... 现有 15 个回调 ...

  // ★ Harness 新增 — 全部可选，向后兼容
  onBeforeNode?: (
    nodeId: string, 
    nodeType: string,
    nodeConfig: NodeDef  // 完整节点定义，含 script/model 等
  ) => Promise<{
    action: "proceed" | "skip" | "override"
    overrideResult?: NodeExecutionResult
  }>

  onBeforeRetry?: (
    nodeId: string, 
    attempt: number, 
    lastResult: NodeExecutionResult
  ) => Promise<{
    action: "retry" | "skip" | "abort" | "override"
    overrideResult?: NodeExecutionResult
    harnessHint?: string       // 注入到 VarPool 作为 $harness_hint
    modelOverride?: string     // 覆盖 agent 节点的模型
  }>

  onFailureDecision?: (
    nodeId: string, 
    error: string, 
    currentStrategy: string
  ) => Promise<{
    action: "continue" | "abort" | "delegate"
  }>
}
```

### 引擎回调注入点 (engine.ts 具体 patch)

**1. `onBeforeNode` — 插入 `executeSingleNode()` L807-855**

```typescript
// engine.ts executeSingleNode(), 在 executor.execute() 之前插入:
async executeSingleNode(node, pool, signal) {
  const executor = this.createExecutor(node, pool, signal)
  this.callbacks?.onNodeStart?.(node.id, node.type)
  
  // ★ NEW: onBeforeNode hook
  if (this.callbacks?.onBeforeNode) {
    const decision = await this.callbacks.onBeforeNode(node.id, node.type, node)
    if (decision.action === "skip") {
      this.callbacks?.onNodeEnd?.(node.id, "skipped", { durationMs: 0 })
      return { outputs: {}, status: "skipped", durationMs: 0, logLines: ["Skipped by harness"] }
    }
    if (decision.action === "override" && decision.overrideResult) {
      return decision.overrideResult
    }
  }
  
  const result = await executor.execute()  // 原有执行
  // ... 后续不变
}
```

**2. `onBeforeRetry` — 插入 `executeSingleNodeWithRetry()` L859-937**

```typescript
// engine.ts executeSingleNodeWithRetry(), 在 sleepWithAbort() 之前插入:
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const result = await this.executeSingleNode(node, pool, signal)
  
  if (result.status === "success") return result
  
  // 现有: classify + check retry_on
  const category = this.failureClassifier.classify(result)
  if (!shouldRetry(category, policy)) return result
  
  // ★ NEW: onBeforeRetry hook (在 delay 之前)
  if (attempt < maxAttempts && this.callbacks?.onBeforeRetry) {
    const decision = await this.callbacks.onBeforeRetry(node.id, attempt, result)
    if (decision.action === "skip") return { ...result, status: "skipped" }
    if (decision.action === "abort") { signal?.abort(); return { ...result, status: "failed" } }
    if (decision.action === "override" && decision.overrideResult) return decision.overrideResult
    // 注入 harnessHint 到 VarPool
    if (decision.harnessHint) {
      pool.set("harness_hint", decision.harnessHint)
    }
    // 覆盖模型
    if (decision.modelOverride && node.type === "agent") {
      node.model = decision.modelOverride  // 运行时修改，下次重试用新模型
    }
  }
  
  // 现有: onNodeRetry + sleep
  this.callbacks?.onNodeRetry?.(node.id, attempt, maxAttempts, delayMs)
  await this.sleepWithAbort(delayMs, signal)
}
```

**3. `onFailureDecision` — 插入 `executeNodesSequential()` L954-1199**

```typescript
// engine.ts executeNodesSequential(), 在 failure strategy 决策处插入:
if (nodeResult.status !== "success" && nodeResult.status !== "skipped") {
  const strategy = pipeline.execution?.failure_strategy ?? "fail_fast"
  
  // ★ NEW: onFailureDecision hook
  if (this.callbacks?.onFailureDecision) {
    const decision = await this.callbacks.onFailureDecision(
      node.id, nodeResult.logLines?.join("\n") ?? "", strategy
    )
    if (decision.action === "continue") { this.hasPartialFailure = true; continue }
    if (decision.action === "delegate") {
      // Harness Agent Delegation takes over
      // 引擎暂停，等 Harness 通过 retryFrom() 恢复
      return { status: "paused", pausedAt: node.id, ... }
    }
  }
  
  // 原有 failure strategy 逻辑
  if (strategy === "fail_fast") { ... }
}
```

### Harness Hint 传递机制

**Bash/Python 节点**: 通过 VarPool 注入 `$harness_hint`
- `onBeforeRetry` 返回 `harnessHint: "先 npm install"`
- 引擎将 hint 写入 `pool.set("harness_hint", hint)`
- 下次重试时，脚本可通过 `$vars.harness_hint` 或环境变量 `$HARNESS_HINT` 获取
- **注意**: 这要求 workflow YAML 中的脚本引用 `$vars.harness_hint`，或在 Wrapper 中自动注入为环境变量

**Agent 节点**: 通过 repair/intervene API 注入消息
- Harness Controller 调用 `RepairService.intervene(executionId, nodeId, hint)`
- 消息注入到 agent 的 session 中
- Agent 在下次 turn 时看到 hint 并据此调整行为

**模型切换**: 通过 `modelOverride` 字段
- `onBeforeRetry` 返回 `modelOverride: "claude-sonnet-4-20250514"`
- 引擎在重试前修改 `node.model`
- 下次 `executeSingleNode()` 创建 executor 时使用新模型

### 配置格式: harness.yaml

```yaml
# packages/shared/src/harness/harness-defaults.yaml
# 随版本发布的默认配置

detectors:
  stupid_retry:
    enabled: true
    threshold: 2              # 重试 N 次同错误触发
  model_mismatch:
    enabled: true
  process_conflict:
    enabled: true
  timeout_cascade:
    enabled: true
    threshold: 3              # 连续 N 个节点超时触发

strategies:
  - match: stupid_retry
    actions:
      - type: inject_message
        message: "上次因为同样的原因失败了。请换一种方法解决。"
      - type: retry_with_hint
  - match: model_mismatch
    actions:
      - type: switch_model
        prefer: vision_capable
  - match: process_conflict
    severity: critical
    actions:
      - type: abort
        reason: "检测到进程冲突，已阻断以保护宿主进程"
  - match: timeout_cascade
    actions:
      - type: pause
        notify: true
  - match: "*"
    actions:
      - type: pause_and_notify
    delegate_to_agent: true

# 进程隔离配置
isolation:
  process_group: true          # 进程组管理
  port_protection: true        # 端口冲突检测
  pid_protection: true         # PID 保护
  sandbox: auto                # auto | seatbelt | bubblewrap | wrapper | disabled
  fs_whitelist: [".", "/tmp"]  # 文件系统白名单 (增强层)
```

### 节点状态扩展

```typescript
// packages/shared/src/types/execution.ts 扩展
type NodeStatus = 
  | 'pending' | 'running' | 'completed' | 'failed' 
  | 'skipped' | 'cancelled' | 'paused' | 'rejected'
  | 'pending_approval' | 'pending_interaction'
  // ★ Harness 新增
  | 'harness_intervening'     // harness 正在分析和执行干预
  | 'harness_modified'        // harness 修改了脚本/变量/定义，将重试
  | 'harness_executed'        // harness agent 接管执行完成
```

### Harness SSE 事件

```typescript
// 新增 SSE 事件类型
type HarnessSSEEvent = 
  | { event: 'harness_diagnosis',    data: { executionId, report: DiagnosisReport } }
  | { event: 'harness_intervention', data: { executionId, nodeId, action, result } }
  | { event: 'harness_delegation',   data: { executionId, nodeId, agentSessionId, status } }
  | { event: 'harness_blocked',      data: { executionId, nodeId, reason, pattern } }
```

**Web-app 接收方式**: 
- 现有 `use-execution-tree.ts` 使用 EventSource 监听 `GET /executions/events`
- 新增 `use-harness-events.ts` hook: 也通过 EventSource 监听同一 SSE 端点，过滤 `harness_*` 事件
- 不使用 polling（SSE 已有基础设施）

### Detector 生命周期管理

```typescript
// 检测器基类
abstract class BaseDetector {
  abstract name: string
  abstract observe(event: EngineCallbackEvent): DiagnosisReport | null
  
  // 每次 execution 开始时调用
  reset(): void {}
  
  // 每次 execution 结束时调用
  destroy(): void {}
}

// HarnessController 管理检测器生命周期
class HarnessController {
  private detectors: BaseDetector[]  // 有状态
  
  // 每次 ExecutionLifecycle.start() 时:
  onExecutionStart(executionId: string) {
    // 为每个 execution 创建新的 detector 实例
    this.detectors = this.config.enabledDetectors.map(d => d.factory())
  }
  
  // execution 完成/失败时:
  onExecutionEnd(executionId: string) {
    this.detectors.forEach(d => d.destroy())
    this.detectors = []
  }
}
```

**有状态检测器示例 — TimeoutCascadeDetector**:
```typescript
class TimeoutCascadeDetector extends BaseDetector {
  private consecutiveTimeouts = 0
  private recentTimeoutNodes: string[] = []
  
  observe(event): DiagnosisReport | null {
    if (event.type === 'nodeEnd' && event.category === 'timeout') {
      this.consecutiveTimeouts++
      this.recentTimeoutNodes.push(event.nodeId)
      if (this.consecutiveTimeouts >= this.threshold) {
        return {
          detector: 'timeout_cascade',
          severity: 'critical',
          evidence: this.recentTimeoutNodes.map(id => ({ nodeId: id })),
          context: { consecutiveCount: this.consecutiveTimeouts }
        }
      }
    } else if (event.type === 'nodeEnd' && event.status === 'success') {
      this.consecutiveTimeouts = 0  // 成功节点重置计数
      this.recentTimeoutNodes = []
    }
    return null
  }
  
  reset() { this.consecutiveTimeouts = 0; this.recentTimeoutNodes = [] }
}
```

### Harness Agent Token 追踪

当 Layer 3 (Agent Delegation) 创建 agent session 时:

```typescript
// AgentDelegationService.delegate()
async delegate(executionId, nodeId, report) {
  // 1. 创建虚拟 node_execution 用于关联 token
  const virtualNodeExecId = `harness-${executionId}-${nodeId}-${Date.now()}`
  await dao.createNodeExecution({
    id: virtualNodeExecId,
    execution_id: executionId,
    node_id: nodeId,
    node_type: 'harness_agent',  // 新类型标识
    status: 'running'
  })
  
  // 2. 启动 agent session
  const session = await agentService.createSession(...)
  const result = await agentService.sendQuery(session, prompt)
  
  // 3. Token 记录: source = "harness"
  await dao.insertTokenUsage({
    node_execution_id: virtualNodeExecId,
    model: result.model,
    input_tokens: result.usage.input,
    output_tokens: result.usage.output,
    source: 'harness',  // 区分来源
    cost_usd: calculateCost(result.usage)
  })
  
  // 4. Workflow 总 token 汇总时:
  // SELECT SUM(cost_usd) FROM node_token_usages
  //   WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id = ?)
  // → 自动包含 source='node' 和 source='harness' 的 token
}
```

### Harness API 路由

```
GET  /api/workspaces/:id/harness/config          — 获取当前 harness 配置
PUT  /api/workspaces/:id/harness/config          — 更新 harness 配置
GET  /api/workspaces/:id/harness/events/:execId  — 获取 harness 事件历史
POST /api/workspaces/:id/executions/:execId/harness-intervene  — 扩展: 支持 inject 类型
```

**`harness-intervene` API 扩展**:
现有实现只支持 `abort`/`pause`。扩展 directive type 联合:
```typescript
interface HarnessDirective {
  type: "abort" | "pause" | "inject"  // 新增 "inject"
  reason: string
  issued_by: string
  // inject 专用字段
  nodeId?: string
  message?: string    // 注入给 agent 的消息
}
```
当 `type === "inject"` 时，内部委托给 `RepairService.intervene(executionId, nodeId, message)`。
这样 chatbot 只需调用一个统一的 API，不需要知道 `repair/intervene` 的存在。

### 进程隔离: Wrapper 拦截

**检测策略: Wrapper 优先，静态扫描为辅**

进程冲突检测分两层:
1. **运行时拦截 (Wrapper)** — 主要防线，在脚本执行过程中实时拦截危险命令
2. **执行前预警 (静态扫描)** — 辅助防线，在 `onBeforeNode` 时扫描明显的危险模式

静态扫描的局限性 (已知):
- 变量替换后的实际值无法预知
- `eval`/heredoc 等间接命令无法静态检测
- 因此静态扫描仅作为"提前警告"，不作为唯一防线

```bash
# Bash Wrapper (注入到脚本执行前)
# 由 BashExecutor 在执行脚本前自动 prepend

OCTOPUS_HOST_PID=${process.pid}  # 由引擎注入到环境变量

safe_kill() {
  local target=$1
  if [ "$target" = "$OCTOPUS_HOST_PID" ] || [ "$target" = "-$OCTOPUS_HOST_PID" ]; then
    echo "[HARNESS] BLOCKED: Cannot kill host process (PID: $OCTOPUS_HOST_PID)" >&2
    return 1
  fi
  /bin/kill "$@"
}

safe_taskkill() {
  for arg in "$@"; do
    if [ "$arg" = "$OCTOPUS_HOST_PID" ]; then
      echo "[HARNESS] BLOCKED: Cannot kill host process" >&2
      return 1
    fi
  done
  taskkill.exe "$@"
}

alias kill='safe_kill'
alias taskkill='safe_taskkill'
```

**环境变量注入** (在 BashExecutor/PythonExecutor 中):
```typescript
// BashExecutor.runScript() 和 PythonExecutor 中新增:
env.OCTOPUS_HOST_PID = String(process.pid)
env.OCTOPUS_HOST_PORTS = [serverPort, webPort].join(",")  // e.g. "3001,3000"
```

### 悬浮面板组件设计

```
HarnessFloatingPanel:
  位置: 右上角, 不贴边 (right: 24px, top: 80px)
  
  收起态 (48x120px, opacity: 0.7):
  ┌──────────────┐
  │ 🛡️ 2 | 监控中│
  │ +$0.03       │
  └──────────────┘
  
  展开态 (400x500px, 可拖拽/缩放):
  ┌──────────────────────────────────────┐
  │ Harness 监控                    [—][□]│
  ├──────────────────────────────────────┤
  │ [监控] [明细] [Chatbot]              │
  ├──────────────────────────────────────┤
  │                                      │
  │ 监控 Tab:                            │
  │ ┌─ 干预时间线 ──────────────────┐   │
  │ │ 10:23 ⚠️ 傻重试检测 bash-build │   │
  │ │ 10:23 🔄 注入纠正指令          │   │
  │ │ 10:25 ✅ 重试成功               │   │
  │ │ 10:30 ⚠️ 模型不匹配 agent-read  │   │
  │ │ 10:30 🔄 切换 Sonnet            │   │
  │ │ 10:31 ✅ 重试成功               │   │
  │ └────────────────────────────────┘   │
  │                                      │
  │ 统计: 干预 2次 | 成功 2次 | +1.2K tok│
  │                                      │
  │ Chatbot Tab:                         │
  │ ┌─ 对话 ───────────────────────┐    │
  │ │ 你: 告诉 bash-test 用端口3200 │    │
  │ │ 🛡️: 已注入指令，节点将重试    │    │
  │ └──────────────────────────────┘    │
  │ [输入干预指令...            ] [发送] │
  └──────────────────────────────────────┘
```

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `node_executions` | ALTER | 新增 `harness_status` 列 (TEXT, nullable) — 记录 harness 干预状态 |
| `node_executions` | ALTER | 新增 `harness_interventions` 列 (JSON, nullable) — 干预历史 JSON |
| `node_token_usages` | ALTER | 新增 `source` 列 (TEXT, DEFAULT 'node') — 区分 'node' vs 'harness' |
| `harness_events` | CREATE | 新表: id, execution_id, timestamp, event_type, report_json, action_json, result_json |
| `harness_config` | CREATE | 新表: workspace_id, config_yaml, updated_at, version |

**迁移代码** (在 `packages/server/src/db/schema.ts` 中):
```typescript
// 新增列
ensureColumn(db, "node_executions", "harness_status", "TEXT")
ensureColumn(db, "node_executions", "harness_interventions", "TEXT")
ensureColumn(db, "node_token_usages", "source", "TEXT DEFAULT 'node'")
```

### harness_events 表

```sql
CREATE TABLE harness_events (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  node_id TEXT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,  -- 'diagnosis' | 'intervention' | 'delegation' | 'blocked'
  detector TEXT,
  severity TEXT,
  report_json TEXT,          -- DiagnosisReport JSON
  action_json TEXT,          -- 干预动作 JSON
  result_json TEXT,          -- 干预结果 JSON
  token_usage_json TEXT,     -- harness agent token 消耗
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_harness_events_exec ON harness_events(execution_id);
CREATE INDEX idx_harness_events_time ON harness_events(timestamp);
```

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/api/workspaces/:id/harness/config` | server | — | `{ config: string, version: number }` | 获取 harness.yaml 内容 |
| PUT | `/api/workspaces/:id/harness/config` | server | `{ config: string }` | `{ success: boolean, version: number }` | 更新配置 |
| GET | `/api/workspaces/:id/harness/events/:execId` | server | `?type=&severity=` | `{ events: HarnessEvent[] }` | 获取干预事件历史 |
| POST | `/api/workspaces/:id/executions/:execId/harness-intervene` | server | `{ nodeId, directive }` | `{ success: boolean }` | 已有 API，chatbot 调用 |

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
| Data prefix | harness_test_ |
| Cleanup | DELETE harness_test_* after test |

### AC to Verification Method Mapping

| US# | User Story | AC | Verification Level | Verification Method |
|-----|-----------|-----|-------------------|---------------------|
| 1 | 傻重试自动纠正 | bash 节点重试 2 次同错误后，harness 注入 hint 并成功 | 单元 + 集成 | 测试 StupidRetryDetector + Strategy 匹配 |
| 2 | 模型不匹配自动切换 | agent 节点 400 vision 错误后，自动切换到 vision 模型 | 单元 + 集成 | 测试 ModelMismatchDetector + switch_model action |
| 3 | 进程冲突阻断 | bash 节点试图 kill 宿主 PID 时被阻断 | 单元 + 集成 | 测试 ProcessConflictDetector + Wrapper 拦截 |
| 4 | 超时级联暂停 | 3 个连续节点超时后 workflow 暂停 | 单元 + 集成 | 测试 TimeoutCascadeDetector + pause action |
| 5 | UI 配置编辑 | 通过系统管理 UI 编辑 harness.yaml 并保存 | E2E | Playwright 操作 UI + 验证 API |
| 6 | Chatbot 干预 | 通过悬浮面板 chatbot 发送干预指令，节点收到并执行 | E2E | Playwright 操作 chatbot + 验证节点状态 |
| 7 | 干预历史审计 | 干预事件完整记录，可在明细 Tab 查看 | E2E + 接口 | 验证 harness_events 表 + API |
| 8 | Token 计费 | harness agent token 独立记录并汇总到 workflow 总 token | 接口 | 验证 token_usages 表 source="harness" |

### Verification Methods Detail

#### Unit Tests
- `StupidRetryDetector`: 输入 2 次相同 errorHash → 输出 DiagnosisReport
- `ModelMismatchDetector`: 输入 400 + "vision" → 输出 DiagnosisReport
- `ProcessConflictDetector`: 输入包含 kill $HOST_PID 的脚本 → 输出 critical report
- `TimeoutCascadeDetector`: 输入 3 次连续 timeout → 输出 critical report
- `StrategyEngine`: 输入 DiagnosisReport → 正确匹配 strategy → 返回 actions
- `ConfigLoader`: 全局 + 默认合并逻辑正确
- 引擎回调向后兼容: 不传新回调时引擎正常运行

#### Integration Tests
- 创建 `harness_test_stupid_retry` workflow → 执行 → 验证:
  - harness_events 表有 diagnosis + intervention 记录
  - 节点状态经历 failed → harness_intervening → harness_modified → running → completed
  - SSE 发出 harness_diagnosis + harness_intervention 事件
- 创建 `harness_test_process_conflict` workflow → 执行 → 验证:
  - Wrapper 拦截了 kill 命令
  - 节点状态变为 failed (blocked by harness)
  - 宿主进程未被杀死

#### Browser E2E
- 悬浮面板收起/展开/拖拽/缩放
- chatbot 发送干预指令 → 节点状态变化
- DAG 节点显示 🛡️ 标记
- LogViewer harness 过滤器工作

#### Interface Tests
- `GET /harness/config` 返回有效 YAML
- `PUT /harness/config` 保存后 GET 返回更新内容
- `GET /harness/events/:execId` 返回事件列表
- SSE `harness_diagnosis` 事件格式正确

### Prerequisites
- [ ] 分支创建: `feat/workflow-engine-harness`
- [ ] `pnpm build` 通过
- [ ] dev 环境可启动

## Risks & Notes

- **R1: 引擎回调侵入性** — 3 个新回调虽然可选，但需要修改 engine.ts。需要充分测试向后兼容。
- **R2: Agent 分身的可靠性** — Layer 3 委托给 Agent 分身时，分身本身可能出错。需要设置 Agent 分身的超时和重试限制。
- **R3: 配置热更新** — harness.yaml 更新后，正在运行的 execution 不受影响。需要文档化这个行为。
- **R4: 进程隔离的 Windows 限制** — Windows 没有 seatbelt/bubblewrap 等价物，基础层 Wrapper 拦截可能被绕过。生产环境建议 Linux 部署。
- **R5: 悬浮面板性能** — 大量 harness 事件时面板可能卡顿。需要虚拟滚动 + 事件采样。

## Glossary

| Term | Meaning |
|------|---------|
| Harness | 引擎的 Agentic 监督层，负责监控、诊断、干预 |
| Detector | 检测器，观察引擎事件并产出 DiagnosisReport |
| DiagnosisReport | 诊断报告，描述发生了什么 (facts only) |
| Strategy | 策略，将 DiagnosisReport 映射到干预动作 |
| Intervention | 干预，harness 对执行中的节点采取的纠正动作 |
| Agent Delegation | Agent 委托，复杂场景交给 Octopus 内置 Agent 分身处理 |
| Wrapper | 包裹脚本，拦截危险命令 (kill/rm 等) |
| harness.yaml | Harness 的全局配置文件 |

## Appendix: Core User Stories（闭环验证）

### Story 1: 傻重试自动纠正

```
[UI] 用户启动 harness_test_retry workflow
[API] POST /executions → 创建执行
[Exec] bash-build 执行 "npm run build" → exit 1 "Cannot find module 'xyz'"
[Event] onNodeEnd(status: "failed")
[Exec] RetryPolicy 允许重试 → onNodeRetry(attempt: 2)
[Event] onNodeEnd(status: "failed") — 同样的错误

[Harness] StupidRetryDetector:
  → errorHash(attempt 1) == errorHash(attempt 2)
  → retry_count (2) >= threshold (2)
  → 生成 DiagnosisReport { detector: "stupid_retry", severity: "warning" }
[DB] INSERT harness_events (type: "diagnosis")
[SSE] emit harness_diagnosis

[Harness] StrategyEngine:
  → match: "stupid_retry"
  → actions: [inject_message, retry_with_hint]
  → onBeforeRetry 回调返回 { action: "retry", harnessHint: "先 npm install" }
[DB] INSERT harness_events (type: "intervention")
[SSE] emit harness_intervention

[Exec] 第 3 次执行:
  → 收到 harnessHint → 脚本先跑 npm install → npm run build → 成功
[Event] onNodeEnd(status: "completed")

[Data] 验证:
  → node_executions.status = "completed"
  → node_executions.harness_status = "harness_modified"
  → node_executions.harness_interventions = [{...}]
  → harness_events 有 2 条记录 (diagnosis + intervention)

[UI] 验证:
  → DAG 节点显示 ✅ + 🛡️ 标记
  → 悬浮面板监控 Tab 显示干预时间线
  → 明细 Tab 显示诊断报告 + 干预动作
```

### Story 2: 进程冲突阻断

```
[Exec] bash-test 准备执行脚本: "kill $OCTOPUS_HOST_PID"
[Harness] ProcessConflictDetector (onBeforeNode):
  → 扫描脚本 → 发现 kill 引用 OCTOPUS_HOST_PID
  → 生成 DiagnosisReport { detector: "process_conflict", severity: "critical" }
[DB] INSERT harness_events (type: "diagnosis")
[SSE] emit harness_diagnosis

[Harness] StrategyEngine:
  → match: "process_conflict"
  → severity: "critical" → 直接阻断
  → onBeforeNode 回调返回 { action: "skip", overrideResult: { status: "failed", error: "blocked" } }
[DB] INSERT harness_events (type: "blocked")
[SSE] emit harness_blocked

[Exec] 节点被 skip，不执行脚本
[Event] onNodeEnd(status: "failed", error: "Blocked by harness: process conflict")

[Data] 验证:
  → 宿主进程仍然存活 (process.pid 未受影响)
  → node_executions.status = "failed"
  → harness_events 有 2 条记录 (diagnosis + blocked)

[UI] 验证:
  → DAG 节点显示 ❌ + 🛡️ 标记
  → 悬浮面板显示 🚨 "进程冲突已阻断"
```

### Story 3: Chatbot 主动干预

```
[UI] 用户在悬浮面板 Chatbot Tab 输入: "告诉 agent-write 节点分两步写，先写大纲"
[Harness] 构造干预请求:
  → POST /executions/:id/harness-intervene
    { nodeId: "agent-write", directive: { type: "inject", message: "分两步写...", issued_by: "user" } }
[API] 调用 repair/intervene → 注入消息到 agent session
[Exec] agent-write 收到新指令 → 调整行为 → 分两步写
[Event] onAgentEvent(type: "text_delta", content: "好的，我先写大纲...")
[SSE] emit agent_event

[Data] 验证:
  → agent_events 表有注入的消息记录
  → agent 的输出包含大纲步骤

[UI] 验证:
  → Chatbot 显示 "✅ 已注入指令"
  → LogViewer 显示注入事件
  → Agent Timeline 显示新的指令和响应
```
