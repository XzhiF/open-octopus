# Spec: Agent Workflow Integration — 版本管理 + octopus_agent 节点 + 委派协议

## Problem Statement

当前 Octopus 系统存在三个关键缺口：

1. **Agent 无版本管理**：分身（clone）的配置（persona.md、config.json、skills）可以被任意修改，但没有版本历史、无法回滚、无法追溯。一旦错误修改，前功尽弃。
2. **Workflow 无法直接委派 Agent**：现有 workflow 的 `agent` 节点只能发送 raw prompt 给 LLM，无法以结构化方式调用系统定义的 Agent/分身，无法指定版本，无法利用分身积累的专业能力和记忆。
3. **缺乏监督控制**：长任务执行中，无法监控 agent 进度、预算消耗，无法在方向偏离时及时干预。

## Solution

构建一套完整的 Agent 版本管理 + 结构化委派系统：

1. **版本管理**：为所有 Agent（Main Agent + 分身）添加 Release Tag 版本管理，支持 Maven-style 阶段限定符（alpha/beta/rc/stable），DB + 文件系统双存储。
2. **octopus_agent 节点**：新的 workflow 节点类型，扩展 AgentExecutor，支持版本解析、结构化 Task Contract、Heartbeat 上报。
3. **四层协议栈**：Contract（任务入/出）+ Observation（状态监控）+ Intervention（控制注入）+ Transport（现有基础设施），在 chain/DAG/loop/dynamic_sub_workflow 中一致工作。

## Projects Involved

- [ ] **packages/shared** — 版本 Zod schemas、TaskMessage/StructuredResult/Heartbeat/HarnessDirective 类型定义、版本解析工具
- [ ] **packages/engine** — OctopusAgentExecutor 执行器、Heartbeat 事件流、基础 Intervention 处理
- [ ] **packages/server** — AgentVersionService（版本 CRUD + 发布/回滚）、版本 API 路由、版本文件管理、DB migration
- [ ] **packages/web-app** — 分身详情页 Versions Tab、版本列表/详情/diff/发布/回滚 UI

## Feature Scope

**Do:**
- Agent 版本管理（发布、查看历史、回滚、diff 对比）
- octopus_agent 节点（版本解析 + Task Contract + Heartbeat + 基础 Intervention）
- 在 chain/DAG/loop/dynamic_sub_workflow 中支持 octopus_agent 节点
- 版本管理 API + 前端 Versions Tab
- Heartbeat SSE 事件推送
- 基础 Intervention（abort/pause）

**Don't:**
- Harness 规则引擎（redirect/checkpoint/自动判断）— 后续迭代
- A2A 外部 agent 互操作
- 分身创建/编辑 UI 重构
- 跨组织 Agent 共享
- Agent A/B 测试

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 版本语义模型 | Release Tag + Maven 限定符 | 不可变版本 + 阶段控制，workflow 可 pin 或 follow latest |
| 2 | 执行器定位 | 组合模式包装 AgentExecutor | 复用 AgentNodeRunner + session 基础设施，通过组合而非继承保持解耦 |
| 3 | 委派协议 | 四层协议栈 (Contract + Observation + Intervention + Transport) | 兼顾简洁和监控能力，Harness 可独立迭代 |
| 4 | 数据存储 | DB + Filesystem 双存储 | DB 查询 + FS 运行时性能 |
| 5 | Session 管理 | New Delegate Session | 隔离干净，不影响分身直接对话 |
| 6 | Harness 范围 | Observation + 基础 Intervention | 足够监控 + 紧急刹车，复杂规则留后续 |
| 7 | 前端呈现 | 分身详情页 + Versions Tab | 最小侵入，复用现有组件 |
| 8 | 编排兼容 | Delegation Protocol 与 Orchestration 独立 | octopus_agent 在任何编排上下文中 YAML 结构一致 |

### Story Gap Fixes (from Walk-Through Analysis)

