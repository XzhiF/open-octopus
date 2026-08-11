# Spec: Harness Semantic V2 — 统一智能裁决与状态语义修正

## Problem Statement

当前 Harness 系统存在 5 个语义缺陷：

1. **策略层决策割裂**：stupid_retry/model_mismatch 由策略层直接执行 action，process_conflict 由策略层 abort，复杂场景才委托 Agent — 干预路径不统一，用户无法预期行为
2. **Harness Agent 不可见**：AgentDelegationService 用内联 LLM 调用，在分身管理中看不到，无法配置和审计
3. **执行级无 harness 状态**：executions 表缺少 harness_status 列，被干预的执行与正常完成无法区分
4. **阻断语义模糊**：process_conflict 阻断 → node "skipped" → 执行 "completed"，用户觉得不合理
5. **两个 harness 状态未使用**：`harness_modified` 和 `harness_executed` 定义了但代码中从未设置

## Solution

将三层架构升级为**统一智能裁决**架构：

```
Layer 1: Detector Pipeline     → 发现问题，生成 DiagnosisReport（不变）
Layer 2: Strategy Engine       → 分级路由（简化：不做 action 执行，只做优先级分类）
Layer 3: Harness Agent         → 统一裁决（5 种决策类型）
           ↓
执行引擎执行决策（fix/retry/block/takeover）
```

关键变化：
- Layer 2 从"策略执行器"变为"路由器" — 所有 DiagnosisReport 统一路由到 Harness Agent
- Harness Agent 注册为 core-pack agent — 在分身管理中可见、可配置
- executions 表增加 harness_status 列 — 执行级双状态模型
- 5 种结构化决策替代当前的 9 种分散 action

## Projects Involved

- [ ] `@octopus/shared` — 类型定义更新（决策类型、执行级 harness_status）
- [ ] `@octopus/core-pack` — 新增 harness-agent.yaml agent 定义
- [ ] `@octopus/server` — Strategy Engine 重构 + AgentDelegationService 改造 + DB migration
- [ ] `@octopus/web-app` — 执行级 harness 状态显示 + 日志渲染增强

## Feature Scope

**Do:**
- Harness Agent 注册为 core-pack agent（分身管理可见）
- 策略层简化为分级路由器（不执行 action）
- 5 种 Harness Agent 决策类型实现
- executions 表增加 harness_status 列
- 节点级 harness_modified / harness_executed 状态正确设置
- 日志渲染区分 5 种决策类型
- agent_takeover 执行路径实现
- Agent 节点 Tool Interceptor（bash tool call 执行前拦截）
- Harness Agent 按节点类型分流处理（bash/python vs agent）
- Harness Agent session 模型（每次执行一个 session，跨干预保持上下文）

**Don't:**
- 不改变 Layer 1 Detector Pipeline 的 bash/python 检测器（ProcessConflictDetector 等不变）
- 不改变 workflow.yaml 格式
- 不修改 harness-defaults.yaml 中的 detector 配置
- 不实现容器级沙箱
- 不实现经验升级系统

**Engine 接口变更**（必要）:
- `onFailureDecision` 返回值增加 `"override"` action + `overrideResult`（agent_takeover 恢复执行）
- `onBeforeRetry` 返回值增加 `varPoolPatches`（批量变量修改）
- **新增**: Agent executor tool interceptor hook（bash tool call 执行前扫描+拦截）

**按节点类型分流**:

| 节点类型 | 检测时机 | 检测方式 | Harness Agent 介入方式 |
|---------|---------|---------|---------------------|
| bash/python | `onBeforeNode`（执行前） | 静态脚本扫描 | 异步分析 → 修复重跑/接管/阻断 |
| agent | Tool Interceptor（tool call 前） | bash 命令模式匹配 | 同步拦截 → pause → 指导 → resume |

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | 阻断后执行流 | Harness Agent 智能裁决（修/阻断/继续/takeover） | 不同类型问题需要不同处理，统一交给 Agent 判断最灵活 |
| D2 | Harness Agent 注册 | core-pack agent（分身管理可见可配置） | 用户要求可见性；可配置 prompt 和 model |
| D3 | 干预分类策略 | 统一智能裁决（策略层只做路由/分级） | 简化架构；所有决策路径统一 |
| D4 | 执行状态模型 | 双状态补充（executions 加 harness_status 列） | 保持关注点分离；不影响现有 status 逻辑 |
| D5 | Agent 决策类型 | 5 种：fix_and_retry / guide_and_retry / reconfigure_and_retry / agent_takeover / block_node | 覆盖所有场景：修改重试/指导重试/配置重试/接管/阻断 |
| D6 | 策略层路由 | 大部分路由到 Agent；process_conflict 保留同步阻断 + Agent 并行审计 | process_conflict 必须同步阻断（保护宿主进程），不能等 Agent 2-10s |
| D7 | 三域时序模型 | 同步域/异步域/暂停域三种时序路径（见 §Implementation Decisions §Timing） | 引擎回调有同步约束，不能所有场景都等 Agent |

