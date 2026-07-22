# Requirement Brief: Workflow Repair Mechanism

## Overview

创建一个 Claude Code Skill (`octo-workflow-repair`)，作为工作流执行故障的诊断+修复伴侣。当工作流出现各种问题（虚假完成、重试耗尽、卡住、死循环、提示词错误等）时，开发者手动调用此 Skill，它会分析现场状态、提出修复建议、并按开发者意图执行干预操作，让工作流能顺利执行完成。

## Projects Involved

- [x] **engine** (`@octopus/engine`) — 引擎层面的状态操作能力（retryFrom、引擎重建、YAML 热重载）
- [x] **server** (`@octopus/server`) — 新增修复 API 端点 + 执行生命周期扩展
- [x] **shared** (`@octopus/shared`) — 类型定义扩展（修复操作类型）
- [x] **core-pack** — 新增 `octo-workflow-repair` Skill 定义

## Feature Scope

**Do:**

- 诊断工作流执行现场状态（调用 Actuator API + DB 查询 + 事件分析）
- 修复 VarPool 变量值
- 修复节点状态（重置为 pending、标记为 completed、跳过、注入人工输出）
- 恢复到特定节点/检查点重跑
- 修改工作流 YAML 定义（热重载 + 暂停→修改→恢复）
- 外部环境修复后协调工作流继续
- Server 重启后辅助恢复中断的执行
- 卡住节点的诊断 + 干预指导（intervention）
- 支持 Server API + 直接 DB 操作 + 文件修改的混合执行路径

**Don't:**

- 不做操作审计日志（MVP 排除）
- 不新增 Web UI 组件（仅通过 SSE 事件推送状态变更）
- 不做自动异常检测和主动提醒（仅手动调用）
- 不替代 `octo-engine-debug` 的诊断方法论（两者互补）
- 不处理跨工作流的级联修复（仅针对单个 execution）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 交互模式 | Claude Code Skill (CLI 交互式) | 主要用户是开发者，终端操作最高效 |
| 2 | 修复能力范围 | 全部：变量池 + 节点状态 + 外部环境 + 恢复点 + YAML 修改 | 覆盖所有实际场景 |
| 3 | YAML 热修改 | 热重载 + 暂停→修改→恢复，两者结合 | 小改热生效，结构改需暂停 |
| 4 | Skill 定位 | 新建独立 Skill `octo-workflow-repair` | 诊断(读)和修复(写)职责分离 |
| 5 | 操作审计 | MVP 不做 | 先实现核心能力 |
| 6 | 恢复点策略 | 基于现有 DB 机制，可选结合 Checkpoint | 当前 resume 已基于 DB 重建 |
| 7 | 执行路径 | Server API + 直接 DB + 文件修改 | 应对各种场景包括 server 不响应 |
| 8 | 前端同步 | 仅 SSE 事件推送 | MVP 不需要新 UI 组件 |
| 9 | 触发时机 | 手动调用 | 开发者发现问题时主动调用 |

## 典型场景 (Scenarios)

### S1: Agent 虚假完成
**上下文**: Agent 节点返回 `completed` 但实际工作没做完
**操作**: 诊断发现 → 重置节点为 pending → 修改 prompt 指导 → 从该节点重跑

### S2: 重试耗尽
**上下文**: 自动重试 N 次全失败，`failure_strategy: fail_fast`，工作流 `failed`
**操作**: 诊断根因 → 修复外部问题 → 重置重试计数 → 从失败节点重试

### S3: 提示词错误（需改源码）
**上下文**: 审批节点的提示词有误，需要修改源码并重启 server
**操作**: 诊断发现提示词问题 → 暂停工作流 → 修改源码 → 重启 server → 恢复执行

### S4: 节点卡住/死循环
**上下文**: 节点产生几百个 event，不知道卡在哪
**操作**: 分析最近 agent events → 识别循环模式 → 建议 intervention 或暂停 → 注入指导

### S5: 无限重试
**上下文**: 提示词问题导致节点不断重试
**操作**: 识别无限重试模式 → 暂停工作流 → 修改提示词/YAML → 重置重试计数 → 恢复

