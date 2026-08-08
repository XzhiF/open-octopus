# Mastra Harness 调研报告

> **调研日期**: 2026-08-05
> **项目版本**: mastra@main (2026-08-04 commit)
> **调研人**: External Researcher (subagent)
> **调研范围**: Workflow/Task 执行引擎、运行时监控、约束保护、错误恢复、验证机制、安全沙箱

---

## 项目概览

**Mastra** 是一个 TypeScript 编写的 AI Agent 框架（monorepo），核心定位是 "AI workflow orchestration + agent runtime"。

### 技术栈
- **语言**: TypeScript (ES2022+, ESM)
- **包管理**: pnpm workspace
- **Schema**: Zod v4 (使用 Standard Schema 协议)
- **构建**: tsdown / esbuild
- **测试**: Vitest
- **运行时**: Node.js 20+

### 核心包结构
```
packages/
├── core/                    ← 核心 (workflow + agent + observability + sandbox + storage)
│   └── src/workflows/       ← 工作流引擎 (本次调研重点)
├── _internal-core/          ← 内部基础 (Error 定义、Storage EntityType)
├── isolated-vm/             ← V8 isolate 沙箱 (Code Mode 传输层)
├── server/                  ← REST API server
├── loggers/                 ← 日志适配器
├── deployer/                ← 部署器
└── memory/, rag/, mcp/      ← 其他子系统
```

### Workflow 引擎架构总览
Mastra 的工作流引擎采用**抽象执行引擎 + 多后端实现**的分层架构：

```
              ExecutionEngine (abstract)
                     │
         ┌───────────┼───────────────┐
         │           │               │
DefaultExecution  EventedExecution  InngestExecution
Engine (默认)     Engine (事件驱动)  Engine (durable, 第三方)
```

- **DefaultExecutionEngine**: 进程内同步执行，带内部重试循环
- **EventedExecutionEngine**: 基于 PubSub 事件驱动执行（适合分布式）
- **InngestExecutionEngine** (代码中引用但未深究): 委托给 Inngest 的 durable execution

---

## 1. Workflow 执行引擎

### 1.1 节点类型（StepFlowEntry）

Mastra 的 workflow 是一个 **typed DAG/chain 混合图**，支持以下节点类型：

| 节点类型 | 源码定义 | 说明 |
|---------|---------|------|
| `step` | `SingleStepEntry` | 普通函数步骤（`createStep()`） |
| `agent` | `{ type: 'agent' }` | Agent 作为步骤（声明式） |
| `tool` | `{ type: 'tool' }` | Tool 作为步骤（声明式） |
| `mapping` | `{ type: 'mapping' }` | 数据映射/转换步骤 |
| `workflow` | `{ type: 'workflow' }` | 嵌套工作流 |
| `parallel` | `{ type: 'parallel' }` | 并行执行多个步骤 |
| `conditional` | `{ type: 'conditional' }` | 条件分支 (branch) |
| `loop` | `{ type: 'loop' }` | 循环 (dowhile/dountil) |
| `foreach` | `{ type: 'foreach' }` | 集合遍历（支持并发度控制） |
| `sleep` | `{ type: 'sleep' }` | 延时等待 |
| `sleepUntil` | `{ type: 'sleepUntil' }` | 等到特定时间 |
| `processor` | `processor:` 前缀 | 输入/输出处理器（agent 包装） |

**源码引用**: `packages/core/src/workflows/types.ts`, `packages/core/src/workflows/workflow.ts:2080-2343`

### 1.2 执行模型

**Builder 模式** (fluent API):
```typescript
createWorkflow({ id: 'my-wf', inputSchema, outputSchema })
  .then(stepA)
  .parallel([stepB, stepC])
  .branch([[condition, stepD], [condition2, stepE]])
  .dowhile(stepF, loopCondition)
  .foreach(stepG, { concurrency: 3 })
  .commit()  // 必须调用 commit() 才能执行
```

**执行流程** (`DefaultExecutionEngine.execute()`):
1. 校验图不为空
2. 处理 timeTravel / restart / resume 起始偏移
3. 顺序遍历 `steps[]`，逐个调用 `executeEntry()`
4. 每个 entry 内部 dispatch 到对应 handler（`executeStep`, `executeParallel`, `executeLoop`, `executeConditional`, `executeForeach`, `executeSleep`）
5. 每步执行后立即调用 `persistStepUpdate()` 持久化快照
6. 非 success 状态立即终止并返回
7. 全部成功后返回最终结果

**源码引用**: `packages/core/src/workflows/default.ts:728-1073`

### 1.3 编排方式