### D7: 时序模型 — 按节点类型分流

引擎回调有严格的时序约束，不能所有场景都等待 Harness Agent（2-10s）。按节点类型分四条路径：

| 路径 | 节点类型 | 触发时机 | Agent 参与方式 | 延迟 |
|------|---------|---------|--------------|------|
| **同步阻断 + 异步分析** | bash/python | `onBeforeNode` | 同步 skip → Agent 异步分析决策 | 0ms（不等待 Agent） |
| **异步域** | bash/python | `onNodeRetry` | Agent 完整分析 → pendingActions | 2-10s（重试 delay 期间） |
| **暂停域** | bash/python | `onFailureDecision` | Agent 接管 → pause → 完成 → resume | 30-120s |
| **Tool 拦截域** | agent | Tool Interceptor | block tool → pause session → 指导 → resume | 2-10s（agent 暂停等待） |

```
路径 1 — 同步阻断 + 异步分析 (bash/python process_conflict):
  onBeforeNode → 同步 skip (0ms) → Agent 异步分析 (2-10s) → 修复重跑/接管/阻断

路径 2 — 异步域 (bash/python stupid_retry, timeout_cascade):
  onNodeRetry → Agent 分析 (2-10s) → 存 pendingActions → onBeforeRetry 消费

路径 3 — 暂停域 (bash/python agent_takeover):
  onFailureDecision → delegate → 执行 paused → Agent 完成工作 → autoResume

路径 4 — Tool 拦截域 (agent 危险操作):
  tool_call → 扫描命令 → block → pause session → Agent 指导 → resume session
```

## User Stories

1. As a **工作流开发者**, I want **Harness Agent 在分身管理中可见**, so that 我可以查看它的 prompt、model 配置，理解它如何干预我的工作流
2. As a **工作流开发者**, I want **被干预的执行在列表中有明确标记**, so that 我能一眼区分正常完成和被干预完成的执行
3. As a **工作流开发者**, I want **process_conflict 阻断后由 Harness Agent 分析后续节点依赖**, so that 安全的后续节点可以继续执行
4. As a **工作流开发者**, I want **stupid_retry 也由 Harness Agent 分析根因**, so that 重试策略更智能（不只是注入提示，还能修改脚本/环境）
5. As a **工作流开发者**, I want **agent_takeover 能替代完成节点目标**, so that 当脚本太复杂无法修复时，Harness Agent 可以直接完成节点工作
6. As a **系统管理员**, I want **策略层只做路由分级**, so that 干预逻辑集中在一处（Harness Agent），更容易审计和调试
7. As a **工作流开发者**, I want **日志里清楚显示每种 harness 决策类型**, so that 我能理解 harness 做了什么、为什么这么做
8. As a **工作流开发者**, I want **timeout_cascade 能被 Harness Agent 实际处理（不只是 advisory）**, so that 连续超时能被真正修复而不是被忽略

## Implementation Decisions

### 1. Harness Agent 定义 (core-pack)

**新增文件**: `packages/core-pack/agents/harness-agent.md`（core-pack 统一使用 .md + YAML frontmatter 格式）