### S6: 恢复点重跑
**上下文**: 工作流跑了很久，发现早期某步就有问题
**操作**: 选择早期节点作为恢复点 → 重置后续所有节点为 pending → 修复变量 → 从恢复点重跑

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `executions` | 新增字段 | `repair_log TEXT DEFAULT '[]'` — 修复操作记录 JSON（可选，非审计，仅用于 Skill 上下文传递） |
| `node_executions` | 新增字段 | `manual_override TEXT` — 人工注入的输出覆盖（区分于自动执行的 outputs） |
| 无新表 | — | MVP 不引入审计表 |

## API Contracts

### 新增端点 (Server)

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| `POST` | `/api/workspaces/:id/executions/:executionId/repair/varpool` | Server | `{ updates: Record<string, any> }` | `{ updated: number, snapshot: Record<string, any> }` | 批量更新 VarPool 变量 |
| `POST` | `/api/workspaces/:id/executions/:executionId/repair/node/:nodeId/reset` | Server | `{ status: "pending" \| "completed", outputs?: Record<string, any> }` | `{ nodeId, previousStatus, newStatus }` | 重置/修改节点状态，可注入输出 |
| `POST` | `/api/workspaces/:id/executions/:executionId/repair/restore-point` | Server | `{ nodeId: string, resetVarPool?: boolean }` | `{ resetNodes: string[], restoredFrom: string }` | 恢复到指定节点，重置后续节点 |
| `POST` | `/api/workspaces/:id/executions/:executionId/repair/reload-workflow` | Server | `{ content: string }` | `{ reloaded: boolean, diff: string[] }` | 热重载工作流 YAML 定义 |
| `POST` | `/api/workspaces/:id/executions/:executionId/repair/intervene` | Server | `{ nodeId: string, message: string }` | `{ injected: boolean }` | 向正在运行的节点注入干预消息 |
| `GET` | `/api/workspaces/:id/executions/:executionId/repair/diagnose` | Server | — | `DiagnoseReport` | 获取完整的诊断报告 |
| `POST` | `/api/workspaces/:id/executions/:executionId/repair/clear-retry` | Server | `{ nodeIds?: string[] }` | `{ cleared: string[] }` | 清除重试计数（全部或指定节点） |

### 诊断报告结构 (DiagnoseReport)

```typescript
interface DiagnoseReport {
  execution: {
    id: string
    status: ExecutionStatus
    workflowRef: string
    startedAt: string
    duration: number
    retryCount: number
    resumeAttempts: number
  }
  nodes: Array<{
    nodeId: string
    nodeType: NodeType
    status: NodeExecutionStatus
    duration: number
    retryCount: number
    error?: string
    lastOutput?: string
    eventCount: number
    recentEvents: Array<{ type: string; content: string; timestamp: string }>
  }>
  varPool: Record<string, any>
  anomalies: Array<{
    type: "stuck_node" | "exhausted_retry" | "false_completion" | "infinite_retry" | "orphaned_node" | "pending_hooks"
    nodeId?: string
    description: string
    severity: "critical" | "warning" | "info"
    suggestion: string
  }>
  checkpoints: Array<{
    id: string
    timestamp: string
    completedNodes: string[]
    size: number
  }>
  recentErrors: Array<{
    timestamp: string
    nodeId?: string
    error: string
    category: string
  }>
}
```

## Skill 定义

### Skill 名称: `octo-workflow-repair`

### Skill 职责

1. **诊断** — 调用 Actuator API + 诊断端点 + DB 查询，构建执行现场全貌
2. **分析** — 识别异常模式（卡住、死循环、虚假完成、重试耗尽等）
3. **建议** — 根据诊断结果提出修复方案
4. **执行** — 按用户意图调用修复 API / 直接操作 DB / 修改文件
5. **验证** — 修复后确认工作流状态符合预期

### 与 octo-engine-debug 的关系

| 能力 | octo-engine-debug | octo-workflow-repair |
|------|------------------|---------------------|
| 职责 | 诊断（只读分析） | 诊断 + 修复（读写操作） |
| 方法论 | 五层排查法 | 现场诊断 + 异常模式识别 + 修复建议 |
| 操作 | 无副作用 | 修改 DB/文件/YAML/VarPool |
| 配合 | 先用 debug 分析根因 | 再用 repair 执行修复 |

### Skill 交互流程

