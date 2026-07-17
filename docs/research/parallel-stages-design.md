# Parallel-Stages 并发线程池工作流节点设计

> **版本**: v1.0.0  
> **日期**: 2026-07-17  
> **状态**: Design Proposal

---

## 1. 概述

### 1.1 需求背景

需要一个支持并发执行的工作流节点，用于处理任务组（task groups），其中：
- 每个任务组包含多个可并行执行的任务
- 任务组之间按顺序执行（barrier 语义）
- 并发度受线程池大小限制（最大 3 线程）
- 仅支持 agent 类型节点

### 1.2 核心概念

**任务组结构**:
```
Stage 0: [task-1, task-2, task-3]  → 并行，最多 maxThreads 同时
Stage 1: [task-4]                  → 等 stage 0 全完成
Stage 2: [task-5, task-6]          → 并行
```

- **Stage 间**: barrier 语义 (`Promise.all` semantics) — stage N 全部完成后才执行 stage N+1
- **Stage 内**: thread pool 语义 — 受 `maxThreads` 限制并发数

### 1.3 设计目标

1. **动态编排**: 支持从 JSON 输入动态生成任务组
2. **Fail-fast**: 任一任务失败立即终止当前 stage
3. **Resume 支持**: 支持 stage-level 和 task-level 恢复
4. **可视化**: 类似 Loop 容器，但 stage 垂直堆叠，tasks 水平排列（无连接线）
5. **Token 累计**: 显示整个 pool 的累计 token 消耗

---

## 2. 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 输入方式 | JSON 动态生成 (`stages_from`) | 灵活性，支持 planner agent 生成任务编排 |
| 错误处理 | Fail-fast + abort signal | 简单，快速失败 |
| Resume | Stage-level + task-level within stage | 平衡复杂度与实用性 |
| 并发控制 | Semaphore with slot tracking | 限制 maxThreads，slot 用于 UI 显示 |
| Token 显示 | Cumulative only | 简化 UI，避免信息过载 |
| 命名 | `parallel-stages` | 清晰表达 stage 顺序 + stage 内并行 |

---

## 3. YAML 结构

### 3.1 基本用法

```yaml
- id: planner
  type: agent
  prompt: |
    分析需求，输出任务编排 JSON:
    {
      "stages": [
        { "tasks": [
          { "id": "task-1", "prompt": "Research X" },
          { "id": "task-2", "prompt": "Research Y" }
        ]},
        { "tasks": [
          { "id": "task-3", "prompt": "Synthesize: $task-1.output + $task-2.output" }
        ]}
      ]
    }
  output_format: json

- id: pool
  type: parallel-stages
  stages_from: $planner.output  # 动态解析
  max_threads: 3
  model: sonnet
```

### 3.2 配置字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `"parallel-stages"` | ✅ | 节点类型 |
| `stages_from` | `string` | ✅ | 变量引用，指向 JSON 编排数据 |
| `max_threads` | `number` | ❌ | 最大并发线程数，默认 3，上限 3 |
| `model` | `string` | ❌ | 默认 model，可被 task override |

---

## 4. JSON 编排 Schema

### 4.1 类型定义

```typescript
interface ParallelStagesPlan {
  stages: Stage[]
}

interface Stage {
  tasks: Task[]
}

interface Task {
  id: string
  prompt: string
  model?: string  // override pool default
  temperature?: number
  max_tokens?: number
}
```

### 4.2 示例

```json
{
  "stages": [
    {
      "tasks": [
        { "id": "task-1", "prompt": "Research topic A" },
        { "id": "task-2", "prompt": "Research topic B" },
        { "id": "task-3", "prompt": "Research topic C" }
      ]
    },
    {
      "tasks": [
        { "id": "task-4", "prompt": "Synthesize: $task-1.output + $task-2.output + $task-3.output" }
      ]
    },
    {
      "tasks": [
        { "id": "task-5", "prompt": "Draft report" },
        { "id": "task-6", "prompt": "Review draft" }
      ]
    }
  ]
}
```