| # | Severity | Fix |
|---|----------|-----|
| BP-01 | CRITICAL | 版本基础设施: schema v33 → paths.ts → AgentVersionService → routes → UI (自底向上构建) |
| BP-02 | CRITICAL | octopus_agent 注册: NodeDef.type + NodeSchema Zod + ExecutorFactory switch + node-icon-config (单次提交) |
| BP-03 | CRITICAL | OctopusAgentExecutor: 组合模式包装 AgentExecutor（非继承），新增 versionResolver + heartbeat + taskPrompt |
| BP-04 | CRITICAL | Intervention endpoint: 新路由 `POST /:executionId/harness-intervene`，v1 映射到 execution-level pause/abort |
| BP-05 | HIGH | Heartbeat SSE: 新增 `AgentEvent` heartbeat 变体 → EngineCallbacks.onAgentEvent → SSE `agent_heartbeat` |
| BP-06 | HIGH | Confidence/issues: v1 设为 -1/[]，后续迭代通过 heartbeat prompt 协议实现 agent 自报告 |
| BP-07 | HIGH | Pause 语义: v1 使用 execution-level pause，后续迭代实现 node-level pauseAtNode() |
| BP-08 | HIGH | Rollback 原子性: 补偿事务模式（FS 失败 → DB 回滚），原子替换（temp dir → clone dir） |
| BP-09 | HIGH | Dynamic L3: ALLOWED_TYPES 增加 octopus_agent，L1 允许 task.brief 替代 prompt |
| BP-10 | HIGH | Delegate session: 实现 createDelegateSession()（sessions.session_type 列已就绪） |

## Decision Map Summary

| # | Ticket | Type | Decision |
|---|--------|------|----------|
| 01 | Multi-Agent Orchestration | research | 8 框架对比，11 条 Octopus 建议 |
| 02 | Agent Versioning | research | Snapshot + 独立版本表 + tag resolution |
| 03 | Communication Protocols | research | 5 层协议栈，A2A + MCP + 结构化委派 |
| 04 | Version Semantics | grilling | Release Tag + Maven alpha/beta/rc/stable |
| 05 | Executor Positioning | grilling | OctopusAgentExecutor extends AgentExecutor |
| 06 | Delegation Protocol | grilling | 四层协议栈 |
| 07 | Version Data Model | grilling | DB + FS 双存储 |
| 08 | Session Management | grilling | New Delegate Session |
| 09 | Harness Scope | grilling | Observation + 基础 Intervention |
| 10 | Frontend UI | grilling | 分身详情页 + Versions Tab |

Map: [map.md](./map.md)

## User Stories

1. As a **平台管理者**, I want to **发布分身的新版本**, so that I can 追踪变更历史并在需要时回滚。
2. As a **平台管理者**, I want to **查看某个分身的所有版本历史**, so that I can 了解配置演变过程。
3. As a **平台管理者**, I want to **对比两个版本之间的 diff**, so that I can 审查具体变更内容。
4. As a **平台管理者**, I want to **回滚到某个历史版本**, so that I can 快速恢复错误修改前的状态。
5. As a **workflow 开发者**, I want to **在 workflow 中使用 octopus_agent 节点**, so that I can 将任务委派给系统定义的专业分身。
6. As a **workflow 开发者**, I want to **指定 agent 的具体版本**, so that I can 确保 workflow 使用经过验证的配置运行。
7. As a **workflow 开发者**, I want to **在 octopus_agent 节点中定义结构化任务简报（Task Contract）**, so that agent 能明确理解任务目标、上下文和预期输出。
8. As a **workflow 运行监控者**, I want to **实时看到 octopus_agent 的 Heartbeat 进度**, so that I can 判断任务是否在正确方向上推进。
9. As a **workflow 运行监控者**, I want to **在 agent 偏离方向或预算超标时暂停/终止它**, so that I can 避免资源浪费。
10. As a **workflow 开发者**, I want to **在 dynamic_sub_workflow 中使用 octopus_agent 节点**, so that 动态生成的子 workflow 也能委派给专业分身。
11. As a **平台管理者**, I want to **为 Main Agent (Octopus Agent) 管理版本**, so that 主 agent 的配置变更也可追溯。

## Implementation Decisions

### 1. 版本管理数据模型

#### DB Schema (packages/server)

```sql
-- 新表: agent_versions
CREATE TABLE agent_versions (
  id TEXT PRIMARY KEY,                -- UUID
  agent_name TEXT NOT NULL,           -- clone name 或 '__main__' (Main Agent)
  version TEXT NOT NULL,              -- "1.2.0-beta.1"
  major INTEGER NOT NULL,             -- 1
  minor INTEGER NOT NULL,             -- 2
  patch INTEGER NOT NULL,             -- 0
  stage TEXT NOT NULL DEFAULT 'stable', -- alpha | beta | rc | stable
  status TEXT NOT NULL DEFAULT 'draft', -- draft | published | archived
  snapshot TEXT NOT NULL,             -- JSON: { persona: string, config: object, skills: string[] }
  -- Note: config 使用 config.json 格式（与 clone-resolver.ts 一致，非 config.yaml）
  changelog TEXT,                     -- 变更说明
  published_at TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(agent_name, version)
);

CREATE INDEX idx_agent_versions_name_status
  ON agent_versions(agent_name, status);
CREATE INDEX idx_agent_versions_name_stage
  ON agent_versions(agent_name, stage, published_at DESC);

-- clones 表增加字段
ALTER TABLE clones ADD COLUMN current_version_id TEXT REFERENCES agent_versions(id);
```