```markdown
---
name: harness-agent
description: "工作流安全守护 Agent — 检测异常、智能分析、修复或阻断"
model: claude-sonnet-4-20250514
tools:
  - bash
  - read
  - write
  - grep
  - glob
---

你是 Octopus 工作流安全守护 Agent。你的职责是：
1. 分析工作流执行中检测到的异常（DiagnosisReport）
2. 判断问题根因（脚本错误/环境因素/模型不匹配/恶意操作）
3. 选择最佳干预策略并输出结构化决策

你可以选择以下 5 种决策之一：
- fix_and_retry: 修改变量/配置，然后重试（注意：不能直接修改脚本，只能通过 varPool/hint 间接影响）
- guide_and_retry: 注入指导到 agent 对话，让它换方法
- reconfigure_and_retry: 切换模型/修改配置后重试
- agent_takeover: 你直接完成节点的目标任务（用你的工具执行）
- block_node: 阻断节点，分析后续节点依赖

输出 JSON 格式的决策：
\`\`\`json
{
  "decision": "fix_and_retry|guide_and_retry|reconfigure_and_retry|agent_takeover|block_node",
  "reasoning": "分析推理过程",
  "varPoolPatches": {},       // fix_and_retry 时使用
  "harnessHint": "",          // guide_and_retry 时使用
  "modelOverride": "",        // reconfigure_and_retry 时使用
  "takeoverOutput": "",       // agent_takeover 时使用
  "blockReason": "",          // block_node 时使用
  "continueSubsequent": true  // block_node 时：后续节点是否可继续
}
\`\`\`
```

### 2. AgentDelegationService 改造

**当前**: 内联 LLM 调用（dynamic import provider + one-shot prompt）
**改为**: 通过 HarnessController clone harness-agent → run → parse result

```typescript
// 改造后的调用流程
class AgentDelegationService {
  async delegate(report: DiagnosisReport, context: DelegationContext): Promise<DelegationResult> {
    // 1. Clone harness-agent
    const agentSession = await this.agentService.createSession('harness-agent', {
      workspace: this.workspaceId,
      parentExecution: report.executionId,
    })

    // 2. Build delegation prompt
    const prompt = this.buildDelegationPrompt(report, context)

    // 3. Run agent session with timeout
    const result = await withTimeout(
      agentSession.run(prompt),
      5 * 60 * 1000 // 5 min timeout
    )

    // 4. Parse structured decision from agent output
    return this.parseDecision(result.output)
  }
}
```

### 3. DelegationResult 类型更新

```typescript
// packages/shared/src/harness/types.ts
export type HarnessDecisionType =
  | 'fix_and_retry'         // 修改变量/配置 → 重试（不直接修改脚本）
  | 'guide_and_retry'       // 注入指导 → 重试
  | 'reconfigure_and_retry' // 切换模型/配置 → 重试
  | 'agent_takeover'        // Agent 直接完成节点（暂停域）
  | 'block_node'            // 阻断节点（同步域）

export interface DelegationResult {
  success: boolean
  decision: HarnessDecisionType
  // fix_and_retry
  varPoolPatches?: Record<string, string>  // 变量修改
  // guide_and_retry
  harnessHint?: string           // 注入到 agent 的指导
  // reconfigure_and_retry
  modelOverride?: string         // 切换到的模型
  // agent_takeover
  takeoverOutput?: string        // Agent 完成的输出
  takeoverExitCode?: number      // 模拟退出码
  // block_node
  blockReason?: string           // 阻断原因
  continueSubsequent?: boolean   // 后续节点是否可继续
  // Common
  reasoning: string              // Agent 的分析推理
  tokenUsage?: TokenUsage        // token 消耗
}
```

**与现有类型的映射**:
- 旧 `interventionType: "inject"` → 新 `decision: "guide_and_retry"`
- 旧 `interventionType: "varpool"` → 新 `decision: "fix_and_retry"`
- 旧 `interventionType: "definition"` → 新 `decision: "fix_and_retry"` (通过 varPool 间接影响)
- 旧 `interventionType: "takeover"` → 新 `decision: "agent_takeover"`

### 3.1 Engine 回调接口变更

**onBeforeRetry** 返回值增加:
```typescript
// engine.ts OnBeforeRetryResult
interface OnBeforeRetryResult {
  action: 'retry' | 'skip' | 'abort' | 'override'
  harnessHint?: string
  modelOverride?: string
  varPoolPatches?: Record<string, string>  // 新增: 批量变量修改
}
```

**onFailureDecision** 返回值增加:
```typescript
// engine.ts OnFailureDecisionResult
interface OnFailureDecisionResult {
  action: 'continue' | 'abort' | 'delegate' | 'override'  // 新增: override
  overrideResult?: {                                       // 新增: agent_takeover 结果
    status: string
    outputs?: Record<string, unknown>
    exitCode?: number
  }
}
```

