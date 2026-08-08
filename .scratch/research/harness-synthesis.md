# WorkflowEngine Harness 综合调研报告

> **日期**: 2026-08-05
> **调研范围**: Pi-Mono, Mastra, Superpowers/Claude Code /loop
> **目标**: 为 Octopus WorkflowEngine 设计 harness（运行时监控、约束、验证、纠错机制）提供参考

## 调研来源

| 项目 | 类型 | 报告文件 |
|------|------|---------|
| Pi-Mono | 单 Agent 编码助手 | `.scratch/research/pi-mono-harness-research.md` |
| Mastra | AI Workflow 框架 | `.scratch/research/mastra-harness-research.md` |
| Superpowers + Claude Code /loop | Loop 工程方法论 | `.scratch/research/superpowers-loop-research.md` |

---

## 痛点 → 解决方案映射

### 痛点 1: 进程被杀 — e2e 测试杀死宿主服务

**根因**: Workflow 中的 bash/python 节点直接操作宿主进程环境，没有隔离。

**参考方案**:

| 来源 | 方案 | 细节 |
|------|------|------|
| **Mastra** ⭐ | V8 Isolate 沙箱 | 无文件/网络/进程访问，JSON 边界隔离，128MiB heap limit |
| **Mastra** | OS 级沙箱 | macOS seatbelt + Linux bubblewrap，文件系统/网络白名单 |
| **Pi** | Gondolin micro-VM | 工具执行路由到 Linux micro-VM，宿主只保留 API key |
| **Pi** | 进程组隔离 | `detached: true` spawn + `kill(-pid, SIGKILL)` 杀进程组 |
| **Superpowers** | Worktree 隔离 | 修复动作在独立 git worktree 中执行 |

**Octopus 建议**:

```
节点隔离分层:
├── Bash/Python 节点 → 独立子进程 + 端口隔离
│   ├── --isolated 模式: 启动目标项目时用独立端口(3100+)
│   ├── 进程组管理: kill(-pid) 杀整个进程组而非宿主
│   └── 文件系统白名单: 只允许操作目标 codebase 目录
├── Agent 节点 → Worktree 隔离
│   └── 操作在 .worktrees/ 下执行，不污染主工作区
└── 全局 → 宿主进程保护
    ├── 禁止子进程 kill 父进程 PID
    └── 端口冲突检测: 启动前检查目标端口是否被宿主占用
```

---

### 痛点 2: 傻重试 — Agent 超时后不换策略，反复重试 10 分钟

**根因**: 重试机制只有固定次数 + 固定延迟，没有错误分类和策略变异。

**参考方案**:

| 来源 | 方案 | 细节 |
|------|------|------|
| **Pi** ⭐⭐⭐ | 智能错误分类 | 正则区分 transient(可重试) vs deterministic(永久失败) |
| **Mastra** ⭐⭐ | NonRetryableError | 步骤可声明"永久失败"，绕过重试 |
| **Mastra** ⭐⭐ | TripWire + 反馈重试 | 中断时携带 reason 告诉 LLM 哪里错了再重试 |
| **Superpowers** ⭐⭐ | 模型升级策略 | Round 4-5 切换到更强模型 + 全新实现者 |
| **Superpowers** ⭐⭐ | 断路器 + 裁决 | 5轮上限 → 到达后智能裁决而非简单失败 |
| **Superpowers** | 3次修复失败规则 | 3次失败 → 质疑架构，与人类讨论 |

**Octopus 建议**:

```
智能重试策略:

1. 错误分类器 (借鉴 Pi)
   ├── TRANSIENT: 网络/超时/500/429 → 指数退避重试
   ├── DETERMINISTIC: 语法错误/参数错误/配额不足 → 立即失败
   └── STRATEGIC: 逻辑错误/方法不对 → 策略变异重试

2. 策略变异 (原创，解决"傻重试")
   ├── 第1次重试: 相同方法 + 更多上下文
   ├── 第2次重试: 切换方法/工具
   ├── 第3次重试: 升级模型 + 全新 agent
   └── 第4次+: 断路器跳闸 → 裁决模式

3. TripWire 反馈 (借鉴 Mastra)
   └── 重试时注入: "上次失败原因: {reason}，请换一种方法"

4. 断路器 (借鉴 Superpowers)
   ├── 节点级: max_retries=3, timeout=10min
   ├── Workflow级: max_duration=2h, max_failures=10
   └── 跳闸后: 分类裁决(可争议/可延期/承重)
```

---

### 痛点 3: 脚本错误雪崩 — Bash/Python 错误导致 Workflow 卡死

**根因**: 缺乏快速失败机制和降级策略，单个节点错误可以阻塞整个 workflow。

**参考方案**:

| 来源 | 方案 | 细节 |
|------|------|------|
| **Pi** ⭐⭐⭐ | Result 模式 | 所有操作返回 `Result<T, E>`，杜绝未处理异常 |
| **Mastra** ⭐⭐ | 结构化错误 | ErrorDomain(19种) + ErrorCategory(4种) |
| **Mastra** | Bail 提前退出 | 步骤可 `bail()` 终止 workflow 并返回自定义结果 |
| **Pi** | 截断保护 | LLM 输出被截断时不执行可能不完整的工具调用 |
| **Pi** | Phase 状态机 | 防止并发操作冲突导致的状态混乱 |

**Octopus 建议**:

```
快速失败 + 降级:

1. 结构化错误 (借鉴 Mastra)
   interface NodeError {
     domain: 'BASH' | 'PYTHON' | 'AGENT' | 'CONDITION' | ...
     category: 'TRANSIENT' | 'DETERMINISTIC' | 'TIMEOUT' | 'RESOURCE'
     code: string          // e.g. 'BASH_EXIT_CODE_1'
     retryable: boolean    // 是否可重试
     message: string
     details?: Record<string, any>
   }

2. 快速失败链
   ├── 脚本 exit code ≠ 0 → 立即标记 DETERMINISTIC
   ├── 连续 2 个节点 TIMEOUT → 整个 branch 降级
   └── 同一错误模式出现 3 次 → workflow 级断路器

3. 降级策略
   ├── skip: 跳过失败节点，标记为 degraded
   ├── fallback: 执行备用节点
   ├── suspend: 挂起等待人工干预
   └── abort: 终止 workflow，保留已完成节点的结果
```

---

## 核心设计模式提取 (按优先级排序)

### P0 — 必须实现

#### 1. 事件驱动 + 钩子返回值 (from Pi)

```typescript
// 每种生命周期事件都有强类型钩子，返回值可直接影响执行
interface WorkflowHooks {
  beforeNodeExecute(node, ctx): { skip?: boolean; overrideInput?: any }
  afterNodeExecute(node, result): { overrideResult?: any; retry?: boolean; retryReason?: string }
  onNodeError(node, error): { retry?: boolean; fallback?: any; escalate?: boolean }
  beforeWorkflowStart(wf): { cancel?: boolean }
  onWorkflowComplete(wf, result): void
}
```

**为什么 P0**: 这是所有其他机制的基础设施——监控、约束、纠错都通过钩子实现。

#### 2. 节点级 + Workflow 级超时 (所有项目都缺，Octopus 必须自建)

```typescript
// 节点级
interface NodeConfig {
  timeout?: number | string  // e.g. 300, '5m', '1h'
  timeoutAction?: 'fail' | 'skip' | 'suspend'
}

// Workflow 级
interface WorkflowConfig {
  maxDuration?: number | string  // 全局 deadline
  deadlineAction?: 'abort' | 'suspend' | 'notify'
}

// 实现: AbortController + setTimeout
```

#### 3. 结构化错误分类 (from Pi + Mastra 综合)

```typescript
// 统一错误类型，驱动重试和降级决策
type NodeErrorCategory = 
  | 'TRANSIENT'      // 网络/超时/500 → 重试
  | 'DETERMINISTIC'  // 语法/参数/权限 → 立即失败
  | 'STRATEGIC'      // 逻辑/方法错误 → 换策略重试
  | 'RESOURCE'       // OOM/磁盘满 → 通知 + 挂起
  | 'SAFETY'         // 危险操作 → 终止 + 报告
```

#### 4. 进程隔离 (from Mastra V8 Isolate + Pi 进程组)

```typescript
// Bash/Python 节点执行环境
interface ExecutionIsolation {
  processGroup: boolean     // 独立进程组，kill 不影响宿主
  portRange: [number, number]  // 隔离端口范围
  fsWhitelist: string[]     // 允许操作的文件系统路径
  networkPolicy: 'allow' | 'deny' | 'whitelist'
  memoryLimit?: number      // MB
  cpuLimit?: number         // 百分比
}
```

### P1 — 应该实现

#### 5. Persist-Every-Step 快照 (from Mastra)

```typescript
// 每步执行后立即持久化完整状态
interface WorkflowSnapshot {
  runId: string
  status: 'running' | 'suspended' | 'failed' | 'success' | 'canceled'
  completedNodes: Map<string, NodeResult>
  pendingNodes: string[]
  variables: Record<string, any>
  timestamp: number
  error?: NodeError
}
```

#### 6. TripWire 智能中断 (from Mastra)

```typescript
// Guard 检测到问题时，带反馈中断而非静默失败
class TripWire {
  reason: string
  retry: boolean          // 是否允许重试
  metadata?: any          // 结构化上下文
  suggestedAction?: string // 建议的纠正方向
}
```

#### 7. 断路器 + 裁决 (from Superpowers)