---

## 5. Engine 实现

### 5.1 ParallelStagesExecutor 类

**文件**: `packages/engine/src/executors/parallel-stages.ts`

```typescript
class ParallelStagesExecutor implements NodeExecutor {
  private config: ParallelStagesConfig
  private resume?: ResumeConfig
  private pool: VarPool
  
  constructor(
    node: NodeDef, 
    pool: VarPool, 
    config: ParallelStagesConfig, 
    resume?: ResumeConfig
  ) {
    this.pool = pool
    this.config = config
    this.resume = resume
  }
  
  async execute(): Promise<NodeExecutionResult> {
    // 1. 解析 stages_from
    const planJson = this.pool.resolve(this.config.stagesFrom)
    const plan: ParallelStagesPlan = JSON.parse(planJson)
    
    // 2. Validate schema
    this.validate(plan)
    
    const resumeState = this.resume?.state as ParallelStagesResumeState | undefined
    
    // 3. 执行 stages
    for (let i = 0; i < plan.stages.length; i++) {
      // Skip completed stages (resume)
      if (resumeState?.completedStages.includes(i)) {
        callbacks.onStageSkip(nodeExecutionId, i, "already completed")
        continue
      }
      
      // Resume from failed stage
      if (resumeState && i === resumeState.failedStage) {
        await this.executeStageWithResume(i, plan.stages[i], resumeState)
      } else {
        await this.executeStage(i, plan.stages[i])
      }
    }
    
    return { 
      status: "completed", 
      outputs: { stages: plan.stages.length } 
    }
  }
}
```

### 5.2 Stage 执行逻辑

```typescript
async executeStage(stageIndex: number, stage: Stage): Promise<StageResult> {
  const semaphore = new Semaphore(this.config.maxThreads)
  const abortController = new AbortController()
  
  // 发射 stage_start
  callbacks.onStageStart(nodeExecutionId, stageIndex, stage.tasks.length)
  
  const taskPromises = stage.tasks.map(async (task, idx) => {
    await semaphore.acquire()
    
    if (abortController.signal.aborted) {
      return { status: "cancelled", taskId: task.id }
    }
    
    try {
      const slotIndex = semaphore.currentSlot
      callbacks.onSlotStart(nodeExecutionId, slotIndex, task.id)
      
      const result = await this.runAgent(task, {
        signal: abortController.signal
      })
      
      callbacks.onSlotEnd(nodeExecutionId, slotIndex, task.id, result)
      
      // 写入变量池，供后续 stages 使用
      this.pool.set(`${task.id}.output`, result.output)
      
      return result
      
    } catch (error) {
      // Fail-fast: 取消同 stage 其他 tasks
      abortController.abort()
      throw error
    } finally {
      semaphore.release()
    }
  })
  
  // Promise.all — 任一失败则整体失败
  const results = await Promise.all(taskPromises)
  
  // Check for failures
  const failed = results.find(r => r.status === "failed")
  if (failed) {
    callbacks.onStageFailed(nodeExecutionId, stageIndex, failed.taskId, failed.error)
    throw new Error(`Stage ${stageIndex} failed: ${failed.error}`)
  }
  
  // 发射 stage_end
  callbacks.onStageEnd(nodeExecutionId, stageIndex, results)
  
  return { stageIndex, results }
}
```

### 5.3 Resume 逻辑