- **Chain**: `.then()` 顺序链
- **DAG**: `.parallel()` + `.branch()` 组合成 DAG
- **Loop**: `.dowhile()` / `.dountil()` 循环
- **Foreach**: `.foreach()` 集合遍历（支持 `concurrency` 参数）
- **Nested**: 工作流嵌套（workflow-as-step）
- **Evented**: 基于 PubSub 的事件驱动编排（`EventedExecutionEngine`）

---

## 2. 运行时监控

### 2.1 观测性架构

Mastra 有一套**完整的观测性系统**，位于 `packages/core/src/observability/`，基于三个核心上下文：

```typescript
interface ObservabilityContext {
  tracing: TracingContext;        // Span 树导航
  loggerVNext: LoggerContext;     // Trace 关联的日志
  metrics: MetricsContext;        // Span 标记的指标
  tracingContext: TracingContext; // tracing 的别名
}
```

**源码引用**: `packages/core/src/observability/types/core.ts:104-119`

### 2.2 Span 类型系统

使用 enum 定义了 **25+ 种 Span 类型**，每种类型都有强类型的 attributes：

```typescript
enum SpanType {
  AGENT_RUN = 'agent_run',
  WORKFLOW_RUN = 'workflow_run',
  WORKFLOW_STEP = 'workflow_step',
  WORKFLOW_CONDITIONAL = 'workflow_conditional',
  WORKFLOW_CONDITIONAL_EVAL = 'workflow_conditional_eval',
  WORKFLOW_PARALLEL = 'workflow_parallel',
  WORKFLOW_LOOP = 'workflow_loop',
  WORKFLOW_SLEEP = 'workflow_sleep',
  MODEL_GENERATION = 'model_generation',
  MODEL_STEP = 'model_step',
  MODEL_INFERENCE = 'model_inference',
  MODEL_CHUNK = 'model_chunk',
  TOOL_CALL = 'tool_call',
  PROCESSOR_RUN = 'processor_run',
  MCP_TOOL_CALL = 'mcp_tool_call',
  CLIENT_TOOL_CALL = 'client_tool_call',
  MEMORY_OPERATION = 'memory_operation',
  WORKSPACE_ACTION = 'workspace_action',
  SCORER_RUN = 'scorer_run',
  // ... 更多
}
```

**源码引用**: `packages/core/src/observability/types/tracing.ts:35-100`

### 2.3 Span 生命周期管理

每个步骤执行都有完整的 span 生命周期：

```typescript
// 1. 创建 span
const stepSpan = await engine.createStepSpan({
  parentSpan: observabilityContext.tracingContext.currentSpan,
  stepId: step.id,
  operationId: `workflow.${workflowId}.run.${runId}.step.${step.id}.span.start`,
  options: {
    name: `workflow step: '${step.id}'`,
    type: SpanType.WORKFLOW_STEP,
    entityType: EntityType.WORKFLOW_STEP,
    entityId: step.id,
    input: inputData,
    tracingPolicy: engine.options?.tracingPolicy,
  },
});

// 2. 执行步骤 (with context)
await executeWithContext({ span: stepSpan, fn: () => step.execute(data) });

// 3a. 成功结束
await engine.endStepSpan({ span: stepSpan, operationId, endOptions: { output } });

// 3b. 错误结束
await engine.errorStepSpan({ span: stepSpan, operationId, errorOptions: { error } });
```

**源码引用**: `packages/core/src/workflows/handlers/step.ts:170-184`, `packages/core/src/workflows/default.ts:307-429`

### 2.4 事件系统 (PubSub)

Mastra 使用 **PubSub 事件总线** 进行实时状态推送：

```typescript
// 发布步骤开始事件
await pubsub.publish(`workflow.events.v2.${runId}`, {
  type: 'watch',
  runId,
  data: {
    type: 'workflow-step-start',
    payload: { id: step.id, stepCallId, ...stepInfo },
  },
});

// 发布 workflow 暂停事件
await pubsub.publish(`workflow.events.v2.${runId}`, {
  type: 'watch',
  runId,
  data: { type: 'workflow-paused', payload: {} },
});
```

PubSub 支持两种模式：
- **push**: EventEmitter 直接分发（进程内）
- **pull**: Redis Streams / GCP Pub/Sub（分布式）

**源码引用**: `packages/core/src/events/pubsub.ts:19-57`, `packages/core/src/workflows/default.ts:237-248`

### 2.5 日志系统

- `IMastraLogger` 接口：基础日志
- `LoggerContext` (VNext): trace 关联日志
- `RegisteredLogger` 枚举：组件分类（WORKFLOW, AGENT 等）
- `logger.trackException()`: 异常追踪

### 2.6 持久化快照

每个步骤执行后都持久化完整快照 (`WorkflowRunState`):