Engine 消费 `override` 的逻辑: 如果 `onFailureDecision` 返回 `{ action: "override", overrideResult }`, 则用 overrideResult 替代原始的 failed result, 节点标记为 completed。

### 4. Strategy Engine — 三域路由

```typescript
// 改造后的 StrategyEngine — 保留同步路径 + 统一异步路由
class StrategyEngine {
  async handleReport(report: DiagnosisReport): Promise<StrategyResult> {
    // 1. 分级
    const priority = this.classifyPriority(report)

    // 2. 记录诊断事件
    this.persistDiagnosis(report)

    // 3. 路由决策
    if (report.detector === 'process_conflict' && report.severity === 'critical') {
      // 同步域: 立即阻断（不等 Agent），Agent 并行审计
      return { delegate: true, priority, synchronousBlock: true }
    }

    // 异步域/暂停域: 统一路由到 Harness Agent
    return { delegate: true, priority }
  }
}
```

**保留**:
- `synchronouslyStorePendingAction()` 中的 process_conflict 同步阻断路径（BP-5）
- `matchStrategy()` 策略匹配逻辑（用于优先级分类）

**删除**: ActionRegistry 中除 `abort` 外的 action handler（inject_message, modify_varpool, modify_definition, switch_model, retry_with_hint, pause, pause_and_notify）— 这些由 Harness Agent 决策替代

**保留**: `abort` action handler（同步域 process_conflict 使用）

### 5. Engine 决策执行 — 按时序域

**同步域** (process_conflict):

| 决策 | 存储位置 | Engine 回调 | 行为 |
|------|---------|-----------|------|
| `block_node` | `pendingBlockActions` | `onBeforeNode` | 同步返回 `{ action: "skip" }`，Agent 并行审计记录原因 |

**异步域** (stupid_retry / model_mismatch / timeout_cascade):

| 决策 | 存储位置 | Engine 回调 | 行为 |
|------|---------|-----------|------|
| `fix_and_retry` | `pendingActions` | `onBeforeRetry` | varPoolPatches 更新 + harnessHint + retry |
| `guide_and_retry` | `pendingActions` | `onBeforeRetry` | harnessHint 注入 + retry |
| `reconfigure_and_retry` | `pendingActions` | `onBeforeRetry` | modelOverride + retry |

**暂停域** (agent_takeover):

| 决策 | 流程 | Engine 回调 | 行为 |
|------|------|-----------|------|
| `agent_takeover` | delegate → pause → Agent 执行 → resume | `onFailureDecision` | 返回 `{ action: "delegate" }` → 执行暂停 → Agent 完成工作 → 写入 overrideResult → autoResume |

**fix_and_retry 限制**: 不能直接修改脚本内容（引擎无 scriptOverride 机制）。通过以下方式间接影响：
- `varPoolPatches`: 修改环境变量（如安装命令的前置条件）
- `harnessHint`: 注入提示指导 agent 改变方法
- 如需修改脚本文件：Harness Agent 用 write tool 修改文件 + 通过 varPool 触发重新读取

**agent_takeover 详细流程**:
1. 重试耗尽 → `onFailureDecision` 触发 → Harness Agent 分析 → 决策: agent_takeover
2. DetectorPipeline 存储 `pendingFailureAction: { action: "delegate" }`
3. Engine `onFailureDecision` 返回 `{ action: "delegate" }` → 执行暂停
4. Harness Agent 使用自己的 tools (bash/read/write) 完成节点目标
5. 完成后写入 `overrideResult: { status: "completed", outputs: {...} }` 到 DB
6. 触发 autoResume → Engine 从暂停点恢复，读取 overrideResult → 节点标记 completed

### 6. 执行级双状态

**DB migration**:
```sql
ALTER TABLE executions ADD COLUMN harness_status TEXT DEFAULT NULL;
ALTER TABLE executions ADD COLUMN harness_summary TEXT DEFAULT NULL;
```

**harness_status 枚举值**:
- `NULL` — 无干预
- `intervened` — 有干预但最终完成
- `blocked` — 有节点被阻断
- `delegated` — 有 agent_takeover