```typescript
async executeStageWithResume(
  stageIndex: number, 
  stage: Stage, 
  resumeState: ParallelStagesResumeState
): Promise<StageResult> {
  // Filter out completed tasks
  const pendingTasks = stage.tasks.filter(
    t => !resumeState.completedTasks.includes(t.id)
  )
  
  callbacks.onStageStart(nodeExecutionId, stageIndex, pendingTasks.length)
  
  // Execute only pending tasks
  const semaphore = new Semaphore(this.config.maxThreads)
  const results = await Promise.all(
    pendingTasks.map(async (task) => {
      await semaphore.acquire()
      try {
        callbacks.onSlotStart(nodeExecutionId, semaphore.currentSlot, task.id)
        const result = await this.runAgent(task, {})
        callbacks.onSlotEnd(nodeExecutionId, semaphore.currentSlot, task.id, result)
        this.pool.set(`${task.id}.output`, result.output)
        return result
      } finally {
        semaphore.release()
      }
    })
  )
  
  // Merge with completed task results (from resume state)
  const allResults = [
    ...resumeState.completedTasks.map(id => ({ 
      taskId: id, 
      status: "completed",
      output: this.pool.get(`${id}.output`)  // 从变量池恢复
    })),
    ...results
  ]
  
  callbacks.onStageEnd(nodeExecutionId, stageIndex, allResults)
  
  return { stageIndex, results: allResults }
}
```

### 5.4 Agent 执行

```typescript
private async runAgent(
  task: Task, 
  options: { signal?: AbortSignal }
): Promise<TaskResult> {
  const agentNode: NodeDef = {
    id: task.id,
    type: "agent",
    prompt: task.prompt,
    model: task.model || this.config.model,
    temperature: task.temperature,
    max_tokens: task.max_tokens
  }
  
  const agentExecutor = new AgentExecutor(
    agentNode,
    this.pool,
    {
      ...this.config,
      sessionId: this.config.globalSessionId
    }
  )
  
  const result = await agentExecutor.execute()
  
  if (options.signal?.aborted) {
    return { taskId: task.id, status: "cancelled" }
  }
  
  return {
    taskId: task.id,
    status: result.status,
    output: result.outputs?.output,
    tokens: {
      input: result.outputs?.inputTokens || 0,
      output: result.outputs?.outputTokens || 0
    },
    error: result.error
  }
}
```

---

## 6. Semaphore 实现

**文件**: `packages/engine/src/executors/semaphore.ts`

```typescript
class Semaphore {
  private slots: boolean[]  // [true, true, true] = 3 slots available
  private queue: Array<{ resolve: (slot: number) => void }> = []
  public currentSlot: number = -1
  
  constructor(maxSlots: number) {
    this.slots = Array(maxSlots).fill(true)
  }
  
  async acquire(): Promise<number> {
    // 找到第一个可用 slot
    const slotIndex = this.slots.findIndex(s => s === true)
    
    if (slotIndex !== -1) {
      this.slots[slotIndex] = false
      this.currentSlot = slotIndex
      return slotIndex
    }
    
    // 全满，等待
    return new Promise<number>((resolve) => {
      this.queue.push({ resolve })
    })
  }
  
  release(slot?: number) {
    const slotIndex = slot ?? this.currentSlot
    
    if (slotIndex >= 0 && slotIndex < this.slots.length) {
      this.slots[slotIndex] = true
      
      // 通知 queue 中等待者
      if (this.queue.length > 0) {
        const waiter = this.queue.shift()!
        this.slots[slotIndex] = false
        waiter.resolve(slotIndex)
      }
    }
  }
}
```

---

## 7. Resume State

### 7.1 类型定义

```typescript
interface ParallelStagesResumeState {
  completedStages: number[]  // [0, 1] = stage 0, 1 已完成
  failedStage: number  // 2 = stage 2 失败
  completedTasks: string[]  // ["task-5", "task-6"] = stage 2 中已完成
  failedTask?: string  // "task-7" = stage 2 中失败 task
}
```

### 7.2 Save State

**文件**: `packages/server/src/services/execution/ExecutionLifecycle.ts`

```typescript
// Stage 失败时保存 resume state
const resumeState: ParallelStagesResumeState = {
  completedStages: [0, 1],  // 已完成的 stages
  failedStage: 2,           // 失败的 stage
  completedTasks: ["task-5", "task-6"],  // stage 2 中已完成 tasks
  failedTask: "task-7"      // stage 2 中失败 task
}

await db.saveExecutionResume(executionId, {
  nodeId: "pool",
  state: resumeState
})
```

