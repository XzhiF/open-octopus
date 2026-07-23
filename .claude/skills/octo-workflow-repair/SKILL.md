---
name: octo-workflow-repair
description: "工作流执行修复伴侣 — 诊断卡住/失败/异常的工作流执行，提出修复建议，并执行修复操作。支持 VarPool 修复、节点重置、恢复点重跑、YAML 热重载、干预注入、重试清除。当工作流出现虚假完成、重试耗尽、卡住、死循环等问题时使用。"
category: devops
tags: [workflow, repair, diagnose, intervention, recovery, varpool, node-reset, hot-reload]
version: 1.0.0
---

# Octopus Workflow Repair

你是 Octopus 工作流修复助手。当工作流执行出现故障（虚假完成、重试耗尽、卡住、死循环、提示词错误等）时，你负责诊断现场、分析异常、提出修复方案、并按开发者意图执行修复操作。

## 前置条件

1. **Octopus Server 必须运行中**（除非需要降级到直连 DB 模式）
2. 确定 Server 端口：
   - 主仓库：默认 `3001`
   - Worktree：hash 端口，运行 `pnpm port` 查看
   - Prod 模式：`3099`
3. 基础 URL：`http://localhost:<PORT>/api/workspaces/<workspaceId>/executions/<executionId>/repair`
4. 需要有效的 `executionId`（从前端、actuator、或 `octopus workflow list` 获取）

## 与 octo-actuator-guide 的关系

- **octo-actuator-guide**：只读诊断 — 查询系统健康、执行状态、错误日志
- **octo-workflow-repair**：读写操作 — 诊断 + 修改状态 + 触发修复

推荐流程：先用 actuator 确认系统健康，再用 repair 执行修复。

## 约束

- 所有修复操作仅影响单个 execution，不处理跨工作流级联
- MVP 不做审计日志 — 修复操作通过 SSE 事件推送状态变更
- Server 不响应时，可降级到直接 SQLite 操作（谨慎使用）
- 修复操作可能中断正在运行的节点 — 操作前务必确认

## 交互流程

```
用户: /octo-workflow-repair [executionId]
  │
  ├─ 1. 获取 executionId（参数或让用户选择活跃执行）
  │
  ├─ 2. 诊断阶段
  │   ├─ GET /repair/diagnose → DiagnoseReport
  │   ├─ 呈现：执行概览 + 节点状态表 + 异常列表 + 修复建议
  │   └─ 如有需要，补充调用 Actuator API 获取运行时指标
  │
  ├─ 3. 建议阶段
  │   ├─ 根据 anomalies[] 提出修复方案列表
  │   └─ 让用户选择修复操作
  │
  ├─ 4. 执行阶段（按用户选择）
  │   ├─ 变量修复 → POST /repair/varpool
  │   ├─ 节点重置 → POST /repair/node/:nodeId/reset
  │   ├─ 恢复点重跑 → POST /repair/restore-point
  │   ├─ YAML 热重载 → POST /repair/reload-workflow
  │   ├─ 干预注入 → POST /repair/intervene
  │   ├─ 重试清除 → POST /repair/clear-retry
  │   ├─ 源码修改 → 直接 Edit 文件 + 提示重启 server
  │   └─ DB 直修 → 直接 sqlite3 命令（仅在 Server 不可用时）
  │
  └─ 5. 验证阶段
      ├─ 重新 GET /repair/diagnose
      ├─ 确认修复生效（anomalies 减少、状态符合预期）
      └─ 如有需要，触发 POST /executions/:id/retry 或 /resume
```

## API 端点清单

### 1. 诊断报告

```bash
curl -s "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/diagnose" | jq .
```

**返回** `DiagnoseReport`，包含：
- `execution` — 执行概览（id, status, workflowRef, duration, retryCount, resumeAttempts）
- `nodes[]` — 每个节点的状态、耗时、重试次数、错误、输出摘要、最近事件
- `varPool` — 当前变量池快照
- `anomalies[]` — 检测到的异常（类型、节点、描述、严重度、修复建议）
- `checkpoints[]` — 可用检查点
- `recentErrors[]` — 最近的错误记录

### 2. VarPool 修复

```bash
curl -X POST "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/varpool" \
  -H "Content-Type: application/json" \
  -d '{ "updates": { "key": "new_value" } }'
```

**用途**：批量更新变量池。修改立即写入 DB，如果引擎在线也会同步到内存。下次节点执行时使用新值。

**返回**：`{ updated: number, snapshot: Record<string, unknown> }`

### 3. 节点重置

```bash
curl -X POST "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/node/$NODE_ID/reset" \
  -H "Content-Type: application/json" \
  -d '{ "status": "pending" }'
```

**用途**：将节点状态重置为 `pending`（重新执行）或标记为 `completed`（跳过执行）。

**注入人工输出**（标记为 completed + 注入 outputs）：
```bash
curl -X POST "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/node/$NODE_ID/reset" \
  -H "Content-Type: application/json" \
  -d '{ "status": "completed", "outputs": { "result": "manual output", "last_output": "人工注入的结果" } }'
```

**合法的状态转换**：
- → `pending`: completed, failed, skipped, skipped_failed, paused, cancelled, rejected, pending_approval
- → `completed`: failed, pending, paused, cancelled, skipped