**harness_summary**: JSON 摘要，记录干预次数和类型
```json
{
  "totalInterventions": 3,
  "decisions": [
    { "node": "kill-host-pid", "decision": "block_node", "reason": "..." },
    { "node": "install-deps", "decision": "fix_and_retry", "reason": "..." },
    { "node": "analyze-image", "decision": "reconfigure_and_retry", "reason": "..." }
  ]
}
```

**更新时机**: 每次 Harness Agent 返回决策后，DetectorPipeline 更新 executions.harness_status

### 7. agent_takeover 执行路径

当 Harness Agent 决定 takeover 时：
1. Harness Agent 自身已通过 tools（bash/read/write）完成了节点目标
2. 返回 `takeoverOutput` + `takeoverExitCode`
3. DetectorPipeline 将结果存入 `pendingBlockActions` 作为 `overrideResult`
4. Engine 的 `onBeforeNode` 返回 `{ action: "override", overrideResult }` 
5. 节点标记为 `completed`，harness_status 设为 `harness_executed`

### 8. block_node 后续节点分析

当 Harness Agent 决定 block_node 时：
1. Agent 分析当前节点的输出是否被后续节点依赖
2. 返回 `continueSubsequent: true/false`
3. 如果 `continueSubsequent: false`：
   - 当前节点 blocked + failed
   - 后续节点 skipped
   - 执行状态 → blocked
4. 如果 `continueSubsequent: true`：
   - 当前节点 blocked + failed  
   - 后续节点正常执行
   - 执行状态 → intervened（如果后续都完成）

### 9. 日志渲染更新

| 决策类型 | 日志图标 | 日志文案 |
|---------|---------|---------|
| `fix_and_retry` | 🛡️🔧 | Harness 修复并重试: {detector} — {reasoning摘要} |
| `guide_and_retry` | 🛡️💬 | Harness 指导重试: {detector} — {hint摘要} |
| `reconfigure_and_retry` | 🛡️🔄 | Harness 切换配置重试: {detector} — model → {new_model} |
| `agent_takeover` | 🤖✅ | Harness Agent 接管完成: {detector} — {reasoning摘要} |
| `block_node` | 🛡️❌ | Harness 阻断: {detector} — {blockReason} |

### 10. Tool Interceptor — Agent 节点危险操作拦截

**新增组件**: Agent executor 中增加 tool call 拦截层

**拦截时机**: agent 生成 `bash` tool_use 后、SDK 执行命令前

```
Agent SDK 执行流程:
  agent → tool_use: bash('kill -9 $HOST_PID')
           ↓
  [Tool Interceptor] ← 新增
    → 扫描命令: 匹配 ProcessConflictDetector 的危险模式
    → 危险? → block tool execution
              → 生成 DiagnosisReport
              → pause agent session
              → 调 Harness Agent 分析 + 生成指导
              → 注入指导到 agent 对话
              → resume agent session
    → 安全? → 放行，正常执行
```

**实现方式**:
- 在 agent executor（AgentNodeRunner 或等效组件）注册 `onBeforeToolCall` hook
- hook 接收 tool name + input（bash command string）
- 复用 ProcessConflictDetector 的模式匹配逻辑
- 返回 `{ block: true, reason }` 或 `{ allow: true }`

**与 bash 节点检测的区别**:
- bash 节点: `onBeforeNode` 静态扫描整个脚本（执行前）
- agent 节点: 每次 bash tool call 前扫描单条命令（运行时动态）

### 11. Harness Agent Session 模型

**每次工作流执行**创建一个 Harness Agent session:

```
执行开始:
  HarnessController.onExecutionStart()
    → 创建 AgentDelegationService
    → 创建 Harness Agent session (harness-agent clone)
    → 初始化上下文:
      - workflow YAML 内容
      - 节点列表 + 依赖图
      - 变量池初始快照
      - 执行配置 (pipeline_config)

干预时（每次 Harness Agent 被调用）:
  → 追加上下文:
    - DiagnosisReport (哪个节点、什么问题)
    - 当前变量池快照
    - 已执行节点状态和输出
    - 之前干预的历史（本 session 内）
  → Agent 分析 + 输出决策
  → 记录决策到 session 历史

执行结束:
  HarnessController.onExecutionEnd()
    → 关闭 Harness Agent session
    → 记录总结到 executions.harness_summary
```