```typescript
interface CircuitBreaker {
  maxRetries: number        // 硬上限
  maxDuration: number       // 时间上限
  onTrip: 'arbitrate' | 'fail' | 'suspend'
  
  // 裁决分类
  arbitrate(findings: Finding[]): ArbitrationResult
  // → 'disputable' (审查者错了) → park
  // → 'deferrable' (真实但下游不依赖) → park
  // → 'load-bearing' (承重问题) → STOP, 报告人类
}
```

#### 8. 6 种 Schema 验证 (from Mastra)

```typescript
// 全链路校验
interface NodeSchemas {
  inputSchema?: ZodSchema    // 输入数据
  outputSchema?: ZodSchema   // 输出数据
  stateSchema?: ZodSchema    // 状态数据
  resumeSchema?: ZodSchema   // 恢复数据
  configSchema?: ZodSchema   // 节点配置
}
```

### P2 — 值得实现

#### 9. Gap-Focused 迭代 (from Superpowers + matt-pipeline-loop)

每轮只修复失败的部分，carryover 追踪确保遗漏项不被遗忘。

#### 10. Context Hygiene (from matt-pipeline-loop)

每轮迭代后写 handoff 文件，保护性上下文跨轮存活。

#### 11. Suspend/Resume + TimeTravel (from Mastra)

步骤可挂起等待外部输入（审批），支持从历史步骤重跑。

#### 12. Ledger 台账系统 (from Superpowers)

所有执行状态写磁盘，上下文压缩后从文件恢复，不依赖内存。

---

## 建议的 Harness 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Harness Controller                         │
│                                                              │
│  ┌─ Lifecycle Hooks ────────────────────────────────────┐   │
│  │ beforeWorkflowStart → beforeNodeExecute →             │   │
│  │ afterNodeExecute → onNodeError → onWorkflowComplete  │   │
│  │                                                        │   │
│  │ 钩子返回值可: skip / override / retry / escalate      │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Protection Layer ───────────────────────────────────┐   │
│  │                                                        │   │
│  │ Timeout:        节点级 + Workflow 级 AbortController   │   │
│  │ CircuitBreaker: max_retries + max_duration → 裁决     │   │
│  │ ErrorClassifier: TRANSIENT | DETERMINISTIC | STRATEGY │   │
│  │ SmartRetry:     策略变异(同方法→换方法→换模型→裁决)    │   │
│  │ ProcessGuard:   禁止子进程 kill 父进程                │   │
│  │ KillSwitch:     env var 一键禁用                      │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Isolation Layer ────────────────────────────────────┐   │
│  │                                                        │   │
│  │ Bash/Python: 独立进程组 + 端口隔离 + 文件系统白名单    │   │
│  │ Agent:        Worktree 隔离                           │   │
│  │ 全局:         宿主 PID 保护 + 端口冲突检测            │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ State Spine (Ledger) ──────────────────────────────┐    │
│  │                                                        │   │
│  │ WorkflowSnapshot: 每步后持久化完整状态                │   │
│  │ NodeResults:      已完成节点的结果快照               │   │
│  │ ErrorLog:         结构化错误日志                     │   │
│  │ RecoveryPoint:    崩溃恢复点                         │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Observability ─────────────────────────────────────┐    │
│  │                                                        │   │
│  │ SpanTree:       每个节点一个 Span，嵌套在 Workflow    │   │
│  │                 Span 下                               │   │
│  │ EventStream:    SSE 推送节点开始/完成/错误事件        │   │
│  │ Metrics:        执行时间/成功率/重试次数/错误分布     │   │
│  │ HealthCheck:    /actuator/health 端点                 │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Degradation Strategies ───────────────────────────┐     │
│  │                                                        │   │
│  │ skip:     跳过失败节点，标记 degraded                 │   │
│  │ fallback: 执行备用节点/脚本                           │   │
│  │ suspend:  挂起等待人工干预 (Approval)                 │   │
│  │ retry:    策略变异重试 (TripWire 反馈)               │   │
│  │ abort:    终止 workflow，保存已完成结果               │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 实施优先级建议

| Phase | 内容 | 解决的痛点 | 工作量 |
|-------|------|-----------|--------|
| **Phase 1** | 进程隔离 + 宿主保护 | e2e 杀死宿主 | 2-3天 |
| **Phase 2** | 节点/Workflow 超时 + 结构化错误分类 | 脚本卡死 + 傻重试 | 2-3天 |
| **Phase 3** | 事件钩子系统 + Persist-Every-Step | 可监控 + 崩溃恢复 | 3-4天 |
| **Phase 4** | 智能重试 + 断路器 + TripWire | 傻重试 | 2-3天 |
| **Phase 5** | Schema 验证 + 降级策略 | 错误雪崩 | 2天 |
| **Phase 6** | Suspend/Resume + Observability | 完整可观测性 | 3-4天 |

**总计**: ~15-20 天，按 Phase 递进交付。
