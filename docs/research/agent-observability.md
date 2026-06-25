# Octopus Agent 可观测性功能规格书

> **作者**: Claude (Octopus) + Hermes (深度对话 30 轮 + 交叉评审 + 开发者接手审计)
> **日期**: 2026-06-01
> **状态**: 开发者接手就绪
> **版本**: v3.0（开发者接手审计修订版）

---

## 目录

1. [执行摘要](#执行摘要)
2. [Agent 可观测性理论基础](#agent-可观测性理论基础)
3. [Octopus 现状诊断](#octopus-现状诊断)
4. [开源方案对比与 Build vs Integrate](#开源方案对比)
5. [核心架构设计](#核心架构设计)
6. [数据模型](#数据模型)
7. [Provider 层可观测性](#provider-层可观测性)
8. [UI/UX 设计](#uiux-设计)
9. [API 设计](#api-设计)
10. [前端数据流架构](#前端数据流架构)
11. [智能建议引擎](#智能建议引擎)
12. [验收标准 (User Story + AC)](#验收标准)
13. [Feature Flag 策略](#feature-flag-策略)
14. [实施路线图](#实施路线图)
15. [代码改造清单](#代码改造清单)
16. [E2E 测试](#e2e-测试)
17. [视觉回归测试](#视觉回归测试)
18. [CI/CD 集成](#cicd-集成)
19. [性能基准](#性能基准)
20. [回退方案](#回退方案)
21. [错误边界与降级 UI](#错误边界与降级-ui)
22. [竞争壁垒分析](#竞争壁垒分析)
23. [附录](#附录)

---

## 执行摘要

### 核心结论

Octopus 的可观测性不是一个"功能"，而是一个**产品定位**。它定义了一个新品类：**AI-Native Workflow Observability** — 不是"workflow engine + monitoring plugin"，而是"the place where AI workflows are built, run, understood, and optimized"。

### 五大核心共识

1. **Agent 事件黑洞是最高优先级** — 当前 agent 推理链（thinking/tool calls/text）在内存中存在、在 SSE 中传输、在 JSONL 中记录，但从未进入 SQLite。执行结束后就丢失了。
2. **Phase 1-2 零新增依赖，分层混合架构** — 图表用 Recharts（已有）+ 纯 SVG。命令面板用 cmdk（已有）。动画用 CSS transitions。Phase 3 可能引入 d3-sankey (~8KB)。
3. **可观测性不是功能，而是产品定位** — 三个竞争壁垒：Workflow-Native Observability、DAG-Embedded Observability、Observability-Driven Optimization。
4. **可观测性代码永远不阻塞 workflow 执行** — 所有写入 fire-and-forget，所有错误静默处理。
5. **数据格式从第一天就兼容 OTel GenAI conventions** — 字段用简化名 + 映射表，未来导出零转换成本。

### 三个创新点

1. **Turn-Centric Narrative** — 以 Turn（LLM 调用轮次）为原子单位，不是以 event/span。用户看到"4 个章节的故事"而非"50 个散乱事件"。
2. **DAG-Embedded Observability** — 可观测性信息直接嵌入 workflow DAG 节点，零上下文切换。
3. **Observability-Driven Optimization** — 执行→观测→分析→建议→应用→验证的完整闭环。

### 一句话愿景

> Octopus 让 AI workflow 从"跑了就行"变成"看得见、看得懂、改得好"——每一次执行都产生可追溯的数据，每一组数据都生成可行动的洞察，每一条洞察都可以一键转化为改进。

---

## Agent 可观测性理论基础

### 与传统软件可观测性的 6 维区别

| 维度 | 传统软件 | Agent 系统 |
|------|---------|-----------|
| 执行路径 | 确定性（request→handler→DB→response） | 非确定性（同一输入可能触发不同 tool 调用序列） |
| 观测单元 | Request/Transaction | Session（包含数十次 LLM 调用、十几次 tool invocation） |
| 正确性 | 二值（200 或 500） | 连续（可能 hallucination、错误 tool 调用、推理链缺陷） |
| 成本模型 | 计算资源（CPU/RAM），与请求数线性 | Token 消耗，与推理深度相关（500~100K tokens） |
| 延迟分布 | P50/P99 相对稳定 | 高度不可预测（2 秒~10 分钟） |
| Provider 层 | 基础设施层的下游依赖 | Agent 的核心"大脑"，需要观测模型版本、prompt 注入、token 截断 |

### 6 大核心挑战（按难度排序）

1. **Trace 体积和复杂度** — 一个 agent session 可能有 2000+ spans，每个 span 携带完整 prompt/completion
2. **因果归因** — "是哪一步出了问题？"答案是非线性、概率性的
3. **在线评估的实时性** — 需要"质量 SLO"，但 LLM-as-Judge 本身有延迟和成本
4. **多 Agent 协作追踪** — handoff、共享状态、并发依赖
5. **可复现性** — 依赖完整 conversation history + 检索上下文 + 模型版本
6. **隐私与合规** — prompt/completion 可能包含 PII

### 业界关键参考

**论文:**
- "Evaluation and Benchmarking of LLM Agents: A Survey" (arXiv:2507.21504)
- Zheng et al. (2023) "Judging LLM-as-a-Judge" (arXiv:2306.05685)
- "Reflexion" (Shinn et al., 2023) — agent 自我反思框架

**标准:**
- OpenTelemetry GenAI Semantic Conventions (v1.41+) — gen_ai.* 属性族
- OpenLLMetry RFC #3460 — Session→Agent→Workflow→Task→LLM Calls/Tools/Memory/Guardrails
- Google AI Agent White Paper

### 可观测性公式

```
Agent 可观测性 = 传统三支柱（Traces/Metrics/Logs）
              + Evaluations（质量评估作为第四支柱）
              + Session 级别的非确定性追踪
              + Token 级成本归因
              + Provider 层一等公民观测
```

---

## Octopus 现状诊断

### 洋葱模型

```
Layer 8: 跨组织聚合分析              [完全缺失]
Layer 7: 告警 (Alerting)             [完全缺失]
Layer 6: 质量评估 (Evaluation)       [完全缺失]
Layer 5: 成本分析 (Cost Analytics)   [部分 — token 追踪存在，无分析]
Layer 4: 结构化指标 (Metrics)        [完全缺失]
Layer 3: Agent 内部追踪              [关键缺失 — Agent 事件黑洞]
Layer 2: 实时事件 (SSE)              [已有 — 14+ 事件类型，设计良好]
Layer 1: 执行状态持久化 (SQLite)     [已有 — 13 次 schema 迭代]
```

### Agent 事件黑洞（最严重问题）

```
AgentNodeRunner
    → 收集丰富的 AgentEvent（thinking/tool_start/tool_result/text_delta/status/result）
    → 通过 SSE emit 给前端实时展示
    → 通过 JsonlLogger 写入 JSONL 文件
    → 但最终...events 数组在 NodeExecutionResult 中返回后，被 SSE 展示后就消失了
    → node_executions 表只存 status/duration/exit_code/error/session_id
    → 完整的推理链（thinking 过程、tool 调用序列、每轮 token 消耗）从未持久化到 SQLite
```

### 已有的数据资产

- **executions 表**: 完整执行生命周期（status, progress, duration, retry_count, start/end_commit_id）
- **node_executions 表**: 每节点状态、时间、退出码
- **node_token_usages 表**: 按模型/节点的 token 计数（但 cost_usd 始终为 null）
- **branch_executions 表**: 循环迭代追踪
- **SSE 事件**: 14+ 事件类型的实时推送
- **ReactFlow DAG**: 完整的执行树可视化

---

## 开源方案对比

### 方案评估矩阵

| 方案 | 架构 | 嵌入可行 | Export Target | 技术栈匹配 | 评估 |
|------|------|---------|--------------|-----------|------|
| **Langfuse v3** | ClickHouse+Redis+S3+2 Node | 太重 | OTLP endpoint | TS SDK v4 | 作为可选 export |
| **Arize Phoenix** | Python, SQLite/PG | Python-first | OTel | 不匹配 | 不适合 |
| **OpenLLMetry** | Instrumentation 层 | N/A（是标准） | N/A | TS 有问题 | 采用 conventions |
| **Helicone** | LLM API Proxy | 不兼容 subprocess | N/A | N/A | 完全不适合 |
| **Laminar** | TS+Rust, OTel | 独立平台 | OTLP | 高度一致 | 架构参考价值 |
| **Braintrust** | SaaS | - | - | N/A | Diff 概念参考 |

### 结论：分层混合架构

```
自建核心（Layer 1-5）:
  - Agent 事件持久化、LLM 调用追踪、Workflow Analytics、成本分析、智能建议引擎

可选集成（Layer 6-8）:
  - Evaluation → 导出到 Langfuse/Phoenix
  - 告警 → Webhook（用户自行接入 Slack/Discord）
  - 跨组织聚合 → 未来按需
```

---

## 核心架构设计

### 整体架构

```
Engine (6 executors)
    │
    ▼
EngineCallbacks (onNodeStart/onNodeEnd/onAgentEvent/...)
    │
    ├── SSEService ──→ ReactFlow (实时 DAG)
    │
    ├── ExecutionService ──→ SQLite (executions/node_executions/token_usages)
    │
    └── ObservabilityService ──→ 新增
         │
         ├── SQLiteSink (default)
         │   ├── agent_events 表 (新增)
         │   ├── llm_calls 表 (新增)
         │   └── optimization_suggestions 表 (新增)
         │
         ├── SSE (已有，扩展)
         │
         └── OTLPSink (optional, Phase 4)
             ├── Langfuse Cloud/Self
             ├── Laminar
             └── Any OTel Backend
```

### ObservabilityService 设计

```typescript
interface ObservabilitySink {
  writeBatch(events: ObservabilityEvent[]): Promise<void>
  flush(): Promise<void>
  shutdown(): Promise<void>
}

class ObservabilityService {
  private sinks: ObservabilitySink[]
  private buffer: Map<string, AgentEvent[]>  // nodeExecId → events
  private turnTracker: Map<string, number>   // nodeExecId → current turn
  
  // 自动 flush 触发条件:
  // - buffer 达到 50 events
  // - 2 秒定时器
  // - turn 边界（检测到新 turn 开始时 flush 上一轮）
  // - 节点结束（onNodeEnd）
  
  bufferEvent(nodeExecId, event, meta): void
  flushNode(nodeExecId): void
  flushExecution(executionId): void
  persistLLMCalls(nodeExecId, executionId, calls, instanceId): void
  
  // 降级策略: 连续 10 次写入失败进入降级模式
  isDegraded(): boolean
}
```

### ObservabilityService 实现骨架

```typescript
// packages/server/src/services/observability.ts

interface NodeBuffer {
  events: FilteredAgentEvent[]   // 经过 PrivacyFilter 的事件
  meta: EventMeta
  turnIndex: number              // 当前 turn 编号
  lastEventOrder: number         // 上一个 event 的 order（用于递增）
  timer: ReturnType<typeof setTimeout> | null
}

class ObservabilityService {
  private db: Database.Database
  private buffers = new Map<string, NodeBuffer>()
  private consecutiveErrors = 0
  private degraded = false

  constructor(db: Database.Database) {
    this.db = db
  }

  bufferEvent(nodeExecId: string, event: AgentEvent, meta: EventMeta): void {
    if (this.degraded) return

    let buf = this.buffers.get(nodeExecId)
    if (!buf) {
      buf = { events: [], meta, turnIndex: 0, lastEventOrder: 0, timer: null }
      this.buffers.set(nodeExecId, buf)
    }

    // Turn 边界检测
    buf.turnIndex = computeTurnIndex(event.type, buf.turnIndex)

    // 追加事件
    buf.events.push({ ...event, turnIndex: buf.turnIndex || 1 })

    // 自动 flush 条件
    if (buf.events.length >= 50) {
      this.flushNode(nodeExecId)
    } else if (!buf.timer) {
      buf.timer = setTimeout(() => this.flushNode(nodeExecId), 2000)
    }
  }

  flushNode(nodeExecId: string): void {
    const buf = this.buffers.get(nodeExecId)
    if (!buf || buf.events.length === 0) return

    // 清除 timer
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null }

    // 取出 events 并清空 buffer
    const events = buf.events.splice(0)
    const meta = buf.meta

    // 计算 event_order（内存递增，避免 DB 查询）
    const rows = events.map((event, i) => ({
      node_execution_id: nodeExecId,
      event_order: buf.lastEventOrder + i + 1,
      turn_index: event.turnIndex,
      event_type: event.type,
      timestamp: event.timestamp,
      content: event.content ?? null,
      content_length: event.content?.length ?? 0,
      tool_call_id: event.toolCallId ?? null,
      tool_name: event.toolName ?? null,
      tool_input: event.toolInput ? JSON.stringify(event.toolInput) : null,
      tool_result: event.toolResult ?? null,
      tool_is_error: event.toolIsError ? 1 : 0,
      tool_duration_ms: event.toolDurationMs ?? null,
      status_value: event.statusValue ?? null,
      error_code: event.errorCode ?? null,
      error_message: event.errorMessage ?? null,
    }))
    buf.lastEventOrder += events.length

    // 批量 INSERT
    try {
      const stmt = this.db.prepare(`INSERT INTO agent_events (...) VALUES (...)`)
      const insertMany = this.db.transaction((rows) => {
        for (const row of rows) stmt.run(row)
      })
      insertMany(rows)
      this.consecutiveErrors = 0
    } catch (err) {
      this.consecutiveErrors++
      if (this.consecutiveErrors >= 10) {
        this.degraded = true
        console.error('[Observability] Degraded mode: 10 consecutive write failures')
      }
    }
  }

  flushExecution(executionId: string): void {
    // flush 所有属于该 execution 的 buffer
    for (const [nodeExecId] of this.buffers) {
      if (nodeExecId.startsWith(executionId + '-')) {
        this.flushNode(nodeExecId)
      }
    }
  }

  persistLLMCalls(nodeExecId: string, executionId: string,
                  calls: LLMCallRecord[], instanceId: string): void {
    const meta = this.buffers.get(nodeExecId)?.meta
    if (!meta) return

    const stmt = this.db.prepare(`INSERT INTO llm_calls (...) VALUES (...)`)
    const insertMany = this.db.transaction((calls) => {
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]
        const cost = computeCost(call, call.model ?? 'claude-sonnet-4-20250514')
        stmt.run({
          id: crypto.randomUUID(),
          node_execution_id: nodeExecId,
          execution_id: executionId,
          turn_index: call.turnIndex,
          call_index: i,
          message_id: call.messageId,
          model: call.model,
          stop_reason: call.stopReason,
          timestamp: call.timestamp,
          duration_ms: call.durationMs,
          ttft_ms: call.ttftMs ?? null,
          input_tokens: call.inputTokens,
          output_tokens: call.outputTokens,
          cache_read_tokens: call.cacheReadTokens,
          cache_creation_tokens: call.cacheCreationTokens,
          cost_usd: cost,
          org: meta.org,
          workspace_id: meta.workspaceId,
          workflow_ref: meta.workflowRef,
          node_id: meta.nodeId,
          session_id: meta.sessionId ?? null,
          instance_id: instanceId,
        })
      }
    })
    try { insertMany(calls) } catch { /* silent */ }
  }

  isDegraded(): boolean { return this.degraded }
}
```

### Turn 边界检测算法

```typescript
function computeTurnIndex(eventType: string, currentTurn: number): number {
  // thinking_start 标记新 turn 的开始
  if (eventType === 'thinking_start') {
    return currentTurn + 1
  }
  // 第一个 event 不是 thinking_start 时，强制归入 turn 1
  if (currentTurn === 0) {
    return 1
  }
  // 其他 event 保持当前 turn
  return currentTurn
}

// 边界情况处理:
// 1. 连续两个 thinking_start → turn 递增 2（正常，可能是 SDK 异常但数据完整）
// 2. 只有 tool_start 没有 thinking → turn 1（非推理型 agent）
// 3. result event → 不改变 turn（它属于最后一个 turn）
```

### 成本计算代码

```typescript
const MODEL_PRICING: Record<string, PricingTier> = {
  'claude-sonnet-4-20250514': { input: 3/1e6, output: 15/1e6, cacheRead: 0.30/1e6, cacheCreation: 3.75/1e6 },
  'claude-haiku-3-5':         { input: 0.80/1e6, output: 4/1e6, cacheRead: 0.08/1e6, cacheCreation: 1/1e6 },
  'claude-opus-4-20250514':   { input: 15/1e6, output: 75/1e6, cacheRead: 1.50/1e6, cacheCreation: 18.75/1e6 },
  'default':                  { input: 3/1e6, output: 15/1e6, cacheRead: 0.30/1e6, cacheCreation: 3.75/1e6 },
}

function computeCost(call: LLMCallRecord, model: string): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING['default']
  return (
    call.inputTokens * p.input +
    call.outputTokens * p.output +
    call.cacheReadTokens * p.cacheRead +
    call.cacheCreationTokens * p.cacheCreation
  )
}

// 校准: 在 onNodeEnd 时，对比 per-call 总和 vs SDK total
function calibrateCosts(calls: LLMCallRecord[], sdkTotalCost: number): void {
  const estimated = calls.reduce((sum, c) => sum + computeCost(c, c.model ?? 'default'), 0)
  if (estimated === 0 || sdkTotalCost === 0) return
  const ratio = sdkTotalCost / estimated
  // 偏差 < 10% 不调整
  if (Math.abs(ratio - 1.0) < 0.1) return
  // 按比例调整所有 calls 的 cost
  for (const call of calls) {
    call.costUsd = computeCost(call, call.model ?? 'default') * ratio
  }
}
```

### PrivacyFilter 完整正则模式（12 种）

```typescript
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'aws_access_key',    regex: /AKIA[0-9A-Z]{16}/g,                       replacement: '[AWS_KEY_REDACTED]' },
  { name: 'aws_secret_key',    regex: /(?<=aws_secret_access_key[=: ]+)[A-Za-z0-9/+=]{40}/g, replacement: '[AWS_SECRET_REDACTED]' },
  { name: 'openai_key',        regex: /sk-[a-zA-Z0-9]{20,}/g,                    replacement: '[OPENAI_KEY_REDACTED]' },
  { name: 'anthropic_key',     regex: /sk-ant-[a-zA-Z0-9\-]{20,}/g,              replacement: '[ANTHROPIC_KEY_REDACTED]' },
  { name: 'github_pat',        regex: /ghp_[0-9a-zA-Z]{36}/g,                    replacement: '[GITHUB_PAT_REDACTED]' },
  { name: 'github_oauth',      regex: /gho_[0-9a-zA-Z]{36}/g,                    replacement: '[GITHUB_OAUTH_REDACTED]' },
  { name: 'slack_token',       regex: /xox[bpas]-[0-9a-zA-Z\-]{10,}/g,           replacement: '[SLACK_TOKEN_REDACTED]' },
  { name: 'stripe_key',        regex: /sk_(live|test)_[0-9a-zA-Z]{20,}/g,        replacement: '[STRIPE_KEY_REDACTED]' },
  { name: 'bearer_token',      regex: /Bearer [A-Za-z0-9\-._~+/]+=*/g,           replacement: 'Bearer [TOKEN_REDACTED]' },
  { name: 'jwt',               regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[JWT_REDACTED]' },
  { name: 'private_key',       regex: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
  { name: 'connection_string', regex: /(mysql|postgres|postgresql|mongodb|redis|amqp):\/\/[^\s"']+/g, replacement: '$1://[CONN_STRING_REDACTED]' },
]
```

### 铁律：可观测性不阻塞执行

```typescript
// 在 execution.ts buildCallbacks() 中:
onAgentEvent: (nodeId, event) => {
  // SSE 实时推送（现有逻辑不变）
  this.sse.emit(this.workspaceId, { event: "agent_event", data: { ... } })
  
  // 可观测性持久化（新增，完全隔离）
  if (getFlag('agent_events_persist')) {
    try {
      this.observability.bufferEvent(nodeExecId, this.privacyFilter.filterEvent(event), meta)
    } catch {
      // 静默忽略——可观测性失败不影响执行
    }
  }
}
```

### SSE 事件处理策略

- **复用** workspace-scoped EventSource（不新增 connection）
- 客户端 100ms 批量 flush（50 chunks/sec → 10 updates/sec）
- SILENT_EVENTS 新增 `llm_call`
- SSE 断连恢复：ring buffer 保留最近 500 条事件，重连后 `getMissedEvents()` 补发

---

## 数据模型

### agent_events 表

```sql
CREATE TABLE IF NOT EXISTS agent_events (
  node_execution_id TEXT NOT NULL,
  event_order       INTEGER NOT NULL,
  turn_index        INTEGER NOT NULL,
  event_type        TEXT NOT NULL,
  timestamp         INTEGER NOT NULL,
  -- Content fields (经过 PrivacyFilter 截断)
  content           TEXT,
  content_length    INTEGER DEFAULT 0,
  -- Tool fields
  tool_call_id      TEXT,
  tool_name         TEXT,
  tool_input        TEXT,  -- JSON
  tool_result       TEXT,
  tool_is_error     INTEGER DEFAULT 0,
  tool_duration_ms  INTEGER,
  -- Status/error fields
  status_value      TEXT,
  error_code        TEXT,
  error_message     TEXT,
  PRIMARY KEY (node_execution_id, event_order)
);

CREATE INDEX idx_agent_events_node ON agent_events(node_execution_id);
CREATE INDEX idx_agent_events_turn ON agent_events(node_execution_id, turn_index);
```

### llm_calls 表

```sql
CREATE TABLE IF NOT EXISTS llm_calls (
  id                    TEXT PRIMARY KEY,
  node_execution_id     TEXT NOT NULL,
  execution_id          TEXT NOT NULL,
  turn_index            INTEGER NOT NULL,
  call_index            INTEGER NOT NULL,
  message_id            TEXT,
  model                 TEXT,
  stop_reason           TEXT,  -- end_turn/tool_use/max_tokens
  timestamp             INTEGER NOT NULL,
  duration_ms           INTEGER NOT NULL,
  ttft_ms               INTEGER,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL,
  -- Attribution (冗余存储，避免 JOIN 提高分析查询性能)
  org                   TEXT,
  workspace_id          TEXT,
  workflow_ref          TEXT,
  node_id               TEXT,
  session_id            TEXT,
  instance_id           TEXT,
  FOREIGN KEY (node_execution_id) REFERENCES node_executions(id)
);

CREATE INDEX idx_llm_calls_node ON llm_calls(node_execution_id);
CREATE INDEX idx_llm_calls_execution ON llm_calls(execution_id);
CREATE INDEX idx_llm_calls_timestamp ON llm_calls(timestamp);
```

> **冗余字段说明**: llm_calls 中的 org/workspace_id/workflow_ref/node_id 可通过 JOIN 获取，但冗余存储使分析查询（如 "按 workflow 聚合成本"）避免 3 表 JOIN，查询性能从 ~50ms 降到 ~5ms。

### executions 表新增列

```sql
ALTER TABLE executions ADD COLUMN instance_id TEXT;
-- 格式: inst-{port}-{branch}，如 inst-3001-main
```

### 双存储架构说明

`agent_events` 和 `llm_calls` 记录不同粒度的数据，服务不同查询场景：

| | agent_events | llm_calls |
|---|---|---|
| **本质** | 事件时间序列 | 结构化聚合记录 |
| **粒度** | 每个 event（thinking chunk, tool call, text delta） | 每次 LLM API 调用（message_start→stop 周期） |
| **行数** | 多（1 agent node ≈ 50-200 行） | 少（1 agent node ≈ 3-15 行） |
| **服务场景** | Timeline UI 渲染（按时间顺序展示推理过程） | 分析查询（成本统计、延迟分布、cache hit rate） |
| **包含内容** | thinking 文本、tool 参数/结果、text 输出 | 只有 token 数、延迟、成本（不含文本内容） |
| **查询模式** | `WHERE node_execution_id = ? ORDER BY event_order` | `WHERE execution_id = ? GROUP BY model` |
| **消费者** | Agent Timeline 组件 | Cost Panel、Analytics API、SuggestionEngine |

```
数据流:
  Provider stream
    ├─ yield llm_call_start → agent_events (事件流的一部分)
    ├─ yield thinking/tool/text → agent_events
    └─ yield llm_call_end → agent_events + LLMCallTracker 聚合 → llm_calls (一行)
```

两者通过 `turn_index` + `node_execution_id` 关联。一致性验证：`llm_calls` 的 `input_tokens` 总和应与 `node_token_usages` 偏差 < 10%。

### 数据保留策略

| 数据 | 保留期 | 过期处理 |
|------|--------|---------|
| agent_events content | 30 天 | 截断为 50 字符摘要 |
| agent_events 行 | 90 天 | 删除 |
| llm_calls | 365 天 | 删除 |
| executions | 永久 | 不删除 |

### 数据量估算（修正版）

**单条 event 大小**: ~450 bytes（含 SQLite row overhead）

| 场景 | events/exec | events/day | 日增长 | 30天(无清理) | 30天(清理后) |
|------|-----------|-----------|--------|------------|------------|
| 每天 100 executions (中度) | 500 | 50,000 | ~22 MB | ~660 MB | ~200 MB |
| 每天 50 executions (轻度) | 500 | 25,000 | ~11 MB | ~330 MB | ~100 MB |
| 每天 200 executions (重度) | 500 | 100,000 | ~44 MB | ~1.3 GB | ~400 MB |

> 计算依据: 10 节点 workflow 中约 3-5 个是 agent 节点，每个 agent 节点 3-8 turns × 5-15 events/turn ≈ 50 events。清理后 content 截断为 50 字符摘要（从 ~250 bytes 降到 ~50 bytes）。

**稳态 DB 大小**: 中度使用约 290 MB。SQLite 在 1 GB 以下性能良好，无需切换数据库。

### PrivacyFilter

- thinking/text content: 截断到 500 字符
- tool_result: 截断到 2000 字符
- tool_input JSON: 截断到 2000 字符
- Secret 自动脱敏: AWS keys, OpenAI keys, Anthropic keys, GitHub PATs, Bearer tokens, JWTs, 私钥, 连接字符串

### 数据迁移策略

- Phase 1 上线后，新执行的 agent events 写入 SQLite
- 旧执行的 agent events 仍从 JSONL 读取（不回填）
- API 的 `source` 字段（"sqlite" / "jsonl"）让前端知道数据来源
- 90 天后 JSONL fallback 可移除（所有旧数据已过期）

---

## Provider 层可观测性

### LLMCallTracker

在 `packages/providers/src/llm-call-tracker.ts` 新增（~80 行），追踪每个 `message_start → message_stop` 周期：

```typescript
class LLMCallTracker {
  onMessageStart(messageId, usage?): void  // 记录 start time + input tokens
  onTextDelta(): void                       // 标记 first token
  onThinkingDelta(): void                   // 标记 first token
  onMessageDelta(outputTokens?, stopReason?): void
  onMessageStop(): LLMCallState | null     // 计算 duration + ttft
  getAllCalls(): LLMCallState[]
}
```

### MessageChunk 类型扩展

```typescript
// 新增 2 个 variant:
| { type: 'llm_call_start'; messageId: string; timestamp: number; model?: string }
| { type: 'llm_call_end'; messageId: string; timestamp: number; durationMs: number;
    ttftMs?: number; stopReason: string; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheCreationTokens: number }
```

### 成本归因模型

| 层级 | 精度 | 来源 |
|------|------|------|
| Execution 级 | 100% | SDK result event 的 total_cost_usd |
| Node 级 | 100% | AgentRunResult.tokens + modelUsages |
| Turn/Call 级 | ~95% | message_start + message_delta per-call usage + 校准 |

校准机制: per-call 估算与 SDK total 对比，偏差 >10% 时按比例调整。

### MODEL_PRICING 配置

```typescript
const MODEL_PRICING = {
  'claude-sonnet-4-20250514': { input: 3/1e6, output: 15/1e6, cacheRead: 0.30/1e6, cacheCreation: 3.75/1e6 },
  'claude-haiku-3-5':         { input: 0.80/1e6, output: 4/1e6, cacheRead: 0.08/1e6, cacheCreation: 1/1e6 },
  'claude-opus-4-20250514':   { input: 15/1e6, output: 75/1e6, cacheRead: 1.50/1e6, cacheCreation: 18.75/1e6 },
}
```

---

## UI/UX 设计

### 设计语言

**技术栈:** Next.js + Tailwind CSS 4.2 + shadcn/ui + Recharts (已有) + cmdk (已有)

### 统一色值定义

所有颜色使用现有 Tailwind 类名，与 `execution-node.tsx` 中已有的 `statusConfig` 保持一致。

**状态色:**

```typescript
export const STATUS_COLORS = {
  pending:   { text: 'text-blue-600',     bg: 'bg-blue-50',     dot: '#2563eb' },
  running:   { text: 'text-amber-600',    bg: 'bg-amber-50',    dot: '#d97706' },
  completed: { text: 'text-emerald-600',  bg: 'bg-emerald-50',  dot: '#059669' },
  failed:    { text: 'text-red-600',      bg: 'bg-red-50',      dot: '#dc2626' },
  cancelled: { text: 'text-gray-600',     bg: 'bg-gray-50',     dot: '#4b5563' },
  paused:    { text: 'text-violet-600',   bg: 'bg-violet-50',   dot: '#7c3aed' },
  skipped:   { text: 'text-gray-400',     bg: 'bg-gray-50',     dot: '#9ca3af' },
  rejected:  { text: 'text-orange-600',   bg: 'bg-orange-50',   dot: '#ea580c' },
} as const
```

**节点类型色:**

```typescript
export const NODE_TYPE_COLORS = {
  agent:     { text: 'text-violet-600',  bg: 'bg-violet-500/10',  dot: '#8b5cf6', icon: 'Brain' },
  bash:      { text: 'text-blue-600',    bg: 'bg-blue-500/10',    dot: '#3b82f6', icon: 'Terminal' },
  python:    { text: 'text-teal-600',    bg: 'bg-teal-500/10',    dot: '#14b8a6', icon: 'Code' },
  condition: { text: 'text-amber-600',   bg: 'bg-amber-500/10',   dot: '#f59e0b', icon: 'GitBranch' },
  approval:  { text: 'text-rose-600',    bg: 'bg-rose-500/10',    dot: '#f43f5e', icon: 'ShieldCheck' },
  loop:      { text: 'text-sky-600',     bg: 'bg-sky-500/10',     dot: '#0ea5e9', icon: 'Repeat' },
} as const
```

**Agent 子事件色 (Timeline 内):**

```typescript
export const AGENT_EVENT_COLORS = {
  thinking: { text: 'text-violet-500',  bg: 'bg-violet-500/5',  dot: '#8b5cf6' },
  tool:     { text: 'text-amber-500',   bg: 'bg-amber-500/5',   dot: '#f59e0b' },
  text:     { text: 'text-blue-500',    bg: 'bg-blue-500/5',    dot: '#3b82f6' },
  error:    { text: 'text-red-500',     bg: 'bg-red-500/5',     dot: '#ef4444' },
  status:   { text: 'text-gray-500',    bg: 'bg-gray-500/5',    dot: '#6b7280' },
} as const
```

**图表色板 (6 色, 色盲友好):**

```typescript
export const CHART_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4']
export const CHART_PALETTE_DARK = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee']
```

**Health Grade 色:**

```typescript
export const GRADE_COLORS = {
  A: { text: 'text-emerald-600', dot: '#10b981' },
  B: { text: 'text-blue-600',    dot: '#3b82f6' },
  C: { text: 'text-amber-600',   dot: '#f59e0b' },
  D: { text: 'text-orange-600',  dot: '#f97316' },
  F: { text: 'text-red-600',     dot: '#ef4444' },
} as const
```

### 核心组件设计

#### 1. Agent Timeline（Turn-Centric Narrative）

```
┌─ Agent Timeline ──────────────────────────────────────────┐
│  ┌─ Summary Bar ────────────────────────────────────────┐ │
│  │ 4 turns · 12.3s · ↑45.2K ↓8.1K · $0.24             │ │
│  │ ████░░░░██████░░░░░░████████░░░░██████░░░░░░░░░░░░░ │ │
│  │ T1(2.1s) T2(4.5s)    T3(3.2s)  T4(2.5s)            │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Turn 1 ────────────────────────────────────────────┐ │
│  │ 🧠 思考 (1.2s, 2.1K tokens)            [展开]       │ │
│  │ 🔧 read_file("src/utils.ts")           0.8s         │ │
│  │ 🔧 terminal("git log --oneline -5")    0.3s         │ │
│  │ 💬 "我发现最近的 commit a1b2c3d 修改了..."          │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Turn 2 (live, streaming) ──────────────────────────┐ │
│  │ 🧠 思考中... ██████░░░░░░░░                         │ │
│  └─────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

**实时更新模型:**
- 已完成区域 (frozen): 用户可自由滚动、展开/折叠，高度固定不重排
- 活跃区域 (live): 自动滚动到底部，新 event slide-in-up，100ms 脉冲批量追加
- 等待区域 (pending): 不显示

### Agent Timeline 组件分解

不是一个 200 行的大组件，而是拆分为 8 个子组件：

```
components/agent-timeline/
├── agent-timeline.tsx          ← 容器，管理滚动、状态
├── summary-bar.tsx             ← 顶部统计条
├── turn-section.tsx            ← 单个 Turn（折叠/展开）
├── thinking-block.tsx          ← thinking 内容渲染
├── tool-call-row.tsx           ← 单个 tool call 行
├── text-output-block.tsx       ← text 输出渲染
├── new-events-indicator.tsx    ← "↓ N 个新事件" 浮动按钮
└── timeline-skeleton.tsx       ← 加载骨架屏
```

**容器组件 Props 和状态:**
```typescript
// agent-timeline.tsx
interface AgentTimelineProps {
  executionId: string
  nodeId: string
  isRunning: boolean  // 节点是否正在执行
}

// 容器内部状态
const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set())
const [isNearBottom, setIsNearBottom] = useState(true)  // IntersectionObserver 检测
const [missedCount, setMissedCount] = useState(0)       // 用户滚动离开底部后的新事件数
```

**子组件 Props:**
```typescript
interface SummaryBarProps {
  turnCount: number
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  turnDurations: { turnIndex: number; durationMs: number }[]
}

interface TurnSectionProps {
  turn: TurnGroup
  isExpanded: boolean
  isLive: boolean         // 当前 turn 是否正在 streaming
  onToggle: () => void
}

interface ToolCallRowProps {
  toolName: string
  durationMs: number
  isError: boolean
  inputPreview: string    // 截断的 tool_input
  resultPreview: string   // 截断的 tool_result
}

interface ThinkingBlockProps {
  content: string
  isExpanded: boolean
  isStreaming: boolean    // 是否正在逐字追加
}
```

**shadcn/ui 原语映射:**
- TurnSection 折叠: 用 `Collapsible`（`@radix-ui/react-collapsible`，shadcn 有）
- ToolCallRow 状态: 用 `Badge`（`isError ? variant="destructive" : variant="secondary"`）
- ThinkingBlock 代码显示: 用 `<pre>` + `font-mono text-xs`，不用 CodeBlock 组件
- NewEventsIndicator: 用 `Button` + `size="sm"` + `variant="outline"`

#### 2. 成本分解瀑布图

SVG 纯手绘，每个节点从左到右累加。Bar 颜色按节点类型。连接线展示阶梯增长。

#### 3. Workflow 健康雷达图

5 维: 成功率(40%)、速度稳定性(20%)、成本效率(15%)、Token效率(15%)、可靠性(10%)。
支持叠加对比: 当前 vs 历史平均。SVG polygon + 动画展开。

#### 4. Agent 行为热力图

CSS Grid，X=日期，Y=工具名，颜色深度=调用次数。入场动画：波浪扩散效果。

#### 5. LLM 调用桑基图

SVG + d3-sankey（Phase 3 新增依赖，~8KB）。三层: 节点→模型→stop_reason。

#### 6. 执行时间分布直方图

Recharts BarChart + Freedman-Diaconis 分箱 + P50/P90/P99 标注线。

### 交互规范

| 交互 | 时长 | 缓动 |
|------|------|------|
| Panel slide-in | 250ms | ease-out |
| Panel slide-out | 200ms | ease-in |
| Tab 切换 crossfade | 150ms | ease |
| Chart 入场 | 400ms | ease-out-expo |
| 节点状态变化 | 300ms | spring |
| 新 event slide-in | 200ms | ease-out |

### Node Detail Panel（WorkflowDetailPanel）

> **重要**: 项目中实际的详情面板是 `WorkflowDetailPanel`（`components/workspace/workflow-detail-panel.tsx`），不是 `ExecutionPanel`（未使用）。
> 点击 DAG 节点的"详细"按钮 → `callbacks.onDetail(nodeId)` → 创建 workspace tab（type: "detail"）→ 渲染 `WorkflowDetailPanel`。
> 当前面板右侧有: Operations 按钮 + ExecutionLogViewer + Step details。3 秒轮询刷新。
> 新增的 "追踪" 和 "成本" tab 插入到现有 tab 结构中。

6 种执行器类型的差异化 tab（通过 `executorType` 字段条件渲染）:
- **Agent**: 追踪 + 成本 + 历史
- **Bash**: 输出(stdout/stderr) + 环境(vars/git) + 历史
- **Python**: 输出 + 脚本 + traceback + 历史
- **Condition**: 表达式 + cases + 变量快照 + 历史
- **Approval**: 决策 + 选项 + auto-answer + 历史
- **Loop**: 迭代列表 + 退出条件 + 历史

### Dashboard 重设计

```
┌─ Dashboard ──────────────────────────────────────────────┐
│  ┌─ Hero Metrics ──────────────────────────────────────┐ │
│  │ 47 executions │ 85% success │ $22.56 cost │ 2m25s  │ │
│  │   +12% ↑        +3% ↑        +18% ↑       -5% ↓   │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─ Running Queue ─┐  ┌─ Workflow Health Cards ───────┐ │
│  │ deploy-staging ▶│  │ deploy-staging: B (82)        │ │
│  │ code-review  ▶ │  │ code-review:    A (91)        │ │
│  └────────────────┘  │ build-and-test: C (73)        │ │
│                       └────────────────────────────────┘ │
│  ┌─ Cost Trend (30d) ───────────────────────────────┐   │
│  │  $15 ┤       ╭─╮                                  │   │
│  │  $12 ┤  ╭─╮ ╭╯ ╰╮    ╭──╮                        │   │
│  │   $9 ┤─╯ ╰─╯   ╰──╮╯  ╰─╮                       │   │
│  └────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

### Command Palette (⌘K)

使用已有的 `cmdk` 库。搜索: workflows + executions + actions。
支持前缀过滤: `> ` actions, `# ` workflows, `@ ` executions。

---

## API 设计

### 新增 API 端点

| 端点 | 方法 | 描述 | 缓存 |
|------|------|------|------|
| `/api/executions/:id/traces` | GET | 按 turn 分组的 agent 追踪 | no-cache |
| `/api/executions/:id/llm-calls` | GET | LLM 调用明细 + 聚合 | no-cache |
| `/api/workspaces/:id/analytics` | GET | Workspace 级总览 | 60s |
| `/api/workspaces/:id/analytics/workflows/:ref` | GET | 单 workflow 分析 | 60s |
| `/api/workspaces/:id/analytics/cost` | GET | 跨 workflow 成本分析 | 60s |
| `/api/workspaces/:id/suggestions` | GET | 优化建议列表 | 300s |
| `/api/workspaces/:id/suggestions/:id/apply` | POST | 应用建议 | - |
| `/api/runtime/metrics` | GET | 运行时性能指标 | no-cache |
| `/api/runtime/errors` | GET | 错误聚合 | 30s |
| `/api/observability/status` | GET | 可观测性降级状态 | no-cache |
| `/api/feature-flags` | GET | Feature flag 状态 | 60s |

### 修改的现有 API

| 端点 | 变更 |
|------|------|
| `GET /:executionId/agent-events` | 优先查 SQLite（source:"sqlite"），fallback JSONL（source:"jsonl"） |

### 响应格式标准

```json
{
  "data": [...],
  "pagination": { "total": 47, "limit": 50, "offset": 0, "hasMore": false },
  "aggregates": { ... },
  "_degraded": false,
  "_message": null
}
```

### API 扩展: 执行器类型暴露（Phase 1 前置条件）

> **问题**: 当前 `ExecutionNodeData.nodeType` 只有 `"normal" | "fork"`（DAG 结构类型），执行器类型（agent/bash/python/condition/approval/loop）从未暴露到前端。但 spec 中大量 UI 逻辑依赖执行器类型（追踪 tab 只对 agent 显示、成本行只对 agent 显示、Node Detail Panel 按类型切换 tab）。

**修复方案**:

1. **后端**: `GET /api/workspaces/:id/executions/tree` 的响应中，每个节点新增 `executorType` 字段
   - 数据来源: `node_executions.node_type` 列（已有），或从 workflow YAML 解析
   - 对于尚未执行的节点，从 YAML 的 `type` 字段获取

2. **前端类型扩展**: `packages/web-app/lib/types.ts`
   ```typescript
   // ExecutionNodeData 新增字段
   executorType?: 'agent' | 'bash' | 'python' | 'condition' | 'approval' | 'loop'
   ```

3. **SSE 事件**: `node_start` 事件中携带 `executorType`（节点开始执行时从 DB 获取）

4. **前端消费**:
   ```typescript
   // execution-node.tsx 中条件渲染成本行
   {data.executorType === 'agent' && data.costUsd != null && <CostLine cost={data.costUsd} ... />}
   
   // WorkflowDetailPanel 中条件渲染追踪 tab
   {selectedNode?.executorType === 'agent' && <TabsTrigger value="traces">追踪</TabsTrigger>}
   ```

**影响范围**: 
- 后端: execution tree API 的 SQL query 增加 `ne.node_type as executorType`
- 前端: `types.ts` 增加字段、`useExecutionTree` 的 mapper 增加映射、`execution-node.tsx` 增加条件渲染

---

## 前端数据流架构

> **重要**: 项目不使用 SWR/TanStack Query。数据获取模式是 `useState + useEffect + fetch()` + EventSource 实时更新。所有 hooks 必须遵循现有模式。

### 现有数据获取模式（必须遵循）

```typescript
// 模式 A: 初始加载 (fetch + useState)
function useSomething(id: string) {
  const [data, setData] = useState<Something | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getServerUrl()}/api/something/${id}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  return { data, loading, error }
}

// 模式 B: SSE 实时更新 (EventSource, 在 useExecutionTree 中)
useEffect(() => {
  const es = new EventSource(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`)
  es.addEventListener("node_end", (e) => {
    const data = JSON.parse(e.data)
    setTreeNodes(prev => prev.map(n => n.id === data.nodeId ? { ...n, ...data } : n))
  })
  return () => es.close()
}, [workspaceId])

// 模式 C: 轮询 (WorkflowDetailPanel, ExecutionLogViewer)
const interval = isRunning
  ? setInterval(fetchStatus, 3000)   // 运行中 3s
  : setInterval(fetchStatus, 10000)  // 空闲 10s
```

### 数据策略矩阵

| 数据类型 | 变化频率 | 策略 | 所在 hook |
|---------|---------|------|----------|
| Execution 列表 | 低 | fetch + useState | 现有 `fetchExecutionTree()` |
| Agent events (实时) | 极高 | SSE 事件 (EventSource) | 扩展现有 `useExecutionTree` |
| Agent events (历史) | 无 | fetch + useState | 新 `useAgentTraces()` |
| LLM calls (历史) | 无 | fetch + useState | 新 `useLLMCalls()` |
| Workflow analytics | 低 | fetch + useState + 轮询 | 新 `useWorkflowAnalytics()` |
| Feature flags | 极低 | fetch + Context | 新 `useFeatureFlags()` |

### SSE 架构（现有，需修复）

> **⚠ 架构问题**: 项目中存在 **两个独立的 SSEService 实例**，这是一个 bug：
> - `execution.ts` 第 12 行: `const sseService = new SSEService()` — 模块级私有实例
> - `index.ts` 第 36 行: `const sse = new SSEService()` — 全局实例
> 
> 执行事件通过 execution.ts 的私有实例 emit，只在 `/executions/events` endpoint 可达。
> 全局实例用于 `/events` endpoint（chat/workspace 事件）。

**修复方案**: Phase 1 中将 execution.ts 的 `sseService` 改为接收全局实例（通过依赖注入或模块导入），统一为一个 SSEService。

**agent_event 的路由**:
- 当前 `agent_event` 通过 `execution.ts` 的 `sseService.emit()` 推送
- 前端在 `useExecutionTree` 的 EventSource (`/executions/events`) 中接收
- Phase 1 统一 SSEService 后，agent_event 仍然通过 `/executions/events` 推送

### 新增 Hooks 清单

```typescript
// hooks/use-agent-traces.ts
function useAgentTraces(executionId: string, nodeId?: string) {
  // useState + fetch + useEffect
  // GET /api/executions/:id/traces?nodeId=...
  // 返回 { turns: TurnGroup[], loading: boolean, error: Error | null, isDegraded: boolean }
}

// hooks/use-llm-calls.ts
function useLLMCalls(executionId: string, nodeId?: string) {
  // useState + fetch + useEffect
  // GET /api/executions/:id/llm-calls?nodeId=...
  // 返回 { calls: LLMCall[], aggregates: LLMCallAggregates, loading: boolean }
}

// hooks/use-agent-events-live.ts
function useAgentEventsLive(executionId: string, nodeId: string) {
  // 订阅 SSE agent_event，100ms 批量 flush 到本地 buffer
  // 按 turn_index 分组
  // 返回 { turns: TurnGroup[], isStreaming: boolean, missedCount: number }
}

// hooks/use-workflow-analytics.ts
function useWorkflowAnalytics(workspaceId: string, workflowRef: string, range?: string) {
  // useState + fetch + useEffect + setInterval 轮询 (60s)
  // GET /api/workspaces/:id/analytics/workflows/:ref?range=30d
  // 返回 { report: WorkflowAnalyticsReport, loading: boolean }
}

// hooks/use-feature-flags.ts + context/feature-flags-context.tsx
function useFeatureFlags() {
  // Context + useState + fetch (在 layout.tsx 中全局获取)
  // GET /api/feature-flags
  // 返回 ObservabilityFlags
}

// hooks/use-observability-status.ts
function useObservabilityStatus() {
  // useState + fetch + setInterval 轮询 (30s)
  // GET /api/observability/status
  // 返回 { degraded: boolean, message: string | null }
}
```

### AgentEventBridge 设计（SSE → 本地 buffer）

```typescript
// 在 useExecutionTree 的 EventSource handler 中新增:

es.addEventListener("agent_event", (e) => {
  const { executionId, nodeId, event } = JSON.parse(e.data)
  agentEventBufferRef.current.push({ executionId, nodeId, event, ts: Date.now() })
})

// 100ms 批量 flush (setInterval)
useEffect(() => {
  const id = setInterval(() => {
    if (agentEventBufferRef.current.length === 0) return
    const batch = agentEventBufferRef.current.splice(0)
    // 通知所有订阅了 (executionId, nodeId) 的 useAgentEventsLive hook
    for (const item of batch) {
      agentEventListeners.forEach(listener => {
        if (listener.executionId === item.executionId && listener.nodeId === item.nodeId) {
          listener.onEvents([item.event])
        }
      })
    }
  }, 100)
  return () => clearInterval(id)
}, [])
```

### 关键技术决策

- **图表**: Recharts (已有，通过 shadcn `@/components/ui/chart` wrapper) + 纯 SVG 补充
- **命令面板**: cmdk (已有)
- **动画**: CSS transitions（不引入 framer-motion）
- **状态管理**: useState + Context（不引入 zustand/SWR）
- **虚拟列表**: 不需要（Timeline 默认折叠 turn，events < 100 时不需要虚拟化）

---

## 智能建议引擎

### 核心设计哲学

每条建议必须包含: Detection（检测到什么）+ Diagnosis（说明什么）+ Prescription（怎么改）+ Impact（改后效果）

### 建议规则

| 规则 | 触发条件 | 建议 |
|------|---------|------|
| OverpoweredModel | avg output < 200 tokens, tool call ratio < 0.3 | 换 haiku |
| ThinkingOutputRatio | thinking tokens > 5x output tokens | 优化 prompt |
| RedundantCondition | 同一分支被选中 > 95% | 简化 condition |
| FlakyNode | retry rate > 30% | 改进 prompt / 添加重试 |
| OutputOverproduction | avg output > 2000 tokens, success rate > 95% | 限制 max_tokens |

---

## 验收标准

### US-1: Agent 推理链持久化

**作为** workflow 开发者，**我想** 在 agent 节点执行完成后仍能查看其完整推理链，**以便** 在输出不符合预期时回溯 thinking 过程和 tool 调用序列。

- **AC-1.1**: agent 节点执行完成后，`agent_events` 表中包含该节点的所有 thinking、tool_start、tool_input、tool_result、text_delta 事件
- **AC-1.2**: 每个 event 记录包含 `turn_index`，正确反映 LLM 调用轮次（`thinking_start` 标记新 turn 的开始）
- **AC-1.3**: thinking content 截断为 500 字符，`content_length` 记录原始长度
- **AC-1.4**: tool_result 截断为 2000 字符，包含的 API key 被脱敏为 `[REDACTED]`
- **AC-1.5**: 刷新浏览器页面后，之前完成的 agent 节点的推理链仍可查看
- **AC-1.6**: ObservabilityService 写入失败时，workflow 执行不受影响（exit code 和 status 正常）

### US-2: LLM 调用级成本追踪

**作为** 成本控制者，**我想** 看到每个 agent 节点中每次 LLM API 调用的 token 消耗和成本，**以便** 找到最贵的调用并优化。

- **AC-2.1**: `llm_calls` 表中每条记录包含 input_tokens、output_tokens、cache_read_tokens、cache_creation_tokens、duration_ms、ttft_ms
- **AC-2.2**: per-call 的 cost_usd 通过 MODEL_PRICING 计算，与 SDK result 的 total_cost_usd 偏差 < 10%
- **AC-2.3**: `GET /api/executions/:id/llm-calls` 返回该执行的所有 LLM 调用，包含 aggregates（totalCalls, totalCost, cacheHitRate）
- **AC-2.4**: stop_reason 为 `max_tokens` 的调用在 UI 中有视觉标识
- **AC-2.5**: 多 turn 的 agent 节点，每次 LLM 调用都有独立记录

### US-3: Agent Timeline 可视化

**作为** workflow 开发者，**我想** 在 DAG 中点击 agent 节点后看到按 Turn 分组的推理链可视化，**以便** 快速理解 agent 做了什么。

- **AC-3.1**: 点击 DAG 中的 agent 节点 → WorkflowDetailPanel 打开，显示 "追踪" tab（非 agent 节点不显示此 tab）
- **AC-3.2**: 追踪 tab 顶部显示 Summary Bar：turn 数、总耗时、↑input ↓output token 数、总成本
- **AC-3.3**: 每个 Turn 默认折叠为一行摘要（🧠 thinking · 🔧 toolName × N · 💬 output preview）
- **AC-3.4**: 点击 Turn 展开后显示完整的 thinking 内容、tool call 参数/结果、text output
- **AC-3.5**: tool call 显示工具名 badge、耗时、成功/失败状态
- **AC-3.6**: 执行中的 agent 节点实时更新 Timeline（新 event 在 200ms 内可见），自动滚动到底部
- **AC-3.7**: 用户手动向上滚动后停止自动滚动，底部显示 "↓ N 个新事件" 浮动按钮

### US-4: DAG 节点成本可见

**作为** workflow 开发者，**我想** 在 DAG 画布上直接看到每个 agent 节点的成本，**以便** 不需要打开详情面板就能发现成本异常。

- **AC-4.1**: 已完成的 agent 节点卡片底部显示 `💰$X.XX · N turns · N tools · Xs`
- **AC-4.2**: 执行中的 agent 节点实时更新成本（随 token 消耗增长）
- **AC-4.3**: 非 agent 节点（bash/python/condition/approval/loop）不显示成本行
- **AC-4.4**: WorkflowDetailPanel 的 "成本" tab 显示：总成本、按模型分解、per-turn token 分布
- **AC-4.5**: 成本数值使用 `tabular-nums` 字体特性，列对齐

### US-5: 隐私保护默认生效

**作为** 安全敏感用户，**我想** 确保存储在 SQLite 中的 agent 数据不包含明文密钥，**以便** 即使数据库文件泄露也不会暴露凭证。

- **AC-5.1**: 包含 `sk-ant-` 前缀的 Anthropic API key 在存储时被替换为 `[ANTHROPIC_KEY_REDACTED]`
- **AC-5.2**: 包含 `AKIA` 前缀的 AWS key 被替换为 `[AWS_KEY_REDACTED]`
- **AC-5.3**: Bearer token 被替换为 `Bearer [TOKEN_REDACTED]`
- **AC-5.4**: 所有 12 种已知密钥模式均被脱敏
- **AC-5.5**: PrivacyFilter 不影响 SSE 实时推送的内容（脱敏只发生在 SQLite 写入路径）

---

## Feature Flag 策略

### 配置文件

```yaml
# ~/.octopus/config.yaml (新增 observability section)
observability:
  # Phase 1 功能 (默认开启)
  agent_events_persist: true
  llm_calls_persist: true
  timeline_tab: true
  cost_tab: true
  dag_cost_line: true

  # Phase 2 功能 (默认关闭)
  dashboard_v2: false
  analytics_api: false
  command_palette: false

  # Phase 3 功能 (默认关闭)
  suggestions: false
  alerting: false

  # 隐私控制
  privacy:
    level: standard               # minimal | standard | full
    max_content_length: 500
    max_tool_result_length: 2000
    redact_secrets: true
```

### 代码中使用

```typescript
// server/src/config/feature-flags.ts
export function getFlag<K extends keyof ObservabilityFlags>(key: K): ObservabilityFlags[K]

// 支持环境变量覆盖: OCTOPUS_FF_DASHBOARD_V2=true
```

### 灰度策略

- Phase 1 功能: 默认开启，用户可通过 config.yaml 关闭
- Phase 2-3 功能: 默认关闭，用户手动开启或设置环境变量
- 回滚: 修改 config.yaml 后重启 server

---

## 实施路线图

### Phase 1: 数据基础设施（3 周）

**Week 1:**
- [ ] schema migration v14: agent_events + llm_calls + instance_id
- [ ] ObservabilityService (buffer/flush/turn tracking/降级)
- [ ] PrivacyFilter (内容截断 + secret 脱敏)
- [ ] LLMCallTracker (providers 包内)
- [ ] MessageChunk 类型扩展
- [ ] ErrorTracker + captureError() 统一入口
- [ ] Feature Flag 基础设施 (config/feature-flags.ts)

**Week 2:**
- [ ] AgentNodeRunner 集成 llm_call events
- [ ] execution.ts buildCallbacks() 注入 observability
- [ ] 集成测试 (mock provider → verify DB writes)
- [ ] 性能基准 (1000 events batch insert < 100ms)
- [ ] Schema migration 测试 (v13 → v14)

**Week 3:**
- [ ] GET /api/executions/:id/traces
- [ ] GET /api/executions/:id/llm-calls
- [ ] Agent Timeline UI 组件
- [ ] 成本行嵌入 DAG 节点 (💰$0.24)
- [ ] WorkflowDetailPanel "追踪" + "成本" tab（正确组件，不是 ExecutionPanel）
- [ ] SSEService 统一（execution.ts 改用全局实例）
- [ ] execution-node.tsx 条件渲染 CostLine + executorType 映射
- [ ] E2E 测试 (3 个关键路径)
- [ ] 视觉回归基线

**交付物:** 用户可以打开任何 agent 节点看到完整推理链、每次 LLM 调用的 token/cost/延迟、DAG 节点上直接显示成本。

### Phase 2: 分析与可视化（3 周）

**Week 4:** Workflow Analytics 引擎 + Dashboard 重设计
**Week 5:** Execution Explorer + 图表 (瀑布图/直方图/雷达图) + Command Palette
**Week 6:** Node Detail Panel (6 种类型) + Provider Health + Runtime Metrics

### Phase 3: 智能功能（3 周）

**Week 7:** SuggestionEngine + 5 个核心规则
**Week 8:** 告警系统 + 退化检测 + Webhook
**Week 9:** 高级图表 (热力图/气泡图/桑基图) + 建议反馈闭环

### Phase 4: 远景（按需）

- OTLP Export、跨实例聚合、Comparative Execution View、完整 SuggestionEngine (15+ 规则)、Prompt 版本管理 + A/B testing

---

## 代码改造清单

### Phase 1 精确工作量

| 类别 | 数量 | 行数 |
|------|------|------|
| 新增文件 | 15 个 | ~1450 行 |
| 修改文件 | 15 个 | ~400 行改动 |
| 新增测试 | 5 个 | ~500 行 |
| 更新测试 | 1 个 | ~20 行改动 |
| **新增依赖** | **0 个** (Phase 1-2) | - |
| 删除文件 | 0 个 | - |
| **总计** | | **~1950 行新增 + ~420 行修改** |

### 新增文件

1. `packages/providers/src/llm-call-tracker.ts` (~80 行)
2. `packages/server/src/services/observability.ts` (~350 行，含完整状态机和成本计算)
3. `packages/server/src/services/privacy-filter.ts` (~80 行，含 12 种正则)
4. `packages/server/src/services/error-tracker.ts` (~120 行)
5. `packages/server/src/config/feature-flags.ts` (~60 行)
6. `packages/server/src/routes/analytics.ts` (~80 行，Phase 1 骨架)
7. `packages/web-app/components/agent-timeline/` — 8 个子组件（见 UI/UX 章节）:
   - `agent-timeline.tsx` (容器, ~120 行)
   - `summary-bar.tsx` (~40 行)
   - `turn-section.tsx` (~60 行)
   - `thinking-block.tsx` (~30 行)
   - `tool-call-row.tsx` (~30 行)
   - `text-output-block.tsx` (~20 行)
   - `new-events-indicator.tsx` (~20 行)
   - `timeline-skeleton.tsx` (~20 行)
8. `packages/web-app/components/cost-line.tsx` (~50 行)
9. `packages/web-app/components/ui/chart-error-boundary.tsx` (~40 行)

### 修改文件

1. `packages/server/src/db/schema.ts` — 新增表 + SCHEMA_VERSION 14
2. `packages/engine/src/executors/agent-types.ts` — 新增 llm_call_start/end
3. `packages/engine/src/executors/agent-runner.ts` — 处理新 chunk types + llmCalls
4. `packages/providers/src/types.ts` — MessageChunk union 扩展
5. `packages/providers/src/claude/provider.ts` — LLMCallTracker 集成
6. `packages/server/src/services/execution.ts` — ObservabilityService 注入
7. `packages/server/src/services/sse.ts` — ring buffer + llm_call 静默
8. `packages/server/src/routes/execution.ts` — traces/llm-calls endpoints + **SSEService 统一为全局实例**
9. `packages/server/src/index.ts` — 路由挂载 + 传递全局 SSEService 给 execution routes
10. `packages/server/src/__tests__/db-schema.test.ts` — 断言更新
11. `packages/web-app/lib/types.ts` — `ExecutionNodeData` 新增 `executorType` 和 `costUsd` 字段
12. `packages/web-app/hooks/use-execution-tree.ts` — SSE handler 新增 `agent_event` 监听 + `executorType` 映射
13. `packages/web-app/components/workspace/execution-node.tsx` — 条件渲染 CostLine（仅 agent 节点）
14. `packages/web-app/components/workspace/workflow-detail-panel.tsx` — 新增 "追踪" + "成本" tab
15. `packages/web-app/lib/api-client.ts` — 新增 `fetchAgentTraces()`, `fetchLLMCalls()` 等 fetch 函数

### DAG 节点成本行的数据注入路径

```
数据流:
  Provider yield llm_call_end
    → ObservabilityService 累积 cost
    → onNodeEnd callback 时获取 result.costUsd
    → SSE emit node_end 事件，携带 { duration, tokenUsages, costUsd }
    → useExecutionTree 的 EventSource handler 更新 treeNodes
    → execution-node.tsx 接收 data.costUsd
    → 条件渲染: {data.executorType === 'agent' && <CostLine cost={data.costUsd} turns={data.turnCount} tools={data.toolCount} duration={data.duration} />}
```

**`ExecutionNodeData` 新增字段:**
```typescript
executorType?: 'agent' | 'bash' | 'python' | 'condition' | 'approval' | 'loop'
costUsd?: number
turnCount?: number
toolCount?: number
```

**`CostLine` 组件:**
```typescript
// components/cost-line.tsx
interface CostLineProps {
  costUsd: number
  turns?: number
  tools?: number
  durationMs?: number
}

export function CostLine({ costUsd, turns, tools, durationMs }: CostLineProps) {
  const parts: string[] = [`💰$${costUsd.toFixed(2)}`]
  if (turns) parts.push(`${turns} turns`)
  if (tools) parts.push(`${tools} tools`)
  if (durationMs) parts.push(`${(durationMs / 1000).toFixed(0)}s`)
  return <div className="text-xs text-muted-foreground tabular-nums">{parts.join(' · ')}</div>
}
```

---

## E2E 测试

### 技术选型

- **Playwright** (Next.js 项目事实标准)
- 测试服务器: `next start` + 独立 SQLite 测试 DB
- Mock Provider: 预录制的 MessageChunk 序列

### 关键路径 1: 执行→追踪

```typescript
// e2e/tests/execution-trace.spec.ts

test('完成的 agent 节点显示 Turn-Centric Timeline', async ({ page, db }) => {
  // Arrange: 插入已完成的 execution + agent_events (2 turns)
  insertCompletedExecution(db, workspaceId, execId, {
    nodes: [{ id: 'analyze', type: 'agent', status: 'completed', events: [
      { type: 'thinking_start', turn: 1 },
      { type: 'thinking', content: 'Let me analyze...', turn: 1 },
      { type: 'tool_start', toolName: 'Read', turn: 1 },
      { type: 'tool_result', toolName: 'Read', content: 'file content', turn: 1 },
      { type: 'text_delta', content: 'Found the issue.', turn: 1 },
      { type: 'thinking_start', turn: 2 },
      { type: 'tool_start', toolName: 'Edit', turn: 2 },
      { type: 'tool_result', toolName: 'Edit', content: 'Applied', turn: 2 },
      { type: 'text_delta', content: 'Fixed.', turn: 2 },
    ]}],
  })

  // Act
  await page.goto(`/workspaces/${workspaceId}?execution=${execId}`)
  await page.click('[data-node-id="analyze"]')
  await page.getByRole('tab', { name: '追踪' }).click()

  // Assert
  await expect(page.getByText('2 turns')).toBeVisible()
  const turnSections = page.locator('[data-turn-index]')
  await expect(turnSections).toHaveCount(2)

  // 展开 Turn 1 验证内容
  await turnSections.nth(0).click()
  await expect(page.getByText('Let me analyze')).toBeVisible()
  await expect(page.locator('[data-tool-name="Read"]')).toBeVisible()
})

test('bash 节点不显示追踪 tab', async ({ page, db }) => {
  insertCompletedExecution(db, workspaceId, execId, {
    nodes: [{ id: 'build', type: 'bash', status: 'completed' }],
  })
  await page.goto(`/workspaces/${workspaceId}?execution=${execId}`)
  await page.click('[data-node-id="build"]')
  await expect(page.getByRole('tab', { name: '追踪' })).not.toBeVisible()
})
```

### 关键路径 2: Dashboard 概览

```typescript
// e2e/tests/dashboard.spec.ts

test('Hero Metrics 显示正确的统计数据', async ({ page, db }) => {
  insertExecutionBatch(db, { completed: 35, failed: 5, running: 2, totalCost: 22.56 })
  await page.goto('/')
  await expect(page.getByText('42')).toBeVisible()       // 总执行数
  await expect(page.getByText('87.5%')).toBeVisible()    // 成功率
  await expect(page.getByText('$22.56')).toBeVisible()   // 总成本
})

test('空状态显示引导信息', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('运行你的第一个工作流')).toBeVisible()
})
```

### 关键路径 3: LLM 调用成本明细

```typescript
// e2e/tests/llm-calls.spec.ts

test('成本 tab 显示 per-model 分解和 per-turn 分布', async ({ page, db }) => {
  insertCompletedExecution(db, workspaceId, execId, {
    nodes: [{ id: 'analyze', type: 'agent', status: 'completed',
      llmCalls: [
        { turn: 1, model: 'claude-sonnet-4-20250514', input: 12500, output: 2300, cacheRead: 8000, cost: 0.067 },
        { turn: 2, model: 'claude-sonnet-4-20250514', input: 15100, output: 1800, cacheRead: 14000, cost: 0.041 },
      ],
    }],
  })
  await page.goto(`/workspaces/${workspaceId}?execution=${execId}`)
  await page.click('[data-node-id="analyze"]')
  await page.getByRole('tab', { name: '成本' }).click()
  await expect(page.getByText('$0.20')).toBeVisible()
  await expect(page.getByText(/76%/)).toBeVisible()  // cache hit rate
})

test('max_tokens 截断的调用有视觉标识', async ({ page, db }) => {
  // ... 插入 stopReason: 'max_tokens' 的 llm_call
  await expect(page.locator('[data-stop-reason="max_tokens"]')).toBeVisible()
})
```

---

## 视觉回归测试

### 工具

Playwright 内置的 `toHaveScreenshot()` — 零额外依赖。

### 截图基线清单 (Phase 1)

| 组件 | 状态 | 截图文件名 |
|------|------|-----------|
| Agent Timeline | 3 turns 折叠态 | `timeline-collapsed-{theme}.png` |
| Agent Timeline | Turn 1 展开态 | `timeline-expanded-{theme}.png` |
| Agent Timeline | streaming 态 (mock) | `timeline-streaming-{theme}.png` |
| Cost Panel | 有数据 (3 calls) | `cost-panel-data-{theme}.png` |
| Cost Panel | 空状态 | `cost-panel-empty-{theme}.png` |
| DAG 节点 (agent) | 已完成 + 成本行 | `dag-node-agent-completed-{theme}.png` |
| Dashboard | 有数据的完整页面 | `dashboard-populated-{theme}.png` |
| Dashboard | 空状态 | `dashboard-empty-{theme}.png` |

### 断点测试

```typescript
const VIEWPORTS = [
  { name: 'sm', width: 1280, height: 800 },
  { name: 'md', width: 1440, height: 900 },
  { name: 'lg', width: 1680, height: 1050 },
  { name: 'xl', width: 1920, height: 1080 },
]

for (const viewport of VIEWPORTS) {
  test(`Dashboard @${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot(`dashboard-${viewport.name}.png`, {
      maxDiffPixelRatio: 0.01  // 允许 1% 像素差异
    })
  })
}
```

### 基线更新策略

- 首次运行: `npx playwright test --update-snapshots` 生成基线
- UI 变更时: 人工审核后 `--update-snapshots` 更新基线
- CI 中: 只对比不更新，失败则 PR check 红灯
- 允许 diff 阈值: `maxDiffPixelRatio: 0.01`

---

## CI/CD 集成

### Pipeline 阶段

```
PR Check (每次 push)          Merge to Main            Nightly (每天 02:00)
┌──────────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ ✓ TypeScript 类型检查 │    │ ✓ 全量单元测试    │    │ ✓ 全量 E2E       │
│ ✓ ESLint             │    │ ✓ 性能基准测试    │    │ ✓ 视觉回归测试   │
│ ✓ 单元测试 (vitest)  │    │ ✓ E2E (smoke)    │    │ ✓ 性能回归测试   │
│ ✓ 构建验证           │    │ ✓ Schema 迁移测试 │    │ ✓ 数据量压力测试 │
│ ✓ 性能基准 (快速)    │    │                  │    │                  │
└──────────────────────┘    └──────────────────┘    └──────────────────┘
     ~3 min                      ~8 min                   ~25 min
```

### 性能阈值 (PR check 硬卡)

```json
{
  "bufferEvent_p99_ms": 0.05,
  "flush_batch_50_ms": 15,
  "traces_query_100_ms": 5,
  "traces_query_1000_ms": 20,
  "analytics_query_30d_ms": 50,
  "memory_buffer_10k_mb": 5
}
```

### Schema 迁移测试

```typescript
test('v13 → v14 migration preserves existing data', () => {
  const db = createV13Db()
  db.prepare('INSERT INTO executions ...').run(...)
  applySchema(db)  // v13 → v14
  expect(db.prepare('SELECT COUNT(*) FROM executions').get()).toEqual({ count: 1 })
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='agent_events'").get()).toBeDefined()
  const cols = db.prepare("PRAGMA table_info(executions)").all()
  expect(cols.map(c => c.name)).toContain('instance_id')
})
```

---

## 性能基准

### 验证标准

| 指标 | 目标值 | 测量方法 |
|------|--------|---------|
| bufferEvent() 调用耗时 | < 0.05ms | perf.now() |
| flush 50 events batch | < 15ms | perf.now() 包裹事务 |
| GET /traces (100 events) | < 5ms | API 层计时 |
| GET /traces (1000 events) | < 20ms | API 层计时 |
| GET /analytics (30d) | < 50ms | API 层计时 |
| SSE event→pixel 延迟 | < 200ms | emit → rAF |
| ObservabilityService buffer | < 5MB | buffer Map 估算 |
| 进程 RSS 增长 (1h) | < 20MB | process.memoryUsage() |
| Agent Timeline 帧率 | > 30fps | Chrome DevTools |

---

## 回退方案

### 场景 1: agent_events 写入导致性能问题

**触发:** bufferEvent P99 > 1ms 或 SQLite 慢查询 > 100ms

**回退:**
1. 修改 `~/.octopus/config.yaml`: `agent_events_persist: false`
2. 重启 server
3. 效果: SSE 推送不受影响，Timeline 实时模式仍工作，但数据不持久化
4. 耗时: < 30 秒

### 场景 2: 新版 Dashboard 有 bug

**回退:** `dashboard_v2: false` → 重启 → 回退到旧版

### 场景 3: Schema migration 失败

**回退 SQL:**
```sql
DROP TABLE IF EXISTS agent_events;
DROP TABLE IF EXISTS llm_calls;
ALTER TABLE executions DROP COLUMN instance_id;
UPDATE _schema_version SET version = 13;
```

### 场景 4: 代码级回退

PR 拆分保证安全回退:
- PR 1 (schema): 可独立 revert，新增表不被引用
- PR 2 (LLMCallTracker): 可独立 revert，provider 不 yield 新 events
- PR 3 (ObservabilityService): 可独立 revert，buildCallbacks 不引用
- PR 4 (execution.ts 集成): 可独立 revert，回到纯 SSE 模式

---

## 错误边界与降级 UI

### 服务端降级状态

`GET /api/observability/status` 返回 `{ degraded: boolean, ... }`

### API 响应中的降级标记

```json
{ "data": [], "_degraded": true, "_message": "Observability service is in degraded mode." }
```

### Timeline 降级 Banner

```tsx
function TimelineDegradedBanner() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-700">
      <AlertTriangle className="h-3.5 w-3.5" />
      <span>追踪数据暂时不可用。可观测性服务正在降级模式运行。</span>
    </div>
  )
}
```

### Chart Error Boundary

所有图表组件包裹 `ChartErrorBoundary`，渲染失败时显示 ⚠ 图标 + 错误信息（开发模式显示 stack trace）。

### 空状态设计

- **agent 节点但无数据**: "暂无追踪数据 — 此执行在可观测性功能启用以前完成"
- **非 agent 节点**: "此节点不是 Agent 类型 — 切换到对应 tab 查看详情"
- **Dashboard 空状态**: "运行你的第一个工作流" + 示例工作流按钮

---

## 竞争壁垒分析

### 竞争格局

```
              可观测性深度 ▲
                          │
        ★ Octopus (目标)  │
        Workflow-native + │
        Agent-deep +      │
        Optimization      │
                          │
  Langfuse ●    Braintrust ●
  LLM-deep      Eval-first
  but wf-agnostic  but wf-agnostic
                          │
       n8n ●         Zapier ●
       Workflow-native  Workflow-native
       but agent-shallow  but agent-shallow
                          ├──────────────────────▶ Workflow 理解深度
```

**目标象限右上角目前是空的。**

### vs Langfuse + n8n 组合

| 维度 | Octopus | Langfuse + n8n |
|------|---------|---------------|
| 数据一致性 | 一套概念，一个真相来源 | 两套系统，需要手动关联 |
| 用户体验 | DAG+数据同屏，零切换 | 两个 dashboard 间跳转 |
| 成本 | 本地运行，零 SaaS 费用 | $83-$559/mo |
| 优化闭环 | 看到→建议→YAML patch→应用 | 无法跨系统操作 |
| 隐私 | 数据不离开本机 | 需发送到云端 |

---

## 附录

### A. 进一步探索话题

1. **Prompt 版本管理与 A/B Testing** — prompt hash + 分组 analytics
2. **多模型路由智能** — 基于历史数据自动选择模型
3. **协作式 Debugging** — 团队标注 + 知识库
4. **成本预算与消费控制** — monthly budget + 自动降级
5. **Execution Replay** — 按时间轴同步回放完整执行过程
6. **可观测性数据的 ML 应用** — 异常检测(Isolation Forest)、成本预测、失败预测

### B. 评审记录

**v1.0 → v2.0 修订（Hermes 评审后）:**

| 问题 | 修复 |
|------|------|
| E2E 测试方案完全空白 | 新增 "E2E 测试" 章节，3 个关键路径 Playwright 测试 |
| 视觉回归测试空白 | 新增 "视觉回归测试" 章节，截图基线 + 断点测试 |
| User Story + AC 空白 | 新增 "验收标准" 章节，5 条 US + 详细 AC |
| Feature Flag 策略空白 | 新增 "Feature Flag 策略" 章节 |
| CI/CD 集成空白 | 新增 "CI/CD 集成" 章节 |
| 回退方案空白 | 新增 "回退方案" 章节，4 种场景 |
| 错误边界 UI 空白 | 新增 "错误边界与降级 UI" 章节 |
| 数据量估算矛盾 | 修正: 500 events/exec, 50K/day, 稳态 ~290MB |
| 状态色/节点类型色矛盾 | 统一为现有 Tailwind 类名 (Agent=violet, Bash=blue) |
| "零新增依赖"与桑基图矛盾 | 修正: "Phase 1-2 零新增依赖，Phase 3 可能引入 d3-sankey" |
| content_truncated 列未说明 | 删除该列（content_length > max 即可推断） |
| llm_calls 冗余字段未说明 | 添加注释说明查询性能理由 |
| 审计日志从 Phase 1 推迟到 Phase 2 | 减少 Phase 1 范围，专注核心数据层 |
| agent_events vs llm_calls 关系不清 | 新增 "双存储架构说明" 小节 |

**v2.0 → v3.0 修订（开发者接手审计后）:**

| # | 问题 | 修复 |
|---|------|------|
| A1 | SWR 不存在于项目中，前端数据流架构是空中楼阁 | 重写第 10 章，全部改为 useState + fetch + EventSource 模式，删除所有 SWR 引用 |
| A2 | 前端 `ExecutionNodeData` 无 executorType，无法区分 agent/bash/python | 新增 "API 扩展: 执行器类型暴露" 小节，后端 API + 前端类型 + SSE 事件三处修改 |
| A3 | SSE 有两个独立 SSEService 实例，agent_event 路由不明 | 第 10 章新增 "SSE 架构（现有，需修复）" 小节，Phase 1 统一为全局实例 |
| B1 | `ExecutionPanel` 未被使用，实际是 `WorkflowDetailPanel` | 全文替换为 WorkflowDetailPanel，添加实际组件结构说明和数据流描述 |
| B2 | Agent Timeline 没有拆子组件，一个 200 行文件太粗 | 新增 "Agent Timeline 组件分解" 小节，8 个子组件 + Props 接口 + shadcn 原语映射 |
| B3 | Turn 边界检测算法不完整 | 新增 `computeTurnIndex()` 函数 + 3 种边界情况说明 |
| B4 | PrivacyFilter 正则只列了 8 种，AC 要求 12 种 | 补全 12 种完整正则（+aws_secret, github_oauth, slack_token, stripe_key） |
| B5 | DAG 节点成本行的数据注入路径不明 | 新增 "DAG 节点成本行的数据注入路径" 小节，完整数据流 + ExecutionNodeData 扩展 + CostLine 组件 |
| D1 | ObservabilityService buffer 状态机缺实现骨架 | 新增 ~100 行完整实现骨架（bufferEvent/flushNode/persistLLMCalls） |
| D2 | flushNode 事务边界不明 | 实现骨架中已包含：内存递增 lastEventOrder、transaction 批量 INSERT、降级计数 |
| D3 | 成本计算代码缺失 | 新增 `computeCost()` + `calibrateCosts()` 完整代码 + MODEL_PRICING 配置 |
| - | 修改文件清单不完整 | 扩展到 15 个修改文件，新增 types.ts、use-execution-tree.ts、execution-node.tsx、workflow-detail-panel.tsx、api-client.ts |

### C. 关键参考

| 来源 | 价值 |
|------|------|
| OTel GenAI Conventions | 数据格式标准 |
| OpenLLMetry RFC #3460 | Agent 追踪层级 |
| Langfuse Architecture | 自托管参考 |
| Laminar (TS+Rust+OTel) | 架构参考 |
| LLM-as-Judge (arXiv:2306.05685) | 评估方法论 |