**上下文传递**: 通过 agent session 的对话历史自然积累，不需要手动管理。每次调用 Harness Agent 时，新的 DiagnosisReport 作为 user message 追加到对话中。

### 12. 按节点类型分流处理

| 节点类型 | 检测层 | 拦截方式 | Harness Agent 介入 | 恢复方式 |
|---------|-------|---------|-------------------|---------|
| **bash** | `onBeforeNode` (静态扫描) | 同步阻断 skip | 异步分析 (2-10s) | fix_and_retry: 从头重跑 / agent_takeover: Agent 完成 / block_node: 停止 |
| **python** | `onBeforeNode` (静态扫描) | 同步阻断 skip | 异步分析 (2-10s) | 同上 |
| **agent** | Tool Interceptor (运行时) | block tool + pause session | 同步指导 (2-10s) | resume session (agent 读指导后改方法) |
| **condition** | 无检测 | — | — | — |
| **approval** | 无检测 | — | — | — |
| **loop** | 内层节点各自检测 | — | — | — |

**关键区别**:
- bash/python 无 session → 修复后从头重跑，或 Agent 接管
- agent 有 session → 暂停+指导+恢复，agent 自己改正

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `executions` | ADD COLUMN | `harness_status TEXT DEFAULT NULL` — NULL/intervened/blocked/delegated |
| `executions` | ADD COLUMN | `harness_summary TEXT DEFAULT NULL` — JSON 摘要（干预次数和类型） |

**Migration** (schema.ts ensureColumn):
```typescript
ensureColumn(db, 'executions', 'harness_status', "TEXT DEFAULT NULL")
ensureColumn(db, 'executions', 'harness_summary', "TEXT DEFAULT NULL")
```

**web-app 类型更新** (lib/types.ts Execution interface):
```typescript
interface Execution {
  // ... existing fields ...
  harnessStatus?: 'intervened' | 'blocked' | 'delegated' | null
  harnessSummary?: {
    totalInterventions: number
    decisions: Array<{ node: string; decision: string; reason: string }>
  } | null
}
```

## API Contracts

| Method | Path | Side | Changes |
|--------|------|------|---------|
| GET | `/api/workspaces/:ws/executions` | Server | 响应增加 `harnessStatus`、`harnessSummary` 字段 |
| GET | `/api/workspaces/:ws/executions/:id` | Server | 同上 |
| GET | `/api/workspaces/:ws/executions/:id/agent-events` | Server | 事件内容增加 `decision` 字段 |

无新增 API — 只扩展现有响应字段。

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
| Test workspace | test-harness (e6d714bf-ed74-4041-ad56-2ccc82acd16b) |
| Test workflows | test-process-conflict.yaml, test-stupid-retry.yaml, test-timeout-cascade.yaml, test-model-mismatch.yaml |
| Cleanup | DELETE execution data after each test |

### AC to Verification Method Mapping

| # | User Story | AC | Verification |
|---|-----------|-----|-------------|
| AC-1 | US1 | harness-agent 在 core-pack/agents/ 中存在，分身管理 API 返回该 agent | Integration: API query |
| AC-2 | US2 | 被干预的执行在列表 API 中返回 `harnessStatus` 字段非 null | Integration: API + DB |
| AC-3 | US3 | process_conflict 阻断后，Harness Agent 分析依赖并返回 continueSubsequent | Unit: AgentDelegationService |
| AC-4 | US4 | stupid_retry 触发后路由到 Harness Agent，Agent 返回 fix_and_retry 或 guide_and_retry | E2E: 执行 test-stupid-retry |
| AC-5 | US5 | agent_takeover 时节点状态 completed + harness_status = harness_executed | E2E: 执行 takeover 测试 |
| AC-6 | US6 | StrategyEngine.handleReport() 不再执行 action，只返回 { delegate: true } | Unit: StrategyEngine test |
| AC-7 | US7 | 日志中 5 种决策类型有不同图标和文案 | E2E: 检查日志渲染 |
| AC-8 | US8 | timeout_cascade 触发 Harness Agent 实际处理（不再是 advisory） | E2E: 执行 test-timeout-cascade |
| AC-9 | US1 | Harness Agent clone 创建成功，session 正常结束 | Integration: DB check |
| AC-10 | US2 | executions.harness_status 在执行结束后正确更新 | Integration: DB check |