```
用户: /octo-workflow-repair [executionId]
  │
  ├─ 1. Skill 获取 executionId（参数或让用户选择）
  │
  ├─ 2. 诊断阶段
  │   ├─ 调用 GET /repair/diagnose 获取 DiagnoseReport
  │   ├─ 调用 Actuator API 获取运行时指标
  │   ├─ 如有需要，直接查询 SQLite
  │   └─ 向用户呈现现场摘要 + 异常列表
  │
  ├─ 3. 建议阶段
  │   ├─ 根据异常类型生成修复建议列表
  │   └─ 让用户选择修复方案
  │
  ├─ 4. 执行阶段（按用户选择）
  │   ├─ 变量修复 → POST /repair/varpool
  │   ├─ 节点重置 → POST /repair/node/:id/reset
  │   ├─ 恢复点重跑 → POST /repair/restore-point
  │   ├─ YAML 热修改 → POST /repair/reload-workflow
  │   ├─ 干预注入 → POST /repair/intervene
  │   ├─ 重试清除 → POST /repair/clear-retry
  │   ├─ 源码修改 → 直接 Edit 文件 + 提示重启 server
  │   └─ DB 直修 → 直接 sqlite3 命令
  │
  └─ 5. 验证阶段
      ├─ 重新获取诊断报告
      ├─ 确认修复生效
      └─ 如有需要，触发 retry/resume
```

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 作为开发者，我想诊断一个失败的工作流 | 调用 Skill 后 30s 内获得完整的诊断报告，包含所有节点状态、异常识别、修复建议 | 手动测试：对 failed execution 调用 diagnose 端点，验证报告完整性 |
| 2 | 作为开发者，我想修复 VarPool 中的变量 | 修改后变量立即生效，下次节点执行使用新值 | 手动测试：修改变量 → 触发 retry → 验证节点收到新值 |
| 3 | 作为开发者，我想重置一个"虚假完成"的节点 | 节点状态从 completed 变为 pending，后续节点也正确重置 | 手动测试：重置节点 → 验证 DB 状态 → 重跑验证 |
| 4 | 作为开发者，我想跳过某个节点并注入人工输出 | 节点标记为 completed + 人工输出，下游节点可使用该输出 | 手动测试：注入输出 → 验证下游节点 `$nodeId.output` 解析正确 |
| 5 | 作为开发者，我想从特定节点恢复重跑 | 选定节点及其下游全部重置为 pending，VarPool 恢复到该节点执行前的状态 | 手动测试：选择恢复点 → 验证重置范围 → 重跑验证 |
| 6 | 作为开发者，我想在调试时修改工作流 YAML | 修改后的 YAML 定义在后续节点执行时生效 | 手动测试：修改 prompt → 热重载 → 验证下一个 agent 节点使用新 prompt |
| 7 | 作为开发者，我想向卡住的节点注入干预消息 | 干预消息被注入到正在运行的 agent 节点 | 手动测试：注入消息 → 验证 agent 收到 → 验证行为改变 |
| 8 | 作为开发者，我想修复源码后重启 server 并恢复执行 | Server 重启后，之前暂停的执行可以被恢复 | 手动测试：暂停 → 改源码 → 重启 → 恢复 → 验证继续执行 |
| 9 | 作为开发者，我想清除节点的重试计数 | 重试计数归零后，自动重试机制可以再次触发 | 手动测试：清除计数 → 验证 retry_count = 0 → 触发重试验证 |

## Verification Strategy

### Global Config

- Environment: local dev (主仓库 `pnpm dev`, server:3001 web:3000)
- Test user: 开发者本人
- Data prefix: 无特殊前缀，使用实际工作流执行

### Per-layer Methods

#### Unit Tests

- `DiagnoseReport` 生成逻辑：模拟各种异常场景（stuck node、exhausted retry、orphaned node），验证诊断报告准确性
- VarPool patch 逻辑：验证部分更新不影响其他变量
- 节点状态转换验证：确保状态转换合法（如 completed→pending 允许，cancelled→running 不允许）
- 恢复点重置范围计算：验证 DAG 下游节点正确识别

#### Integration Tests

- 诊断端点 → 完整执行 → 诊断报告一致性
- 变量修复 → retry → 新变量生效
- 节点重置 → 重跑 → 执行完成
- 恢复点重跑 → 全链路重跑验证
- YAML 热重载 → 后续节点使用新定义
- Server 重启 → 恢复执行