#### Filesystem 结构

```
~/.octopus/agent/
├── versions/                          # 版本快照目录 (新增)
│   ├── __main__/                      # Main Agent 版本
│   │   ├── 1.0.0/
│   │   │   ├── persona.md
│   │   │   ├── config.json          # 注意: config.json 非 config.yaml（与 clone-resolver.ts 一致）
│   │   │   └── skills/
│   │   └── 1.1.0-alpha/
│   ├── workspace/                     # 分身版本
│   │   ├── 1.0.0/
│   │   ├── 1.1.0-beta.1/
│   │   └── 1.2.0/
│   └── scheduler/
│       └── ...
├── clones/                            # 当前活跃 (不变)
│   ├── workspace/
│   └── ...
└── built-in/                          # 内置分身 (不变)
    └── ...
```

### 2. OctopusAgentExecutor

#### 类型定义 (packages/shared)

```typescript
// packages/shared/src/types/octopus-agent.ts

interface OctopusAgentNodeDef extends NodeDef {
  type: 'octopus_agent'
  agent: string                    // clone name 或 '__main__'
  version?: string                 // "1.2.0-beta.1" | "latest" (default)
  min_stage?: VersionStage         // 最低阶段要求 (default: stable)
  task: TaskContract
  harness?: HarnessConfig
}

interface TaskContract {
  brief: string                    // 任务简述
  context?: string[]               // 注入的上下文 ($vars.*, $nodeId.output)
  constraints?: string[]           // 约束条件
  expected_output?: OutputSchema   // 预期输出 schema
  sop?: string                     // 标准操作流程
  budget?: BudgetConfig            // 预算配置
}

interface OutputSchema {
  type?: string                    // code_changes | analysis | decision | text
  schema?: Record<string, any>     // JSON Schema for structured output
}

interface BudgetConfig {
  max_tokens?: number
  max_duration?: number            // seconds
  max_cost_usd?: number
}

interface HarnessConfig {
  heartbeat_interval?: number      // steps between heartbeats (default: 3)
  heartbeat_timeout?: number       // seconds without heartbeat → warn (default: 300)
  auto_abort_on_budget?: boolean   // auto-abort when budget exceeded (default: true)
}

type VersionStage = 'alpha' | 'beta' | 'rc' | 'stable'

// Heartbeat 事件
interface AgentHeartbeat {
  step: number
  total_steps?: number             // 如果可预估
  tokens_used: number
  tokens_budget?: number
  artifacts: string[]              // 已产出的文件/结果
  issues: string[]                 // 遇到的问题
  confidence: number               // 0-1
  current_activity?: string        // 当前在做什么
}

// 结构化结果
interface StructuredResult {
  status: 'completed' | 'failed' | 'partial' | 'aborted' | 'budget_exceeded'
  output: Record<string, any>      // 结构化输出
  artifacts: Artifact[]            // 产出物
  vars_update?: Record<string, any> // VarPool 更新
  summary: string                  // 人类可读摘要
  token_usage: { input: number; output: number; total: number }
  duration_ms: number
}

interface Artifact {
  type: 'code' | 'file' | 'text' | 'data'
  path?: string
  content?: string
  description?: string
}

// Harness Directive (Intervention)
type HarnessDirectiveType = 'abort' | 'pause'

interface HarnessDirective {
  type: HarnessDirectiveType
  reason: string
  issued_by: string                // 'harness' | 'user'
  timestamp: number
}
```

#### 版本解析 (packages/shared)

```typescript
// packages/shared/src/version/version-resolver.ts

interface ResolvedVersion {
  version: string
  stage: VersionStage
  snapshot: AgentSnapshot
  fsPath: string                   // ~/.octopus/agent/versions/{name}/{version}/
}

class VersionResolver {
  resolve(agentName: string, versionSpec: string, minStage?: VersionStage): ResolvedVersion
  // "latest" → 最新 published stable (或 >= minStage)
  // "1.2.0" → 精确匹配
  // "1.2.0-beta.1" → 精确匹配
  // 找不到 → throw VersionNotFoundError
}

function compareVersions(a: string, b: string): number
// Maven-style comparison: 1.2.0-alpha.1 < 1.2.0-beta.1 < 1.2.0-rc.1 < 1.2.0

function stageRank(stage: VersionStage): number
// alpha=0, beta=1, rc=2, stable=3
```

#### OctopusAgentExecutor (packages/engine)