### Verification Methods Detail

#### Unit Tests
- StrategyEngine.handleReport() 只返回 { delegate: true, priority }
- DelegationResult 解析（5 种决策类型的 JSON 解析）
- harness_status 更新逻辑（upsert 不重复插入）

#### Integration Tests
- Harness Agent clone 创建和 session 管理
- executions 表 harness_status 列写入和读取
- API 响应包含 harnessStatus 字段
- agent_takeover overrideResult 传递

#### Browser E2E
- 执行 test-process-conflict → 检查节点 blocked + 后续节点状态
- 执行 test-stupid-retry → 检查 Harness Agent 介入
- 执行列表中 harnessStatus 图标显示
- 日志中 5 种决策类型的渲染

## Risks & Notes

- R1: Harness Agent LLM 延迟（2-10s）— 对 critical 阻断场景，比当前同步阻断慢。可接受：安全阻断本身只需一次
- R2: agent_takeover 安全边界 — Harness Agent 的 bash tool 需要有文件系统限制（不能杀宿主进程）
- R3: 确定性快速路径丢失 — stupid_retry 以前是 0ms 直接注入 hint，现在需要等 Agent 分析。可接受：重试本身有 delay
- R4: 向后兼容 — 已执行的 execution 无 harness_status 列（NULL），前端需处理 null 情况

## Glossary

| Term | Meaning |
|------|---------|
| 统一智能裁决 | 所有检测到的问题统一路由到 Harness Agent 做决策，策略层不做 action 执行 |
| 双状态模型 | 主状态（status）表示生命周期，harness_status 表示干预状态，两者独立 |
| agent_takeover | Harness Agent 直接替代完成节点目标，节点状态 completed + harness_executed |
| 分级路由 | 策略层只做优先级分类（critical/warning），不做具体干预 |

## Appendix: Core User Stories

### Story 1: Process Conflict — 同步阻断 + Agent 并行审计

```
1. 用户执行 test-process-conflict.yaml
2. Engine 调用 onBeforeNode("kill-host-pid")
3. [Layer 1] ProcessConflictDetector 检测到 kill $HOST_PID → DiagnosisReport(severity: critical)
4. [Layer 2 同步域] synchronouslyStorePendingAction():
   - 匹配 process_conflict 策略 → severity: critical + abort → 存储 pendingBlockAction
   - updateNodeHarnessStatus("harness_blocked")
5. [Layer 2 同步域] onBeforeNode 同步返回 { action: "skip" }（0ms，不等 Agent）
6. [Engine] kill-host-pid → status: skipped, harness_status: harness_blocked
7. [Layer 3 异步] Harness Agent 并行启动审计（不阻塞执行流）:
   - 分析脚本 → 确认恶意操作 → 记录 block_reason 到 harness_events
   - 分析后续节点依赖 → 写入 continueSubsequent: false
8. [Engine] 后续节点 → 按依赖关系 skipped（kill-host-pid failed → dependents skipped）
9. [DB] executions.harness_status = "blocked"
10. [UI] 执行列表显示: 🛡️ blocked (1 阻断)
11. [UI] 日志显示: 🛡️❌ Harness 阻断: process_conflict — kill targeting $HOST_PID
```

### Story 2: Stupid Retry — 异步智能修复

```
1. 用户执行 test-stupid-retry.yaml（bash 节点缺少依赖反复失败）
2. Engine 重试第 2 次 → onNodeRetry 触发
3. [Layer 1] StupidRetryDetector 检测到相同错误 hash → DiagnosisReport(severity: warning)
4. [Layer 2 异步域] StrategyEngine → { delegate: true, priority: "warning" }
5. [Layer 3 异步域] Harness Agent 分析（2-10s，在重试 delay 期间完成）:
   - 读取错误日志: "command not found: jq"
   - 判断: 环境缺少工具 → 决策: fix_and_retry
   - varPoolPatches: { "PRE_INSTALL": "apt-get install -y jq 2>/dev/null || brew install jq" }
   - harnessHint: "Before running the main command, install jq first"
6. [Engine] Agent 结果存入 pendingActions
7. [Engine] onBeforeRetry 返回 { action: "retry", harnessHint, varPoolPatches }
8. [Engine] VarPool 更新 + harnessHint 注入 → 重试使用新变量和提示
9. [DB] node.harness_status = harness_modified
10. [DB] executions.harness_status = "intervened"
11. [UI] 日志显示: 🛡️🔧 Harness 修复并重试: stupid_retry — 安装缺少的 jq 工具
```