### 7.3 Resume Trigger

**CLI**:
```bash
octopus workflow resume <execution-id> --from-node pool
```

**Engine**:
```typescript
const resumeState = await db.getExecutionResume(executionId, "pool")
const executor = new ParallelStagesExecutor(node, pool, config, {
  state: resumeState
})
```

---

## 8. SSE Events

### 8.1 事件类型

| 事件 | 数据 | 用途 |
|------|------|------|
| `stage_start` | `{ stageIndex, taskCount }` | UI 显示 stage 开始 |
| `stage_skip` | `{ stageIndex, reason }` | Resume 时跳过已完成 stage |
| `slot_start` | `{ slotIndex, taskId, model }` | Log: `start promise-1` |
| `slot_end` | `{ slotIndex, taskId, status, tokens }` | Log: `end promise-1` |
| `stage_end` | `{ stageIndex, results[] }` | UI 更新 stage 完成 |
| `stage_failed` | `{ stageIndex, failedTask, error }` | Fail-fast 触发 |

### 8.2 Server 实现

**文件**: `packages/server/src/services/execution/ExecutionLifecycle.ts`

```typescript
callbacks.onStageStart = (nodeExecutionId, stageIndex, taskCount) => {
  sse.emit('stage_start', { 
    executionId, 
    nodeExecutionId, 
    stageIndex, 
    taskCount 
  })
}

callbacks.onSlotStart = (nodeExecutionId, slotIndex, taskId) => {
  sse.emit('slot_start', { 
    executionId, 
    nodeExecutionId, 
    slotIndex, 
    taskId 
  })
}

callbacks.onSlotEnd = (nodeExecutionId, slotIndex, taskId, result) => {
  sse.emit('slot_end', { 
    executionId, 
    nodeExecutionId, 
    slotIndex, 
    taskId,
    status: result.status,
    tokens: result.tokens
  })
}

callbacks.onStageEnd = (nodeExecutionId, stageIndex, results) => {
  sse.emit('stage_end', { 
    executionId, 
    nodeExecutionId, 
    stageIndex, 
    results 
  })
}

callbacks.onStageFailed = (nodeExecutionId, stageIndex, failedTask, error) => {
  sse.emit('stage_failed', { 
    executionId, 
    nodeExecutionId, 
    stageIndex, 
    failedTask,
    error
  })
}
```

---

## 9. Frontend UI

### 9.1 类型定义

**文件**: `packages/web-app/lib/types.ts`

```typescript
interface ParallelStagesSummary {
  totalStages: number
  completedStages: number
  currentStage?: number
  stages: StageSummary[]
  totalTokens: {
    input: number
    output: number
  }
}

interface StageSummary {
  stageIndex: number
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  taskCount: number
  tasks: TaskSummary[]
}

interface TaskSummary {
  taskId: string
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  slotIndex?: number
  durationMs?: number
  tokens?: {
    input: number
    output: number
  }
  error?: string
}
```

### 9.2 SSE Event Handlers

**文件**: `packages/web-app/hooks/use-execution-tree.ts`