```typescript
interface WorkflowRunState {
  runId: string;
  status: WorkflowRunStatus; // 'pending'|'running'|'success'|'failed'|'suspended'|'canceled'|'tripwire'|'paused'|'waiting'
  value: Record<string, any>;        // state
  context: Record<string, any>;      // stepResults
  activePaths: number[];
  stepExecutionPath?: string[];
  activeStepsPath: Record<string, number[]>;
  suspendedPaths: Record<string, number[]>;
  resumeLabels: Record<string, any>;
  serializedStepGraph: SerializedStepFlowEntry[];
  result?: any;
  error?: SerializedError;
  timestamp: number;
  tracingContext?: { traceId, spanId, parentSpanId };
}
```

**源码引用**: `packages/core/src/workflows/handlers/entry.ts:150-200`, `packages/core/src/workflows/types.ts`

### 2.7 生命周期回调

```typescript
interface ExecutionEngineOptions {
  onFinish?: (result: WorkflowFinishCallbackResult) => Promise<void> | void;
  onError?: (errorInfo: WorkflowErrorCallbackInfo) => Promise<void> | void;
  shouldPersistSnapshot: (params) => boolean;
  pruneSnapshot?: (params) => WorkflowRunState;
}
```

回调错误被捕获并记录，不会传播到执行流。

**源码引用**: `packages/core/src/workflows/execution-engine.ts:85-148`

---

## 3. 约束与保护机制

### 3.1 超时控制

**❌ 未实现节点级/workflow 级超时**

在源码中**没有找到**基于 `setTimeout` 的超时控制机制。步骤执行没有内置的 deadline/timeout 概念。

唯一的 timeout 相关代码在 `IsolatedVmCodeModeTransport` 中，但那是在 Code Mode（沙箱执行用户代码）的上下文中：

```typescript
// packages/isolated-vm/src/transport.ts - Code Mode 沙箱
const { program, toolIds, dispatch, timeout, abortSignal } = opts;
```

**🔑 可借鉴**: 这是 Octopus 需要自己实现的重要功能。

### 3.2 中止控制 (AbortController)

Mastra 使用标准的 `AbortController` 实现执行取消：

```typescript
// 执行主循环中检查 abort 信号
for (let i = startIdx; i < steps.length; i++) {
  if (params.abortController.signal.aborted) {
    await this.persistStepUpdate({ ... workflowStatus: 'canceled' });
    workflowSpan?.end({ attributes: { status: 'canceled' } });
    await this.invokeLifecycleCallbacks({ status: 'canceled', ... });
    return { status: 'canceled', ... };
  }
  // ... continue execution
}
```

**嵌套 abort 传播**:
```typescript
// 父 workflow abort → 子 workflow abort
run.abortController.signal.addEventListener('abort', nestedAbortCb);
abortSignal.addEventListener('abort', parentAbortCb);
```

**源码引用**: `packages/core/src/workflows/default.ts:825-883`, `packages/core/src/workflows/workflow.ts:2648-2656`

### 3.3 进程隔离 / 沙箱

Mastra 有多层隔离机制：

#### a) IsolatedVmCodeModeTransport (V8 Isolate)
```typescript
// packages/isolated-vm/src/transport.ts
export class IsolatedVmCodeModeTransport implements CodeModeTransport {
  readonly requiresSandbox = false;
  readonly #memoryLimitMb: number;  // 默认 128 MiB

  // 在 V8 isolate 中执行用户代码
  // - 无文件系统访问
  // - 无网络访问
  // - 无进程访问
  // - 无模块加载
  // - 唯一的能力是注入的 external_* 函数 (allow-list 强制)
}
```

关键特性:
- **堆内存限制**: `memoryLimitMb` (默认 128 MiB)
- **JSON 边界**: 宿主和客户端之间只传递 JSON 字符串，不暴露对象引用
- **TypeScript 剥离**: 使用 esbuild 在宿主端先剥离 TS
- **`--no-node-snapshot` 检测**: Node 20+ 必须带此 flag

**源码引用**: `packages/isolated-vm/src/transport.ts:1-100`

#### b) LocalSandbox (OS 级沙箱)
```typescript
// packages/core/src/workspace/sandbox/local-sandbox.ts
export class LocalSandbox {
  // macOS: seatbelt (sandbox-exec) — 文件系统和网络隔离
  // Linux: bubblewrap (bwrap) — namespace 隔离
  // 支持 mount 配置（只读/读写挂载）
  // 环境变量隔离（默认只有 PATH）
}
```

**源码引用**: `packages/core/src/workspace/sandbox/local-sandbox.ts:1-100`