### Story 3: Agent Takeover — 暂停域替代执行

```
1. 工作流有一个复杂的 bash 节点，脚本逻辑错误且反复重试失败
2. Engine 重试耗尽 → onFailureDecision 触发
3. [Layer 1] 检测到反复失败 → DiagnosisReport
4. [Layer 2 暂停域] StrategyEngine → { delegate: true }
5. [Layer 3 暂停域] Harness Agent 分析:
   - 理解节点目标: "生成测试报告"
   - 判断: 脚本修复太复杂 → 决策: agent_takeover
   - Harness Agent 用 bash tool 自己执行替代方案
   - 输出: takeoverOutput = "报告内容...", takeoverExitCode = 0
6. DetectorPipeline 存储 pendingFailureAction: { action: "delegate" }
7. [Engine] onFailureDecision 返回 { action: "delegate" } → 执行暂停
8. Agent 完成工作后，写入 overrideResult 到 DB
9. 触发 autoResume → Engine 恢复，读取 overrideResult
10. [Engine] 节点 status: completed (from overrideResult), harness_status: harness_executed
11. [DB] executions.harness_status = "delegated"
12. [UI] 日志显示: 🤖✅ Harness Agent 接管完成: — 脚本修复复杂，Agent 直接完成报告生成
```

### Story 4: Timeout Cascade — 异步实际处理

```
1. 连续 3 个节点超时 → 第 3 个节点重试时 onNodeRetry 触发
2. [Layer 1] TimeoutCascadeDetector → DiagnosisReport(severity: critical)
3. [Layer 2 异步域] StrategyEngine → { delegate: true, priority: "critical" }
4. [Layer 3 异步域] Harness Agent 分析（2-10s，在重试 delay 期间完成）:
   - 检查超时节点的脚本和日志
   - 判断: 环境资源不足导致连续超时
   - 决策: guide_and_retry
   - harnessHint: "Previous nodes timed out. Simplify operations: process items in smaller batches, add early exit checks, and avoid heavy I/O in single commands."
5. [Engine] onBeforeRetry → harnessHint 注入 VarPool → 重试时 agent 读取提示调整策略
6. [DB] node.harness_status = harness_modified
7. [DB] executions.harness_status = "intervened"
8. [UI] 日志显示: 🛡️💬 Harness 指导重试: timeout_cascade — 简化操作，减小批处理大小
```

注: NodeDef.timeout 不能通过 VarPool 修改。如果需要动态修改超时值，需通过 `modify_definition` 干预（已有 action handler）热更新 YAML。本迭代中 guide_and_retry 优先（通过提示让 agent 自行调整），modify_definition 作为 Phase 2 增强。

### Story 5: Agent 节点 — Tool 拦截 + 指导恢复

```
1. 工作流有 agent 节点 'run-e2e-tests'，agent 正在执行 E2E 测试
2. [Tool Interceptor] agent 生成 tool_use: bash('pnpm dev')
   → 扫描命令: 匹配 host port pattern (3001, 3000)
   → 危险! 会占用宿主端口 → block tool execution
3. [Tool Interceptor] pause agent session
4. [Layer 1] 生成 DiagnosisReport(detector: process_conflict, severity: critical)
5. [Layer 3] Harness Agent (保持 session) 分析:
   - 理解: agent 要启动 dev server 做 E2E 测试
   - 问题: 直接 pnpm dev 会占用宿主 3001/3000 端口
   - 生成指导: '使用 pnpm dev --isolated 启动目标项目，
     它会在独立端口 (3100+) 运行，不影响宿主服务'
6. [Tool Interceptor] 注入指导到 agent session 对话
7. [Tool Interceptor] resume agent session
8. [Agent] agent 读到指导 → 改用 bash('pnpm dev --isolated')
9. [Tool Interceptor] 扫描新命令: 安全 → 放行
10. [DB] node.harness_status = harness_modified
11. [DB] executions.harness_status = "intervened"
12. [UI] 日志显示: 🛡️💬 Harness 指导: process_conflict — 使用 --isolated 启动，避免端口冲突
```