```typescript
// packages/engine/src/executors/octopus-agent.ts

class OctopusAgentExecutor implements NodeExecutor {
  // 组合模式：内部持有 AgentExecutor 实例 + 新增能力
  // 1. resolveAgentVersion() — 从 VersionResolver 获取 persona/config/skills
  // 2. buildTaskPrompt() — 从 TaskContract 构建结构化 prompt
  // 3. setupHeartbeat() — 配置 Heartbeat 事件流
  // 4. parseStructuredResult() — 解析 StructuredResult
  // 5. handleIntervention() — 处理 HarnessDirective

  private agentExecutor: AgentExecutor  // 组合，非继承
  private versionResolver: VersionResolver
  private heartbeatHandler: HeartbeatHandler

  async execute(): Promise<NodeExecutionResult> {
    // 1. 解析版本 (try/catch: VersionNotFoundError → node status='failed')
    let resolved: ResolvedVersion
    try {
      resolved = this.versionResolver.resolve(node.agent, node.version, node.min_stage)
    } catch (e) {
      return { status: 'failed', error: `Version resolution failed: ${e.message}`, ... }
    }

    // 2. 创建 delegate session
    const session = await createDelegateSession(node.agent, resolved.version, executionId)

    // 3. 构建 Task Contract prompt
    const prompt = buildTaskPrompt(node.task, pool)

    // 4. 配置 Heartbeat (通过 AgentEvent 流 → SSE 桥接)
    this.heartbeatHandler = new HeartbeatHandler(node.harness, this.callbacks)

    // 5. 委托给内部 AgentExecutor 执行
    const result = await this.agentExecutor.run(prompt, {
      systemPrompt: loadFromSnapshot(resolved),
      sessionId: session.id,
      cwd: executionCwd,
      agents: resolveSubAgents(resolved),
      onAgentEvent: (event) => this.heartbeatHandler.onAgentEvent(event)
    })

    // 6. 解析结构化结果
    const structured = parseStructuredResult(result.finalText)

    // 7. 返回 NodeExecutionResult (vars_update 通过 outputs mapping 统一处理)
    return {
      status: mapResultStatus(structured.status),
      lastOutput: structured.summary,
      outputs: { ...structured.output, ...structured.vars_update },
      sessionId: session.id,
      tokens: structured.token_usage,
      durationMs: structured.duration_ms,
      ...applyOutputsMapping(node.outputs, structured)
    }
  }
}
```

#### Task Prompt 构建

```markdown
## Task Delegation

### Brief
{task.brief}

### Context
{resolved context items from $vars.* and $nodeId.output.*}

### Constraints
{task.constraints joined}

### Expected Output
Type: {task.expected_output.type}
Schema: {JSON Schema if provided}

### Standard Operating Procedure
{task.sop}

### Budget
Max tokens: {budget.max_tokens}
Max duration: {budget.max_duration}s

### Instructions
Execute this task according to the brief and SOP above.
- Report progress via heartbeat every {harness.heartbeat_interval} steps
- Return results as structured JSON matching the expected output schema
- If you encounter blocking issues, include them in the heartbeat issues array
```

### 3. Heartbeat 事件流

```typescript
// packages/engine/src/executors/agent-runner.ts (扩展)

// 在 AgentEvent 联合类型中新增:
type AgentEvent = ... | { type: 'heartbeat'; data: AgentHeartbeat }

// HeartbeatHandler:
class HeartbeatHandler {
  private stepCounter = 0
  private lastHeartbeatAt = Date.now()

  onAgentEvent(event: AgentEvent) {
    if (event.type === 'tool_result') {
      this.stepCounter++
      if (this.stepCounter % this.config.heartbeat_interval === 0) {
        this.emitHeartbeat()
      }
    }
    this.lastHeartbeatAt = Date.now()

    // Budget auto-abort: 检查 token 消耗是否超过预算
    if (this.config.auto_abort_on_budget && this.config.budget?.max_tokens) {
      const used = this.tokenTracker.total
      if (used > this.config.budget.max_tokens) {
        this.callbacks.onAgentEvent({
          type: 'harness_directive',
          data: { type: 'abort', reason: `Token budget exceeded: ${used}/${this.config.budget.max_tokens}` }
        })
      }
    }
  }

  checkStall() {
    // 定时检查: 如果超过 heartbeat_timeout 没有事件 → emit stall warning
    if (Date.now() - this.lastHeartbeatAt > this.config.heartbeat_timeout * 1000) {
      this.callbacks.onAgentEvent({ type: 'heartbeat_stall', data: { nodeId: this.nodeId } })
    }
  }

  private emitHeartbeat() {
    const heartbeat: AgentHeartbeat = {
      step: this.stepCounter,
      tokens_used: this.tokenTracker.total,
      tokens_budget: this.config.budget?.max_tokens,
      artifacts: this.collectArtifactsFromOutput(),  // 从 StructuredResult.output 中提取
      issues: [],       // v1: 留空，后续迭代通过 heartbeat prompt 协议让 agent 自报告
      confidence: -1,   // v1: -1 表示未实现，后续迭代通过 heartbeat prompt 协议实现
      current_activity: this.lastActivityDescription
    }
    // 通过 onAgentEvent → EngineCallbacks → SSEService.emit('agent_heartbeat') 桥接
    this.callbacks.onAgentEvent({ type: 'heartbeat', data: heartbeat })
  }
}
```