```typescript
// Handle stage_start
if (event.type === 'stage_start') {
  const { nodeExecutionId, stageIndex, taskCount } = event.data
  const summary = parallelStagesMap.get(nodeExecutionId) || createEmptySummary()
  
  summary.currentStage = stageIndex
  summary.stages[stageIndex] = {
    stageIndex,
    status: "running",
    taskCount,
    tasks: []
  }
  
  parallelStagesMap.set(nodeExecutionId, summary)
}

// Handle slot_start
if (event.type === 'slot_start') {
  const { nodeExecutionId, slotIndex, taskId } = event.data
  const summary = parallelStagesMap.get(nodeExecutionId)
  const stage = summary.stages[summary.currentStage]
  
  stage.tasks.push({
    taskId,
    status: "running",
    slotIndex,
    startedAt: Date.now()
  })
}

// Handle slot_end
if (event.type === 'slot_end') {
  const { nodeExecutionId, slotIndex, taskId, status, tokens } = event.data
  const summary = parallelStagesMap.get(nodeExecutionId)
  const stage = summary.stages[summary.currentStage]
  const task = stage.tasks.find(t => t.taskId === taskId)
  
  task.status = status
  task.durationMs = Date.now() - task.startedAt
  task.tokens = tokens
  
  // Update cumulative tokens
  summary.totalTokens.input += tokens.input
  summary.totalTokens.output += tokens.output
}

// Handle stage_end
if (event.type === 'stage_end') {
  const { nodeExecutionId, stageIndex } = event.data
  const summary = parallelStagesMap.get(nodeExecutionId)
  
  summary.stages[stageIndex].status = "completed"
  summary.completedStages++
}
```

### 9.3 Container Node

**文件**: `packages/web-app/components/workspace/workflow-nodes/parallel-stages-container-node.tsx`

```tsx
function ParallelStagesContainerNode({ data }: NodeProps) {
  const { nodeId, name, maxThreads, model } = data
  const summary = useParallelStagesSummary(nodeId)
  
  return (
    <div className="parallel-stages-container border-2 border-dashed rounded-lg p-4">
      {/* Header */}
      <div className="header flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          <LayersIcon className="w-5 h-5" />
          <span className="font-semibold">{name}</span>
          <span className="text-sm text-muted">
            Model: {model} | Max threads: {maxThreads}
          </span>
        </div>
        <div className="tokens text-sm">
          Tokens: in {formatK(summary.totalTokens.input)} / out {formatK(summary.totalTokens.output)}
        </div>
        <StatusBadge status={data.status} />
      </div>
      
      {/* Stages */}
      <div className="stages space-y-4">
        {summary.stages.map((stage, idx) => (
          <StageView key={idx} stage={stage} />
        ))}
      </div>
    </div>
  )
}
```

### 9.4 Stage View

**文件**: `packages/web-app/components/workspace/stage-view.tsx`

```tsx
function StageView({ stage }: { stage: StageSummary }) {
  return (
    <div className="stage">
      <div className="stage-header flex items-center gap-2 mb-2">
        <StatusIcon status={stage.status} />
        <span className="font-medium">Stage {stage.stageIndex}</span>
        <span className="text-sm text-muted">({stage.taskCount} tasks)</span>
      </div>
      
      <div className="stage-tasks flex gap-3">
        {stage.tasks.map((task, idx) => (
          <TaskCard key={idx} task={task} />
        ))}
      </div>
    </div>
  )
}

function TaskCard({ task }: { task: TaskSummary }) {
  return (
    <div className="task-card border rounded px-3 py-2 min-w-[120px]">
      <div className="flex items-center gap-2">
        <StatusIcon status={task.status} />
        <span className="text-sm font-medium">{task.taskId}</span>
      </div>
      {task.status === "completed" && (
        <div className="text-xs text-muted mt-1">
          ✅ {formatDuration(task.durationMs)}
        </div>
      )}
      {task.status === "failed" && (
        <div className="text-xs text-red-500 mt-1">
          ❌ {task.error}
        </div>
      )}
    </div>
  )
}
```

### 9.5 Slot Log Viewer

**文件**: `packages/web-app/components/workspace/slot-log.tsx`