#### c) NativeSandbox backends
- **seatbelt** (macOS): `sandbox-exec` + 生成的 profile
- **bubblewrap** (Linux): `bwrap` namespace 隔离
- **自动检测**: `detectIsolation()` 检测可用后端

**源码引用**: `packages/core/src/workspace/sandbox/native-sandbox/`

### 3.4 资源限制

- **内存**: V8 isolate 的 `memoryLimitMb` (默认 128 MiB)
- **文件访问**: 沙箱 mount 白名单 (`SAFE_MOUNT_PATH` 正则验证)
- **网络**: 沙箱级别的网络隔离 (seatbelt/bubblewrap)
- **Tool 调用**: allow-list 机制 (`allowList = new Set(toolIds)`)

**❌ CPU 限制**: 未发现显式 CPU 限制机制

---

## 4. 错误处理与恢复

### 4.1 错误分类系统

Mastra 有完整的结构化错误体系：

```typescript
// ErrorDomain — 功能域
enum ErrorDomain {
  TOOL, AGENT, MCP, AGENT_NETWORK, MASTRA_SERVER,
  MASTRA_OBSERVABILITY, MASTRA_WORKFLOW, MASTRA_VOICE,
  MASTRA_VECTOR, MASTRA_MEMORY, LLM, EVAL, SCORER,
  A2A, MASTRA_INSTANCE, MASTRA, DEPLOYER, STORAGE,
  MODEL_ROUTER,
}

// ErrorCategory — 错误类别
enum ErrorCategory {
  UNKNOWN, USER, SYSTEM, THIRD_PARTY,
}
```

```typescript
class MastraError extends MastraBaseError<ErrorDomain, ErrorCategory> {
  id: Uppercase<string>;       // e.g. 'WORKFLOW_STEP_INVOKE_FAILED'
  domain: ErrorDomain;
  category: ErrorCategory;
  details?: Record<string, Json<Scalar>>;
  cause?: SerializableError;
}
```

**源码引用**: `packages/_internal-core/src/error/index.ts:7-142`

### 4.2 非重试错误

```typescript
class MastraNonRetryableError extends Error {
  public readonly isNonRetryable = true as const;
  // 永久失败，绕过 retryConfig
}
```

当 `executeStepWithRetry` 遇到 `MastraNonRetryableError` 时，立即返回失败，不再重试。

**源码引用**: `packages/_internal-core/src/error/index.ts:144-153`, `packages/core/src/workflows/default.ts:467-527`

### 4.3 重试策略

#### 节点级重试
```typescript
// Step 定义时声明 retries
createStep({
  id: 'my-step',
  retries: 3,  // 步骤级重试次数
  execute: async ({ inputData, retryCount }) => { ... }
})
```

#### Workflow 级重试
```typescript
createWorkflow({
  id: 'my-wf',
  retryConfig: { attempts: 2, delay: 1000 }  // 全局重试配置
})
```

#### 重试执行逻辑
```typescript
async executeStepWithRetry<T>(stepId, runStep, params) {
  for (let i = 0; i < params.retries + 1; i++) {
    if (i > 0 && params.delay) {
      await new Promise(resolve => setTimeout(resolve, params.delay));
    }
    try {
      const result = await this.wrapDurableOperation(stepId, runStep);
      return { ok: true, result };
    } catch (e) {
      const isNonRetryable = e instanceof MastraNonRetryableError;
      if (isNonRetryable || i === params.retries) {
        // 最终失败
        return { ok: false, error: { status: 'failed', error, ... } };
      }
      // 继续下一次重试
    }
  }
}
```

**❌ 没有"智能重试"**（避免重复同样失败的方法）— 只是简单的固定次数重试 + 可选延迟。

**源码引用**: `packages/core/src/workflows/default.ts:441-527`

### 4.4 TripWire (智能中断)

TripWire 是一种特殊的错误类型，支持"中断 + 可选重试"语义：

```typescript
class TripWire<TMetadata = unknown> extends Error {
  options: TripWireOptions<TMetadata>;
  processorId?: string;
}

interface TripWireOptions<TMetadata> {
  retry?: boolean;      // true = 带着 reason 作为反馈重试
  metadata?: TMetadata; // 结构化元数据
}
```

使用场景：
- **Processor** 检测到不安全输出 → throw TripWire → workflow 状态变为 `tripwire`
- **retry: true** → agent 将 tripwire reason 加入消息历史后重试
- **retry: false/undefined** → 终止执行

```typescript
// 在 executeStepWithRetry 中处理 TripWire
if (e instanceof TripWire) {
  // 返回 tripwire 信息而不是普通 error
  return {
    ok: false,
    error: {
      status: 'failed',
      error: errorInstance,
      tripwire: {
        reason: e.message,
        retry: e.options?.retry,
        metadata: e.options?.metadata,
        processorId: e.processorId,
      },
    },
  };
}
```