### 4. 基础 Intervention

```typescript
// v1 策略: 复用现有 execution-level pause/abort 机制
// 后续迭代: 实现真正的 node-level pause (需要 engine 层改造)

// API endpoint:
// POST /api/workspaces/:id/executions/:executionId/harness-intervene
// Body: { nodeId: string, directive: HarnessDirective }

// Implementation:
// - 'abort' → 调用 ExecutionLifecycle.cancel(executionId)
//   → signal.abort() → AgentNodeRunner 收到 AbortSignal → 终止
// - 'pause' → 调用 ExecutionLifecycle.pause(executionId)
//   → engine 在当前 node 完成后暂停 → node status='paused'
//
// Note: v1 中 pause 暂停的是整个 execution，非单个 node
// 这与现有 ExecutionLifecycle.pause() 语义一致
// 后续迭代可实现 engine.pauseAtNode(nodeId) 达到 node 级别暂停

// HarnessDirective type (v1 only abort/pause):
type HarnessDirectiveType = 'abort' | 'pause'
```

### 5. API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/api/clones/:name/versions` | Server | `?status=published&stage=stable` | `{ versions: AgentVersion[], total }` | 版本列表 |
| GET | `/api/clones/:name/versions/:version` | Server | — | `AgentVersion` (含 snapshot) | 版本详情 |
| POST | `/api/clones/:name/versions` | Server | `{ version, stage, changelog }` | `AgentVersion` | 发布新版本 |
| PATCH | `/api/clones/:name/versions/:version` | Server | `{ status: 'archived' }` | `AgentVersion` | 更新版本状态 |
| POST | `/api/clones/:name/versions/:version/rollback` | Server | — | `{ success, previous_version }` | 回滚到指定版本 |
| GET | `/api/clones/:name/versions/diff` | Server | `?from=v1&to=v2` | `{ persona_diff, config_diff, skills_diff }` | 版本 diff |
| GET | `/api/agents/main/versions` | Server | same as clones | same as clones | Main Agent 版本 (agent_name='__main__') |
| POST | `/api/executions/:id/harness-intervene` | Server | `{ nodeId, directive: HarnessDirective }` | `{ success }` | 注入控制指令 (v1: execution-level pause/abort) |

### 6. ExecutorFactory 注册

```typescript
// packages/engine/src/executor-factory.ts — 新增 case:
case "octopus_agent":
  return new OctopusAgentExecutor(node, pool, {
    agentRunner: this.ctx.agentRunner,
    versionResolver: this.ctx.versionResolver,
    previousSessionId: this.resolvePreviousSessionId(node),
    engineContext: this.ctx.engineContext,
    callbacks: this.ctx.callbacks,
    providerKey: this.ctx.providerKey,
    resolvedModel: this.ctx.resolvedModel,
    ...
  })
```

### 7. NodeSchema Zod 扩展

```typescript
// packages/shared/src/types/workflow.ts — NodeDef.type 联合类型扩展:
type NodeType = 'bash' | 'python' | 'condition' | 'approval' | 'agent'
              | 'swarm' | 'interaction' | 'loop' | 'sub_workflow'
              | 'dynamic_sub_workflow' | 'octopus_agent'  // 新增

// NodeSchema 增加 octopus_agent 的验证规则:
octopus_agent: z.object({
  type: z.literal('octopus_agent'),
  agent: z.string(),
  version: z.string().optional(),
  min_stage: z.enum(['alpha', 'beta', 'rc', 'stable']).optional(),
  task: z.object({
    brief: z.string(),
    context: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    expected_output: z.object({
      type: z.string().optional(),
      schema: z.record(z.any()).optional()
    }).optional(),
    sop: z.string().optional(),
    budget: z.object({
      max_tokens: z.number().optional(),
      max_duration: z.number().optional(),
      max_cost_usd: z.number().optional()
    }).optional()
  }),
  harness: z.object({
    heartbeat_interval: z.number().optional(),
    heartbeat_timeout: z.number().optional(),
    auto_abort_on_budget: z.boolean().optional()
  }).optional(),
  outputs: z.record(z.string()).optional()
})
```