#### Browser E2E

- MVP 阶段不做 E2E 测试（仅 SSE 推送，无新 UI 组件）
- 验证 SSE 事件在修复操作后正确推送状态变更

#### Manual Checklist

- [ ] 对每种场景（S1-S6）创建测试工作流，手动验证完整修复流程
- [ ] 验证 Skill 在 server 不响应时能降级到直接 DB 操作
- [ ] 验证恢复点重跑在 DAG 模式（并行节点）下正确重置
- [ ] 验证 YAML 热重载不破坏正在执行的节点
- [ ] 验证干预注入对 7 种执行器类型的兼容性

### Prerequisites

- [ ] Server 可正常启动 (`pnpm dev`)
- [ ] Actuator API 可用 (`/api/actuator/*`)
- [ ] 至少有一个可执行的工作流用于测试
- [ ] `octo-engine-debug` Skill 可用（配合使用）

## Risks & Notes

- **R1: 直接 DB 操作风险** — Skill 直接修改 SQLite 可能绕过业务逻辑，需要 Skill 指令中明确安全边界
- **R2: YAML 热重载的原子性** — 修改 YAML 时如果有节点正在执行，需要确保不会导致状态不一致
- **R3: 恢复点的 VarPool 一致性** — 回滚到早期节点时，VarPool 可能包含后期节点写入的值，需要明确清理策略
- **R4: Server 重启场景** — 重启后 ExecutionPool 中的引擎实例丢失，reconstructEngine 是关键路径
- **R5: 并发修复** — 如果一个修复操作正在执行，另一个修复请求应该如何处理（MVP 串行化）

## Glossary

| Term | Meaning |
|------|---------|
| **虚假完成 (False Completion)** | Agent 节点返回 `completed` 状态但实际工作未完成（输出不满足预期） |
| **重试耗尽 (Retry Exhaustion)** | 节点的自动重试次数用完（`retry_count >= max_attempts`），无法再自动重试 |
| **恢复点 (Restore Point)** | 工作流中一个已完成节点的时间点标记，包含该时刻的 VarPool 快照和节点结果 |
| **干预 (Intervention)** | 向正在运行的节点注入额外的指导消息，引导 agent 改变行为方向 |
| **热重载 (Hot Reload)** | 工作流执行过程中修改 YAML 定义，后续节点使用新定义执行 |
| **死循环 (Infinite Loop)** | 节点因提示词或变量问题进入无限重试/无限事件循环 |
| **诊断报告 (Diagnose Report)** | 对执行现场的结构化分析，包含节点状态、异常识别、修复建议 |
| **节点输出注入 (Output Injection)** | 人工提供节点的输出数据，替代自动执行的结果 |

## Architecture Decision Records

### ADR-1: Skill 与 Engine 的分层

**决策**: 修复能力分两层实现
- **Skill 层** (SKILL.md): 诊断逻辑、交互流程、修复策略编排 — 纯文本指令
- **Server 层** (API endpoints): 实际的状态修改操作 — 有事务保证

**理由**: Skill 作为编排层提供智能决策，Server API 作为执行层保证数据一致性。两者解耦，Skill 可以组合多个 API 调用来完成复杂修复。

**替代方案**: 全部通过 Skill 直接操作 DB → 被否决，因为绕过业务逻辑层风险太高。

### ADR-2: 诊断端点 vs 组合现有 API

**决策**: 新增 `GET /repair/diagnose` 端点，而非组合多个现有 API

**理由**: 诊断需要跨多个表聚合数据（executions + node_executions + agent_events + checkpoints + pending_hooks），单个端点效率更高，且可以包含异常检测逻辑。

**替代方案**: Skill 多次调用现有 API 组合 → 可行但效率低，且异常检测逻辑分散在 Skill 中难以维护。

### ADR-3: YAML 热重载的实现策略

**决策**: 热重载仅影响"尚未执行的节点"，正在执行的节点不受影响

**理由**: 正在执行的节点已经有完整的运行时上下文（prompt、配置等），中途替换可能导致状态不一致。尚未执行的节点在 `executeNode()` 时会重新从 workflow definition 读取。

**替代方案**: 中断当前节点 → 用新 YAML 重建 → 从当前节点恢复 → 太重，不适合小修改场景。