**源码引用**: `packages/core/src/agent/trip-wire.ts:1-112`, `packages/core/src/workflows/default.ts:474-521`

### 4.5 Suspend / Resume (断点续跑)

Mastra 有**成熟的 suspend/resume 机制**：

```typescript
// Step 执行中挂起
execute: async ({ suspend, resumeData, suspendData }) => {
  // 等待外部输入
  await suspend({ question: '需要确认' }, {
    resumeLabel: 'user-approval'  // 可选标签
  });
  // 恢复后继续执行
  const answer = resumeData;
}
```

关键机制:
- **suspendPayload**: 挂起时保存的数据
- **resumePayload**: 恢复时传入的数据
- **suspendedPaths**: 记录哪些步骤处于挂起状态
- **resumeLabels**: 标签化恢复点
- **持久化到存储**: 挂起状态完整持久化到 `WorkflowRunState`

恢复时:
```typescript
// 从快照恢复
const run = await workflow.createRun({ runId: existingRunId });
const result = await run.resume({
  resumeData: { answer: 'yes' },
  step: ['approval-step-id'],    // 指定恢复哪个步骤
  label: 'user-approval',        // 或通过标签恢复
});
```

**源码引用**: `packages/core/src/workflows/handlers/step.ts:313-395`, `packages/core/src/workflows/default.ts:728-747`

### 4.6 Time Travel (时间旅行)

Mastra 支持"时间旅行"——从某个历史步骤重新开始执行：

```typescript
const result = await run.timeTravel({
  step: ['step-a', 'step-b'],  // 从哪个步骤开始
  inputData: newData,          // 可选的新输入
  resumeData: newData,         // 可选的新 resume 数据
  context: previousStepResults,// 历史步骤结果
});
```

实现原理:
1. 从 `timeTravel.executionPath[0]` 开始遍历
2. 使用历史 `stepResults` 作为上下文
3. 指定步骤之后的步骤重新执行

**源码引用**: `packages/core/src/workflows/default.ts:804-813`

### 4.7 Restart (重启)

```typescript
// 从上次中断的位置重启
const result = await run.restart({
  requestContext,
  actor,
});
```

重启逻辑:
1. 从存储读取上次快照
2. 从 `restart.activePaths[0]` 继续执行
3. 保留之前的 `stepResults` 和 `state`

**源码引用**: `packages/core/src/workflows/default.ts:807-813`

### 4.8 Bail (提前退出)

```typescript
execute: async ({ bail }) => {
  // 提前终止 workflow，返回自定义结果
  bail({ reason: 'already processed', data: cached });
}
```

Bail 的结果被标记为 `status: 'bailed'`，然后被转换为 `success`。

**源码引用**: `packages/core/src/workflows/handlers/step.ts:396-398`, `packages/core/src/workflows/default.ts:936-938`

---

## 5. 验证机制

### 5.1 执行前验证

#### a) Step Input 验证
```typescript
const { inputData, validationError } = await validateStepInput({
  prevOutput,
  step,
  validateInputs: engine.options?.validateInputs ?? true,
});

// 使用 Standard Schema 协议验证
const validatedInput = await validateWithStandardSchema(inputSchema, prevOutput);
```

#### b) Step RequestContext 验证
```typescript
const { validationError } = await validateStepRequestContext({
  requestContext,
  step,
  validateInputs: engine.options?.validateInputs ?? true,
});
```

#### c) Resume Data 验证
```typescript
const { resumeData, validationError } = await validateStepResumeData({
  resumeData,
  step,  // 使用 step.resumeSchema
});
```

#### d) Suspend Data 验证
```typescript
const { suspendData, validationError } = await validateStepSuspendData({
  suspendData: suspendPayload,
  step,  // 使用 step.suspendSchema
});
```

#### e) State Data 验证
```typescript
const { stateData, validationError } = await validateStepStateData({
  stateData: state,
  step,  // 使用 step.stateSchema
});
```

**验证可通过 `validateInputs: false` 全局关闭**。

**源码引用**: `packages/core/src/workflows/utils.ts:26-87`, `packages/core/src/workflows/handlers/step.ts:101-111`

### 5.2 Schema 定义

每个 Step 可以定义 6 种 schema：

```typescript
interface StepParams {
  inputSchema: PublicSchema;        // 输入数据 schema
  outputSchema: PublicSchema;       // 输出数据 schema
  stateSchema?: PublicSchema;       // 状态数据 schema
  resumeSchema?: PublicSchema;      // 恢复数据 schema
  suspendSchema?: PublicSchema;     // 挂起数据 schema
  requestContextSchema?: PublicSchema; // 请求上下文 schema
}
```