### 8. SSE 事件扩展

```typescript
// 新增 SSE 事件类型:
interface HeartbeatEvent {
  event: 'agent_heartbeat'
  data: {
    execution_id: string
    node_id: string
    agent_name: string
    version: string
    heartbeat: AgentHeartbeat
  }
}

// 通过现有 EngineCallbacks.onAgentEvent() → SSEService.emit() 桥接
```

### 9. dynamic_sub_workflow 兼容

```yaml
# dynamic_sub_workflow 生成的 YAML 可直接包含 octopus_agent 节点:
dynamic_sub_workflow:
  id: dynamic-impl
  prompt: "Generate implementation plan"
  nodes:
    - type: octopus_agent
      id: impl-agent
      agent: workspace
      version: "1.2.0"
      task:
        brief: "Implement the login endpoint per spec"
        context:
          - $vars.api_spec
          - $design-node.output
        expected_output:
          type: code_changes
        budget:
          max_tokens: 50000
          max_duration: 600
      outputs:
        $vars.impl_result: $last_output

    - type: octopus_agent
      id: test-agent
      agent: workspace
      version: "latest"
      task:
        brief: "Write tests for the login endpoint"
        context:
          - $impl-agent.output
        expected_output:
          type: code_changes
```

DynamicSubWorkflowExecutor 的 YAML 验证 harness 需要更新以识别 `octopus_agent` 类型：

1. **L3 验证**: `ALLOWED_TYPES` 从 `new Set(["agent"])` 扩展为 `new Set(["agent", "octopus_agent"])`
2. **L1 验证**: 对 `octopus_agent` 类型节点，不要求 `prompt` 字段，改为要求 `task.brief` 字段
3. **生成 prompt**: LLM 生成约束从 `"ALL nodes must have type: \"agent\""` 更新为允许 `octopus_agent` 类型
4. **L1 结构验证**: `octopus_agent` 节点使用 `task.brief` 代替 `prompt`，验证器需识别这种替代关系

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `agent_versions` | CREATE | id, agent_name, version, major, minor, patch, stage, status, snapshot(JSON), changelog, published_at, published_by, created_at |
| `clones` | ALTER | ADD COLUMN `current_version_id TEXT` |

## API Contracts

见 Implementation Decisions § 5 (API Contracts 表)。

## Design Specs

- Figma link: none
- Fidelity: 复用现有分身管理页面的 UI 风格，新增 Versions Tab

### 前端组件结构

```
packages/web-app/src/
├── components/
│   ├── clones/
│   │   ├── CloneVersionsTab.tsx       # 版本列表 Tab 内容
│   │   ├── VersionList.tsx            # 版本列表 (badge + status + date)
│   │   ├── VersionDetail.tsx          # 版本详情 (changelog + actions)
│   │   ├── VersionDiff.tsx            # 版本 diff 对比
│   │   └── PublishVersionDialog.tsx   # 发布新版本对话框
│   └── workflow/
│       └── nodes/
│           └── OctopusAgentNode.tsx   # octopus_agent 节点卡片
```

## Verification Strategy

### Verification Environment

| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev` |
| API prefix | `/api/` |
| Database | SQLite: `~/.octopus/db/octopus.db` |
| Server | `http://localhost:3001` |
| Admin UI | `http://localhost:3000` |

### Test Users & Data

| Item | Value |
|------|-------|
| Test account | admin (默认) |
| Data prefix | E2E_TEST_ |
| Cleanup | DELETE agent_versions WHERE agent_name LIKE 'E2E_TEST_%' |

### AC to Verification Method Mapping

| US# | User Story | AC | Verification Level | Verification Method |
|-----|-----------|-----|-------------------|---------------------|
| 1 | 发布版本 | 版本出现在版本列表 + DB + versions/ 目录 | Integration + DB | API POST + SELECT + fs.existsSync |
| 2 | 查看版本历史 | API 返回完整版本列表，按时间倒序 | Integration | API GET + assert array length |
| 3 | Diff 对比 | API 返回 persona/config/skills 的 diff | Integration | API GET diff + assert diff content |
| 4 | 回滚版本 | clones/ 目录恢复到目标版本 + DB 指针更新 | Integration + DB | API POST rollback + fs read + SELECT |
| 5 | octopus_agent 节点执行 | workflow 执行成功，agent 收到 TaskMessage | Integration + E2E | 创建 workflow YAML → run → assert result |
| 6 | 版本 pin | workflow 使用指定版本运行，非 latest | Integration | pin v1.0.0 → run → assert session.version = '1.0.0' |
| 7 | Task Contract | agent 收到结构化 prompt 含 brief/context/constraints | Unit + Integration | mock agentRunner → assert prompt content |
| 8 | Heartbeat 监控 | SSE 收到 agent_heartbeat 事件 | Integration | SSE subscribe → run workflow → assert event |
| 9 | 暂停/终止 | agent 响应 abort/pause 指令 | Integration | POST intervene → assert node status |
| 10 | dynamic_sub_workflow 兼容 | 动态子 workflow 包含 octopus_agent 节点成功执行 | E2E | dynamic_sub_workflow YAML → run → assert |
| 11 | Main Agent 版本 | Main Agent 可以发布/查看/回滚版本 | Integration | 同 US1-4，agent_name='__main__' |