```tsx
function SlotLog({ stage }: { stage: StageSummary }) {
  // Group tasks by slot
  const slots = new Map<number, TaskSummary[]>()
  
  stage.tasks.forEach(task => {
    if (task.slotIndex !== undefined) {
      if (!slots.has(task.slotIndex)) {
        slots.set(task.slotIndex, [])
      }
      slots.get(task.slotIndex)!.push(task)
    }
  })
  
  return (
    <div className="slot-log space-y-2">
      <div className="text-sm font-medium mb-2">
        Stage {stage.stageIndex} ({stage.taskCount} tasks)
      </div>
      
      {Array.from(slots.entries()).map(([slotIndex, tasks]) => (
        <div key={slotIndex} className="slot">
          <div className="slot-header text-xs text-muted mb-1">
            slot-{slotIndex}:
          </div>
          <div className="slot-tasks space-y-1 ml-4">
            {tasks.map((task, idx) => (
              <div key={idx} className="task-line text-sm">
                <span className="task-id">{task.taskId}</span>
                <span className="ml-2">
                  {task.status === "completed" && "✅"}
                  {task.status === "failed" && "❌"}
                  {task.status === "running" && "🔄"}
                  {task.status === "pending" && "⏳"}
                </span>
                {task.durationMs && (
                  <span className="ml-2 text-muted">
                    {formatDuration(task.durationMs)}
                  </span>
                )}
                {task.tokens && (
                  <span className="ml-2 text-xs text-muted">
                    (in: {formatK(task.tokens.input)} / out: {formatK(task.tokens.output)})
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

### 9.6 Layout Example

```
┌─────────────────────────────────────────────────────────┐
│ Parallel Stages: research-pool                          │
│ Model: sonnet | Max threads: 3                          │
│ Tokens: in 45.2k / out 28.7k (cumulative)              │
│ Status: Stage 2/3 running                               │
└─────────────────────────────────────────────────────────┘

Stage 0 ✅
┌─────────┐  ┌─────────┐  ┌─────────┐
│ task-1  │  │ task-2  │  │ task-3  │
│ ✅ 32s  │  │ ✅ 28s  │  │ ✅ 35s  │
└─────────┘  └─────────┘  └─────────┘

Stage 1 ✅
┌─────────┐
│ task-4  │
│ ✅ 45s  │
└─────────┘

Stage 2 🔄
┌─────────┐  ┌─────────┐  ┌─────────┐
│ task-5  │  │ task-6  │  │ task-7  │
│ ✅ 22s  │  │ ✅ 19s  │  │ ❌ fail │
└─────────┘  └─────────┘  └─────────┘
```

### 9.7 Log Viewer Example

```
Stage 0 (3 tasks)
  slot-0: task-1 ✅ 32s (in: 4.2k / out: 2.8k)
  slot-1: task-2 ✅ 28s (in: 3.9k / out: 2.5k)
  slot-2: task-3 ✅ 35s (in: 4.5k / out: 3.1k)

Stage 1 (1 task)
  slot-0: task-4 ✅ 45s (in: 12.1k / out: 8.2k)

Stage 2 (3 tasks)
  slot-0: task-5 ✅ 22s (in: 5.8k / out: 3.9k)
  slot-1: task-6 ✅ 19s (in: 5.2k / out: 3.4k)
  slot-2: task-7 ❌ Error: API timeout
```

**Slot reuse** (5 tasks, maxThreads=3):
```
Stage 0 (5 tasks)
  slot-0: task-1 ✅ 32s
  slot-0: task-4 🔄 running
  slot-1: task-2 ✅ 28s
  slot-1: task-5 🔄 running
  slot-2: task-3 ✅ 35s