**源码引用**: `packages/core/src/workflows/workflow.ts:280-404`

### 5.3 Stored Workflow 验证

对从存储加载的声明式 workflow 有**完整的验证系统**：

```typescript
function validateStoredWorkflow(def, index): WorkflowValidationIssue[] {
  const inference = inferGraphSchemas(def, index);
  return [
    ...validateWorkflowStructure(def),     // 结构验证
    ...validateWorkflowSchemas(def),       // Schema 验证
    ...validateWorkflowRefs(def, index),   // 引用验证（agent/tool 存在性）
    ...inference.issues,                   // Schema 流分析
  ];
}
```

验证域:
- **structure**: 图结构完整性
- **schemas**: JSON Schema 关键字合法性
- **refs**: agent/tool/workflow 引用是否存在
- **schema-flow**: 步骤间数据流类型兼容性推断

**源码引用**: `packages/core/src/workflows/stored/validate/index.ts:1-67`

### 5.4 执行后验证

- **Output Schema**: Step 的 `outputSchema` 用于类型推断，但**未在运行时强制验证输出**
- **Scorers**: 可以通过 `scorers` 配置对输出评分（`runScorer()`）

### 5.5 Mapping Template 验证

```typescript
// 定义时验证模板语法
if (typeof mappingConfig === 'object' && mappingConfig !== null) {
  for (const mapping of Object.values(mappingConfig)) {
    if (m?.template) {
      validateTemplate(m.template);  // 检查 ${scope.path} 占位符
    }
  }
}
```

**源码引用**: `packages/core/src/workflows/workflow.ts:1982-1989`

---

## 6. 安全沙箱

### 6.1 Code Mode 安全边界

**IsolatedVmCodeModeTransport** 是 Mastra 最强的安全边界：

```typescript
// 安全特性:
// 1. V8 isolate 是真正的安全边界 (requiresSandbox: false)
// 2. 无文件系统、网络、进程、模块访问
// 3. 唯一能力: 注入的 external_* 函数
// 4. Allow-list 强制执行
const allowList = new Set(toolIds);

// RPC handler - JSON 边界
const rpcHost = async (tool: string, argsJson: string): Promise<string> => {
  // 只接受 allow-list 中的 tool
  if (!allowList.has(tool)) {
    return JSON.stringify({ ok: false, error: { message: `Tool "${tool}" not in allow-list` } });
  }
  // 解析参数，调用 dispatch
  // 返回 JSON 字符串（不暴露宿主对象）
};
```

**源码引用**: `packages/isolated-vm/src/transport.ts:91-150`

### 6.2 OS 级沙箱

**LocalSandbox** 提供操作系统级别的隔离：

```typescript
// macOS: seatbelt (sandbox-exec)
// - 生成 seatbelt profile
// - 限制文件系统访问
// - 限制网络访问

// Linux: bubblewrap (bwrap)
// - namespace 隔离
// - 文件系统只读挂载

// Mount path 验证
const SAFE_MOUNT_PATH = /^\/[a-zA-Z0-9_.\-/]+$/;
function validateMountPath(mountPath: string): void {
  // 必须是绝对路径
  // 不允许 . 或 ..
  // 不允许根路径 /
}
```

**源码引用**: `packages/core/src/workspace/sandbox/local-sandbox.ts:52-73`

### 6.3 TripWire (运行时安全网)

TripWire 充当**运行时安全网**：

- Processor 检测到不安全输出 → throw TripWire
- Workflow 状态变为 `tripwire`（区别于 `failed`）
- 可配置 retry（带反馈）或直接终止

```typescript
// 在 Processor 中使用
execute: async ({ abort }) => {
  if (unsafeContentDetected) {
    abort('Content policy violation', { retry: false });
    // → throw new TripWire('Content policy violation', { retry: false })
  }
}
```

**源码引用**: `packages/core/src/agent/trip-wire.ts:36-46`

### 6.4 FGA 权限检查

```typescript
// 执行前的 Fine-Grained Authorization 检查
const fgaProvider = mastra?.getServer()?.fga;
if (fgaProvider) {
  await requireFGA({
    fgaProvider,
    user,
    resource: { type: 'workflow', id: getWorkflowFGAResourceId(this.id) },
    permission: MastraFGAPermissions.WORKFLOWS_EXECUTE,
    requestContext,
    actor,
  });
}
```

**源码引用**: `packages/core/src/workflows/workflow.ts:2590-2610`

### 6.5 ActorSignal (行为约束)

```typescript
// ActorSignal 传递到步骤中，用于行为约束
execute: async ({ actor }) => {
  // actor 可以携带权限信息、约束条件
}
```