### Verification Methods Detail

#### Unit Tests
- `VersionResolver.resolve()` — latest/pinned/min_stage 解析逻辑
- `compareVersions()` — Maven 风格版本比较
- `buildTaskPrompt()` — Task Contract prompt 构建
- `parseStructuredResult()` — 结构化结果解析
- `HeartbeatHandler` — 步数计数、超时检测

#### Integration Tests
- 版本 CRUD API (POST/GET/PATCH)
- 版本发布 + 文件系统双写验证
- 版本回滚 + 文件系统恢复验证
- octopus_agent 节点在 WorkflowEngine 中的端到端执行
- Heartbeat SSE 事件流
- Intervention API (abort/pause)

#### Browser E2E
- 分身详情页 Versions Tab：列表渲染、发布对话框、diff 查看、回滚操作
- octopus_agent 节点在 workflow 编辑器中的配置和执行

#### Contract Tests
- Zod schema ↔ TypeScript interface 一致性
- API response ↔ 前端组件 props 一致性

#### Manual Checklist
- 版本发布后重启 server，验证版本数据持久化
- 长任务执行中触发 abort，验证 agent 正确终止
- dynamic_sub_workflow 中 octopus_agent 节点的变量传递

### Anti-Fake-Run Standards (R1-R8)

| # | Criterion | Description |
|---|-----------|-------------|
| R1 | Real service | 使用 localhost:3001 真实 API |
| R2 | Business data | 断言具体字段值（version, stage, snapshot content） |
| R3 | Cross-validation | API response ↔ DB SELECT ↔ filesystem 三方验证 |
| R4 | Evidence | 保留 response body + DB query 结果 |
| R5 | Side effects | 写操作验证 DB 变更 + 文件系统变更 |
| R6 | Real user path | 通过正常 API 获取 session |
| R7 | Data isolation | E2E_TEST_ 前缀 |
| R8 | Repeatable | 测试自带 cleanup，无需手动前置步骤 |

### Prerequisites

- [ ] pnpm build 成功（所有包编译通过）
- [ ] SQLite schema migration 执行（SCHEMA_VERSION 递增）
- [ ] 至少一个内置分身（workspace）可用
- [ ] AI Provider 配置可用（用于实际执行测试）

## Risks & Notes

- **R1: 版本一致性风险** — DB snapshot 与 filesystem 可能不同步。Mitigation: 发布操作使用补偿事务模式（见下文）。
- **R2: Heartbeat 开销** — 频繁 heartbeat 可能增加 token 消耗。Mitigation: 默认 interval=3 步，heartbeat prompt 精简。
- **R3: 向后兼容** — 现有 workflow YAML 不受影响（octopus_agent 是新类型）。但 ExecutorFactory 需要更新。
- **R4: dynamic_sub_workflow 验证** — YAML 验证 harness 的 L3 whitelist + L1 结构验证需要更新，否则动态生成的 octopus_agent 节点会被拒绝。
- **R5: Pause 粒度** — v1 的 pause 是 execution-level（暂停整个 workflow），非 node-level。后续迭代实现 `engine.pauseAtNode()`。

### 发布/回滚原子性 (Compensating Transaction Pattern)

```
publish(agentName, version, stage, changelog):
  1. snapshot = filesToSnapshot(cloneDir)         # 读取文件系统
  2. BEGIN TRANSACTION
  3. INSERT INTO agent_versions (snapshot, ...)    # DB 写入
  4. COMMIT
  5. try: copyDir(cloneDir, versionDir)            # FS 复制
  6. catch: DELETE FROM agent_versions WHERE id=?  # DB 补偿回滚
           throw PublishError("FS copy failed, DB rolled back")

rollback(agentName, targetVersion):
  1. version = SELECT FROM agent_versions WHERE version=targetVersion
  2. tempDir = createTempDir()
  3. try: snapshotToFiles(version.snapshot, tempDir)  # 写入临时目录
  4. copyDir(tempDir, cloneDir, { overwrite: true })  # 原子替换
  5. UPDATE clones SET current_version_id = version.id
  6. catch: 保留 tempDir 用于诊断, throw RollbackError

filesToSnapshot(cloneDir):
  return {
    persona: readFile(cloneDir/persona.md),
    config: readJSON(cloneDir/config.json),    # config.json 格式
    skills: listDir(cloneDir/skills/)
  }

snapshotToFiles(snapshot, targetDir):
  writeFile(targetDir/persona.md, snapshot.persona)
  writeJSON(targetDir/config.json, snapshot.config)
  for skill in snapshot.skills: copySkill(skill, targetDir/skills/)
```