```

---

## 10. 实现 Checklist

### Phase 1: Engine Core

- [ ] `packages/engine/src/executors/parallel-stages.ts` — ParallelStagesExecutor
- [ ] `packages/engine/src/executors/semaphore.ts` — Semaphore with slot tracking
- [ ] `packages/engine/src/executors/types.ts` — ParallelStagesConfig + ResumeState types
- [ ] `packages/engine/src/executors/executor-config.ts` — ParallelStagesConfig extends CoreConfig
- [ ] `packages/engine/src/engine.ts` — Register ParallelStagesExecutor in createExecutor()

### Phase 2: Shared Types

- [ ] `packages/shared/src/types/workflow.ts` — ParallelStagesNodeDef + Stage + Task types
- [ ] `packages/shared/src/types/workflow.ts` — ParallelStagesSchema (Zod)
- [ ] `packages/shared/src/types/workspace.ts` — Add `"parallel-stages"` to NodeType enum

### Phase 3: Server SSE

- [ ] `packages/server/src/services/execution/ExecutionLifecycle.ts` — Emit stage_start/end, slot_start/end events
- [ ] `packages/server/src/routes/execution.ts` — API endpoint for parallel-stages summary
- [ ] `packages/server/src/services/execution/ExecutionLifecycle.ts` — Save resume state on failure

### Phase 4: Frontend

- [ ] `packages/web-app/lib/types.ts` — ParallelStagesSummary + StageSummary types
- [ ] `packages/web-app/hooks/use-execution-tree.ts` — Handle stage_start/end, slot_start/end SSE events
- [ ] `packages/web-app/components/workspace/workflow-nodes/parallel-stages-container-node.tsx` — Container node (React Flow)
- [ ] `packages/web-app/components/workspace/stage-view.tsx` — Stage 垂直布局 + task 水平排列
- [ ] `packages/web-app/components/workspace/slot-log.tsx` — Slot-based log viewer
- [ ] `packages/web-app/lib/workflow-parser.ts` — Parse parallel-stages nodes for layout

### Phase 5: Resume

- [ ] `packages/engine/src/executors/parallel-stages.ts` — Resume logic (skip completed stages/tasks)
- [ ] `packages/server/src/services/execution/ExecutionLifecycle.ts` — Save/load resume state
- [ ] `packages/cli/src/commands/workflow.ts` — `octopus workflow resume` command
- [ ] `packages/web-app/components/execution/resume-button.tsx` — UI trigger for resume

---

## 11. 与现有系统对比

| 特性 | Loop | Swarm dispatch | Parallel-stages |
|------|------|----------------|-----------------|
| 执行模式 | 重复相同逻辑 | DAG 依赖调度 | Stage barrier + 并行 |
| 任务定义 | 静态 YAML nodes | 静态 YAML experts | 动态 JSON stages |
| 并发 | 无 (串行 iterations) | DAG 拓扑决定 | maxThreads 限制 |
| UI 布局 | Iteration dots | Expert cards | Stage 堆叠 + task 水平 |
| Resume | Iteration-level | 不支持 | Stage + task-level |
| 变量传递 | `$iteration` | Expert outputs | Task outputs (`$task-id.output`) |

---

## 12. 未来增强

以下功能当前版本不实现，待验证核心功能后按需添加：

1. **动态 stages_from schema validation** — add when JSON parsing bugs surface
2. **Per-stage token breakdown** — add when users ask
3. **DAG 依赖 within stage** — use Swarm dispatch instead
4. **Task-level retry** — add when transient failures common
5. **动态 max_threads** — add when workload patterns justify

---

## 13. 关键文件索引

| 模块 | 文件 | 说明 |
|------|------|------|
| Executor | `packages/engine/src/executors/parallel-stages.ts` | 主执行器 |
| Semaphore | `packages/engine/src/executors/semaphore.ts` | 并发控制 |
| Config | `packages/engine/src/executors/executor-config.ts` | 配置类型 |
| Types | `packages/engine/src/executors/types.ts` | Resume state |
| Schema | `packages/shared/src/types/workflow.ts` | Zod schema |
| SSE | `packages/server/src/services/execution/ExecutionLifecycle.ts` | 事件发射 |
| Frontend Types | `packages/web-app/lib/types.ts` | UI 类型 |
| SSE Handlers | `packages/web-app/hooks/use-execution-tree.ts` | 事件处理 |
| Container | `packages/web-app/components/workspace/workflow-nodes/parallel-stages-container-node.tsx` | React Flow 节点 |
| Stage View | `packages/web-app/components/workspace/stage-view.tsx` | Stage 布局 |
| Slot Log | `packages/web-app/components/workspace/slot-log.tsx` | Slot 日志 |

---

**文档版本**: v1.0.0  
**最后更新**: 2026-07-17