---

## 7. 可借鉴的设计模式

### 7.1 ⭐ 抽象执行引擎 + 多后端

**模式**: `ExecutionEngine` (abstract) → `DefaultExecutionEngine` / `EventedExecutionEngine` / `InngestEngine`

**对 Octopus 的启发**:
- 将执行引擎抽象为接口，允许不同后端实现
- Default 引擎用于进程内执行，Evented 引擎用于分布式
- 通过 hook 方法（`createStepSpan`, `executeStepWithRetry`, `wrapDurableOperation`）让子类定制行为

### 7.2 ⭐ 结构化错误体系 (ErrorDomain + ErrorCategory)

**模式**: 每个错误有 domain（功能域）、category（错误类别）、id（唯一标识）、details（结构化详情）

**对 Octopus 的启发**:
- 统一的错误分类让错误可机器处理
- `MastraNonRetryableError` 让步骤可以声明"永久失败"
- `getErrorFromUnknown()` 将任意错误标准化

### 7.3 ⭐ TripWire (智能中断 + 反馈重试)

**模式**: 不是简单的 throw Error，而是带有 `retry` 和 `metadata` 的结构化中断

**对 Octopus 的启发**:
- Processor/Guard 检测到问题时，可以选择：
  - 终止 + 报告
  - 终止 + 带反馈重试（让 LLM 知道哪里不对）
- 区分 `tripwire` 和 `failed` 状态

### 7.4 ⭐ Suspend/Resume + ResumeLabels

**模式**: 步骤可以挂起等待外部输入，用标签标识恢复点

**对 Octopus 的启发**:
- Approval 节点天然适合 suspend/resume
- `resumeLabels` 让恢复点可寻址
- 挂起状态完整持久化，支持进程重启后恢复

### 7.5 ⭐ Persist-Every-Step 快照策略

**模式**: 每步执行后立即持久化完整 `WorkflowRunState`

**对 Octopus 的启发**:
- 保证崩溃恢复时最多丢失一步的结果
- `lastPersistedStatusByRun` 防止状态回退（running 覆盖 suspended）
- `shouldPersistSnapshot` 回调允许选择性持久化

### 7.6 ⭐ ObservabilityContext 统一上下文

**模式**: tracing + logging + metrics 三者通过 `ObservabilityContext` 绑定

**对 Octopus 的启发**:
- 日志自动关联到当前 span
- 指标自动标记 span 元数据
- 创建子 span 时自动产生新的关联 logger 和 metrics

### 7.7 ⭐ Stored Workflow 验证管道

**模式**: 声明式 workflow 定义 → 结构验证 → Schema 验证 → 引用验证 → Schema 流分析

**对 Octopus 的启发**:
- YAML workflow 加载前做完整验证
- Schema 流分析可以提前发现类型不匹配
- 修复建议（repair-actions）提升用户体验

### 7.8 ⭐ Builder 模式 + 类型安全

**模式**: `.then().parallel().branch().commit()` 链式构建，TypeScript 类型推断步骤间数据兼容性

**对 Octopus 的启发**:
- YAML 定义是声明式的，但程序化 API 的类型安全也很重要
- `commit()` 显式标记图构建完成
- `TPrevSchema extends TStepInput` 编译时检查数据流

### 7.9 ⚠️ 缺失的功能（Octopus 需要补充）

| 功能 | Mastra 状态 | Octopus 建议 |
|------|------------|-------------|
| 节点级超时 | ❌ 未实现 | `timeout` 字段 + AbortSignal |
| CPU 限制 | ❌ 未实现 | cgroup / worker thread 限制 |
| 智能重试 | ❌ 简单计数重试 | 指数退避 + 错误模式检测 |
| 执行中输出验证 | ❌ 只验证输入 | outputSchema 运行时校验 |
| Workflow 级超时 | ❌ 未实现 | `AbortController` + 定时器 |
| 重试策略多样性 | ❌ 只有 delay | 指数退避 / jitter / 自定义策略 |

---

## 源码引用

### 核心执行引擎
| 文件 | 说明 |
|------|------|
| `packages/core/src/workflows/execution-engine.ts` | 抽象执行引擎 + 生命周期回调 |
| `packages/core/src/workflows/default.ts` | DefaultExecutionEngine (1100+ 行) |
| `packages/core/src/workflows/workflow.ts` | Workflow 类 + Builder API (4600+ 行) |
| `packages/core/src/workflows/types.ts` | 所有类型定义 |
| `packages/core/src/workflows/handlers/step.ts` | 步骤执行处理器 |
| `packages/core/src/workflows/handlers/entry.ts` | 入口执行 + 持久化 |
| `packages/core/src/workflows/handlers/control-flow.ts` | 并行/条件/循环处理器 |
| `packages/core/src/workflows/handlers/sleep.ts` | Sleep 处理器 |