### Heartbeat 持久化

v1 中 heartbeat 数据通过以下方式持久化：
- **SSE ring buffer**: 500 事件（短期）
- **JSONL 日志**: 写入 `{executionDir}/heartbeats.jsonl`（与现有 agent events JSONL 并行）
- 后续迭代考虑 `agent_heartbeats` 表（如果需要查询/聚合）

## Glossary

| Term | Meaning |
|------|---------|
| Agent Version | Agent 配置的不可变快照（persona + config + skills），由版本号唯一标识 |
| Version Stage | 版本阶段：alpha（开发中）→ beta（测试中）→ rc（候选）→ stable（正式） |
| Task Contract | 委派给 agent 的结构化任务定义，包含 brief、context、constraints、expected_output |
| Heartbeat | Agent 执行期间的定时状态上报（进度、预算、产物、问题） |
| Harness Directive | 外部注入的控制指令（abort/pause），用于监督 agent 执行 |
| Delegate Session | octopus_agent 创建的独立 session，关联 clone_name + version + execution_id |
| Version Pinning | Workflow 指定 agent 的具体版本号，而非跟随 latest |
| Dual Storage | 版本数据同时存储在 DB（查询）和文件系统（运行时） |

## Appendix: Core User Stories（闭环验证）

### Story 1: 发布分身新版本并回滚

1. [UI] 打开分身 workspace 的详情页 → 切换到 Versions Tab
2. [UI] 点击 "Publish New Version" → 输入 version "1.0.0", stage "stable", changelog "Initial release"
3. [API] POST `/api/clones/workspace/versions` → 返回 201 + version object
4. [DB] `SELECT * FROM agent_versions WHERE agent_name='workspace' AND version='1.0.0'` → 1 row, status='published'
5. [FS] `~/.octopus/agent/versions/workspace/1.0.0/persona.md` exists → true
6. [UI] 修改 workspace 的 persona.md（做一些改动）
7. [UI] 再次发布版本 "1.1.0"
8. [UI] 在版本列表中点击 "1.0.0" → "Rollback"
9. [API] POST `/api/clones/workspace/versions/1.0.0/rollback` → 返回 200
10. [FS] `~/.octopus/agent/clones/workspace/persona.md` 内容恢复到 v1.0.0 的快照
11. [DB] `clones.current_version_id` 指向 v1.0.0 的 agent_versions.id

### Story 2: 在 workflow 中使用 octopus_agent 节点

1. [API] 创建 workflow YAML:
   ```yaml
   nodes:
     - type: octopus_agent
       id: dev-agent
       agent: workspace
       version: "1.0.0"
       task:
         brief: "Create a hello world API endpoint"
         constraints: ["Use Express.js"]
         expected_output:
           type: code_changes
         budget:
           max_tokens: 30000
   ```
2. [API] POST `/api/workspaces/:id/workflows` → 创建 workflow（inline validation）
3. [API] POST `/api/executions` → 执行 workflow（ExecutionLifecycle.create + start）
4. [SSE] 订阅 execution events → 收到 `agent_heartbeat` 事件（step 3, tokens 5000, ...）
5. [DB] `SELECT * FROM sessions WHERE session_type='delegate' AND clone_name='workspace'` → 1 row
6. [SSE] 收到 `node_end` 事件，status='completed'
6. [DB] `SELECT * FROM node_executions WHERE node_id='dev-agent'` → status='completed', outputs 包含 code_changes

### Story 3: 长任务监控与干预

1. [API] 创建包含 octopus_agent 的 workflow，task.brief="Refactor entire auth module", budget.max_duration=120
2. [API] 执行 workflow
3. [SSE] 收到多个 heartbeat 事件，tokens_used 逐步增加
4. [SSE] heartbeat 显示 confidence=0.4, issues=["Scope larger than expected"]
5. [API] POST `/api/workspaces/:id/executions/{id}/harness-intervene` → `{ nodeId: 'dev-agent', directive: { type: 'pause', reason: 'Review scope' } }`
6. [SSE] 收到 `node_end` 事件，status='paused'
7. [DB] 验证 execution 状态为 'paused'，node 状态为 'paused'