**返回**：`{ nodeId, previousStatus, newStatus }`

### 4. 恢复点重跑

```bash
curl -X POST "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/restore-point" \
  -H "Content-Type: application/json" \
  -d '{ "nodeId": "target-node", "resetVarPool": true }'
```

**用途**：选择目标节点作为恢复点，将目标节点及其所有下游节点重置为 `pending`。

- `resetVarPool: true` — 恢复到最近检查点的变量池快照（如果有）
- `resetVarPool: false`（默认）— 保留当前变量池

**返回**：`{ resetNodes: string[], restoredFrom: string }`

### 5. YAML 热重载

```bash
curl -X POST "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/reload-workflow" \
  -H "Content-Type: application/json" \
  -d '{ "content": "apiVersion: octopus/v1\nkind: Workflow\n..." }'
```

**用途**：替换工作流的 YAML 定义。仅影响"尚未执行的节点"，正在执行的节点不受影响。

**返回**：`{ reloaded: boolean, diff: string[] }`

### 6. 干预注入

```bash
curl -X POST "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/intervene" \
  -H "Content-Type: application/json" \
  -d '{ "nodeId": "stuck-agent", "message": "请停止当前操作，重新审视任务要求..." }'
```

**用途**：向正在运行或暂停的 agent 节点注入干预消息，引导其改变行为方向。

**返回**：`{ injected: boolean }`

### 7. 重试清除

```bash
curl -X POST "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/clear-retry" \
  -H "Content-Type: application/json" \
  -d '{ "nodeIds": ["node-a", "node-b"] }'
```

**清除所有节点**（省略 nodeIds）：
```bash
curl -X POST "http://localhost:$PORT/api/workspaces/$WS_ID/executions/$EXEC_ID/repair/clear-retry" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**用途**：将节点的重试计数归零，使自动重试机制可以再次触发。

**返回**：`{ cleared: string[] }`

## 异常模式识别

| 异常类型 | 严重度 | 触发条件 | 典型修复 |
|----------|--------|----------|----------|
| `stuck_node` | critical | 节点 running 但事件数 >100 或长时间无更新 | intervention 或 reset to pending |
| `exhausted_retry` | critical | 节点 failed 且 retry_count ≥ 3 | clear-retry + fix root cause + retry |
| `false_completion` | warning | agent 节点 completed 但输出为空或极短 | reset to pending + 改进 prompt |
| `infinite_retry` | critical | 执行级 retry_count > 5 | pause + diagnose + fix + clear-retry |
| `orphaned_node` | warning | 节点 running 但执行状态非 running | reset to failed 或 pending |
| `pending_hooks` | info | 执行有未执行的 hooks | resume 执行以 drain hooks |

## 典型场景修复指南

### S1: Agent 虚假完成

1. `GET /repair/diagnose` → 发现 `false_completion` anomaly
2. `POST /repair/node/:id/reset` → status: pending
3. 可选：修改 prompt（`POST /repair/reload-workflow` 或 Edit 文件）
4. `POST /executions/:id/retry` → failedNodeId: 该节点

### S2: 重试耗尽

1. `GET /repair/diagnose` → 发现 `exhausted_retry` anomaly
2. 修复外部问题（API key、网络、依赖服务等）
3. `POST /repair/clear-retry` → nodeIds: [失败节点]
4. `POST /executions/:id/retry` → failedNodeId: 该节点

### S3: 提示词错误（需改源码）

1. `GET /repair/diagnose` → 确认问题出在 prompt
2. `POST /executions/:id/pause` → 暂停执行
3. 直接 Edit 源码修改 prompt
4. 重启 server（`pnpm dev`）
5. `POST /executions/:id/resume` → 恢复执行

### S4: 节点卡住/死循环

1. `GET /repair/diagnose` → 发现 `stuck_node` anomaly
2. 分析最近 events 识别循环模式
3. `POST /repair/intervene` → 注入指导消息
4. 如果无效：`POST /repair/node/:id/reset` → 重置为 pending

### S5: 恢复点重跑

1. `GET /repair/diagnose` → 查看 checkpoints 和节点状态
2. `POST /repair/restore-point` → nodeId: 目标恢复点
3. 可选：`POST /repair/varpool` → 修改变量
4. `POST /executions/:id/retry` → failedNodeId: 恢复点节点

## 降级模式：Server 不可用时

当 Server 不响应时，可以直接操作 SQLite 数据库：

```bash
# 查看执行状态
sqlite3 ~/.octopus/db/octopus.db "SELECT id, status, workflow_ref FROM executions WHERE id='$EXEC_ID'"

# 修改 VarPool
sqlite3 ~/.octopus/db/octopus.db "UPDATE executions SET var_pool='{\"key\":\"value\"}' WHERE id='$EXEC_ID'"

# 重置节点状态
sqlite3 ~/.octopus/db/octopus.db "UPDATE node_executions SET status='pending', error=NULL WHERE execution_id='$EXEC_ID' AND node_id='$NODE_ID'"

# 清除重试计数
sqlite3 ~/.octopus/db/octopus.db "UPDATE node_executions SET retry_count=0 WHERE execution_id='$EXEC_ID'"
```

> ⚠️ **警告**：直接 DB 操作绕过业务逻辑层，可能导致状态不一致。仅在 Server 不可用时使用。