### 事件驱动引擎
| 文件 | 说明 |
|------|------|
| `packages/core/src/workflows/evented/execution-engine.ts` | EventedExecutionEngine |
| `packages/core/src/workflows/evented/workflow-event-processor/index.ts` | 事件处理器 (MAX_DELIVERY_ATTEMPTS=3) |
| `packages/core/src/workflows/evented/step-executor.ts` | 事件驱动的步骤执行器 |

### 观测性
| 文件 | 说明 |
|------|------|
| `packages/core/src/observability/types/core.ts` | ObservabilityContext 定义 |
| `packages/core/src/observability/types/tracing.ts` | SpanType enum (25+ types) |
| `packages/core/src/observability/context-factory.ts` | 上下文创建工厂 |
| `packages/core/src/observability/utils.ts` | executeWithContext |

### 错误系统
| 文件 | 说明 |
|------|------|
| `packages/_internal-core/src/error/index.ts` | MastraError + ErrorDomain + ErrorCategory |
| `packages/core/src/agent/trip-wire.ts` | TripWire 中断机制 |
| `packages/core/src/error/utils.ts` | getErrorFromUnknown |

### 验证
| 文件 | 说明 |
|------|------|
| `packages/core/src/workflows/utils.ts` | validateStepInput/ResumeData/SuspendData/StateData |
| `packages/core/src/workflows/stored/validate/index.ts` | Stored Workflow 验证 |
| `packages/core/src/workflows/stored/validate/schema-flow.ts` | Schema 流分析 |
| `packages/core/src/workflows/stored/validate/refs.ts` | 引用验证 |
| `packages/core/src/workflows/mapping-template.ts` | 模板验证 |

### 安全沙箱
| 文件 | 说明 |
|------|------|
| `packages/isolated-vm/src/transport.ts` | V8 Isolate Code Mode 传输 |
| `packages/core/src/workspace/sandbox/local-sandbox.ts` | OS 级沙箱 |
| `packages/core/src/workspace/sandbox/native-sandbox/seatbelt.ts` | macOS seatbelt |
| `packages/core/src/workspace/sandbox/native-sandbox/bubblewrap.ts` | Linux bubblewrap |

### 事件系统
| 文件 | 说明 |
|------|------|
| `packages/core/src/events/pubsub.ts` | PubSub 抽象 (push/pull) |
| `packages/core/src/events/event-emitter.ts` | EventEmitter 实现 |
| `packages/core/src/events/types.ts` | Event 类型定义 |

---

## 附录: 关键发现摘要

### 做得好的地方 ✅
1. **完整的观测性栈**: Span 类型系统 + trace 关联日志 + metrics
2. **Suspend/Resume + TimeTravel + Restart**: 三种恢复模式
3. **结构化错误**: Domain + Category + NonRetryable + TripWire
4. **V8 Isolate 沙箱**: 真正的安全边界 + JSON 隔离
5. **Stored Workflow 验证**: 结构 + Schema + 引用 + 流分析
6. **Schema 验证覆盖**: input/output/state/resume/suspend/requestContext 六种 schema
7. **Persist-Every-Step**: 每步持久化快照，保证崩溃恢复
8. **TripWire**: 智能中断 + 可选反馈重试

### 缺失的地方 ❌
1. **节点级超时**: 没有 `timeout` 字段
2. **Workflow 级超时**: 没有全局 deadline
3. **CPU 限制**: 没有 CPU 配额机制
4. **智能重试**: 只有简单计数 + 固定延迟
5. **执行后输出验证**: outputSchema 只做类型推断，不做运行时验证
6. **重试策略多样性**: 没有指数退避、jitter、自定义策略
7. **资源配额**: 没有内存/CPU/文件数量配额（除 V8 isolate 的 heap limit）

### 对 Octopus WorkflowEngine Harness 的具体建议

1. **优先实现超时控制**: 节点级 + Workflow 级 timeout，用 AbortController 实现
2. **采用 TripWire 模式**: 让 Guard/Processor 可以智能中断 + 反馈重试
3. **结构化错误分类**: ErrorDomain + ErrorCategory + NonRetryable
4. **Persist-Every-Step 快照**: 每步执行后持久化完整状态
5. **Schema 验证全覆盖**: 6 种 schema 位置都验证
6. **ObservabilityContext 统一**: tracing + logging + metrics 绑定
7. **智能重试策略**: 指数退避 + jitter + 错误模式检测（避免重复同样的失败方法）
8. **Stored Workflow 验证管道**: YAML 加载前做结构+Schema+引用+流分析验证
