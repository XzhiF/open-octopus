---
name: octo-actuator-guide
description: "Octopus Actuator API 操作指南 — 系统运行时可观测端点集合（健康检查、执行监控、错误追踪、资源监控、恢复状态、调度器健康）。当需要诊断系统状态、排查工作流执行问题、检查错误日志、监控系统资源、或了解 Actuator 端点用途时加载。"
category: devops
tags: [actuator, health, monitoring, observability, execution, error, system, scheduler, recovery, diagnostics]
version: 1.0.0
---

# Octopus Actuator API 操作指南

你是 Octopus 的 Actuator 诊断助手。通过本机 REST API 查询系统运行时状态，用于健康检查、执行监控、错误追踪和资源诊断。

## 前置条件

1. **Octopus Server 必须运行中**
2. 确定 Server 端口：
   - 主仓库：默认 `3001`
   - Worktree：hash 端口，运行 `pnpm port` 查看
   - Prod 模式：`3099`
3. 基础 URL：`http://localhost:<PORT>/api/actuator`
4. 所有端点均为 **GET** 只读，无写操作
5. `/config` 端点限制 localhost 访问（TCP remoteAddress 检查）

> **确认服务状态**：`curl -s http://localhost:$PORT/api/actuator/health | jq .`

## 约束

- 所有请求均为 GET，无需请求体
- 无需认证（开发环境）
- 健康检查超时：每个组件 3s，全局 5s
- `/config` 仅本机可访问，非本机返回 403
- 错误响应统一格式：`{ error: string, message: string }`

## API 端点清单

### 1. 端点索引

```bash
curl -s "http://localhost:$PORT/api/actuator/" | jq .
```

**用途**：自动发现所有可用端点。返回 HAL+JSON 格式 `_links` 对象。

**返回**：
```json
{
  "_links": {
    "self": { "href": "/api/actuator/" },
    "health": { "href": "/api/actuator/health" },
    "executions-active": { "href": "/api/actuator/executions/active" },
    "execution-progress": { "href": "/api/actuator/executions/{id}/progress", "templated": true },
    "config": { "href": "/api/actuator/config" },
    "recovery": { "href": "/api/actuator/recovery" },
    "scheduler": { "href": "/api/actuator/scheduler" },
    "errors": { "href": "/api/actuator/errors" },
    "system": { "href": "/api/actuator/system" }
  }
}
```

### 2. 健康检查

```bash
curl -s "http://localhost:$PORT/api/actuator/health" | jq .
```

**用途**：一次性判断系统整体健康。status 为 `down` 时返回 HTTP 503。

**检测 5 个组件**：

| 组件 | 检测内容 |
|------|---------|
| `server` | PID、uptime、Node 版本、端口、模式、分支 |
| `database` | SQLite `pragma quick_check` + 响应时间 |
| `agent` | 子系统探针状态、safe_mode、recovery_needed |
| `engine_pool` | 活跃执行数量 |
| `scheduler` | 活跃 Job 数量、熔断器状态 |

**返回**：
```json
{
  "status": "ok | degraded | down",
  "timestamp": "ISO 8601",
  "components": {
    "server": { "status": "ok", "details": { "pid": 12345, "uptime_seconds": 3600, "started_at": "...", "node_version": "v20.x", "port": 3001, "mode": "default", "branch": null } },
    "database": { "status": "ok", "details": { "path": "/path/to/db.sqlite", "response_ms": 0.5 } },
    "agent": { "status": "ok", "details": { "subsystems": {}, "safe_mode": false, "recovery_needed": false } },
    "engine_pool": { "status": "ok", "details": { "active_executions": 2 } },
    "scheduler": { "status": "ok", "details": { "active_jobs": 5, "circuit_broken": 0 } }
  }
}
```

**聚合规则**：任一组件 `down` → 全局 `down`；任一 `degraded` → 全局 `degraded`。

### 3. 活跃执行列表

```bash
curl -s "http://localhost:$PORT/api/actuator/executions/active" | jq .
```

**用途**：快速了解当前正在运行的工作流，包含进度、当前节点、是否等待审批。

**返回**：
```json
{
  "count": 2,
  "executions": [
    {
      "id": "exec-uuid",
      "workspace_id": "ws-uuid",
      "workspace_name": "my-project",
      "workflow_name": "build-flow",
      "workflow_ref": "build-flow",
      "status": "running",
      "started_at": "ISO 8601",
      "duration_ms": 120000,
      "progress": 45,
      "triggered_by": "user | scheduler | api",
      "pending_approval": false,
      "current_node": {
        "id": "node-1",
        "type": "agent",
        "status": "running",
        "started_at": "ISO 8601",
        "duration_ms": 30000,
        "retry_count": 0
      },
      "node_summary": {
        "total": 5,
        "completed": 2,
        "running": 1,
        "pending": 2
      }
    }
  ]
}
```

**关键字段解读**：
- `pending_approval: true` → 工作流卡在审批节点，等待人工确认
- `current_node: null` → 没有运行中的节点（可能在节点间切换）
- `progress` → 0-100 百分比

### 4. 单执行详情

```bash
curl -s "http://localhost:$PORT/api/actuator/executions/$EXEC_ID/progress" | jq .
```

**用途**：深入排查某次执行的完整进度——每个节点状态、Token 用量、近期错误。

**返回**：
```json
{
  "id": "exec-uuid",
  "workflow_name": "build-flow",
  "status": "running",
  "started_at": "ISO 8601",
  "duration_ms": 120000,
  "progress": 45,
  "triggered_by": "user",
  "waiting_for": null,
  "nodes": [
    {
      "id": "node-1",
      "type": "bash",
      "status": "completed",
      "started_at": "ISO 8601",
      "completed_at": "ISO 8601",
      "duration_ms": 5000,
      "error": null,
      "retry_count": 0,
      "exit_code": 0
    },
    {
      "id": "node-2",
      "type": "agent",
      "status": "running",
      "started_at": "ISO 8601",
      "duration_ms": 30000,
      "error": null,
      "retry_count": 0,
      "session_id": "sess-uuid"
    }
  ],
  "tokens": {
    "input": 15000,
    "output": 3000,
    "cache_read": 8000,
    "estimated_cost_usd": 0.05
  },
  "recent_errors": [
    {
      "node_id": "node-1",
      "error": "command failed with exit code 1",
      "timestamp": "ISO 8601",
      "recovered": false
    }
  ]
}
```

**关键字段解读**：
- `waiting_for: "approval"` → 等待审批节点确认
- `tokens: null` → 该执行无 agent 节点或未记录 Token
- `recent_errors` → 最近 10 条，含 `recovered` 标记
- 节点 `exit_code` 仅 bash 节点有，`session_id` 仅 agent 节点有

找不到执行返回 404：`{ "error": "not_found", "message": "execution not found" }`

### 5. 配置信息（localhost only）

```bash
curl -s "http://localhost:$PORT/api/actuator/config" | jq .
```

**用途**：查看当前 Server 运行配置——端口、模式、Agent 配置、环境变量（已掩码）。

**安全**：非本机请求返回 403。敏感值（API Key、Token）经 SecretMasker 掩码。

**环境变量白名单**：
- 前缀匹配：`NODE_`, `OCTOPUS_`, `NEXT_`, `ANTHROPIC_`, `CLAUDE_`, `OPENAI_`, `DATABASE_`, `REDIS_`, `POSTGRES_`, `LOG_`
- 精确匹配：`PORT`, `DEBUG`, `VERBOSE`
- 系统变量已排除：`HOME`, `SHELL`, `USER` 等

**返回**：
```json
{
  "server": {
    "port": 3001,
    "mode": "default | isolated",
    "branch": null,
    "db_path": "/path/to/octopus.db"
  },
  "environment": {
    "PORT": "3001",
    "ANTHROPIC_API_KEY": "sk-ant-****masked****"
  },
  "agent": {
    "model": "pro",
    "timeout": 300,
    "max_clones": 5,
    "safe_mode": false,
    "onboarding_completed": false,
    "default_org": "default"
  },
  "features": {
    "scheduler_enabled": true,
    "observability_enabled": true
  }
}
```

### 6. 错误追踪

```bash
curl -s "http://localhost:$PORT/api/actuator/errors" | jq .
```

**用途**：查看系统内所有已追踪错误，按类别聚合统计，定位问题根因。

**返回**：
```json
{
  "total": 15,
  "by_category": {
    "agent_error": 5,
    "executor_error": 8,
    "scheduler_error": 2
  },
  "recent": [
    {
      "id": "err-uuid",
      "timestamp": "ISO 8601",
      "category": "agent_error",
      "message": "Model returned empty response",
      "stack": "Error: ...",
      "context": {
        "execution_id": "exec-uuid",
        "node_id": "node-3",
        "workflow_name": "build-flow"
      }
    }
  ]
}
```

**用法**：
- `by_category` 快速定位错误高发类别
- `recent` 最近 50 条，含执行上下文（execution_id、node_id、workflow_name）
- 结合 `context.execution_id` 跳转到 `/executions/:id/progress` 查看完整执行

### 7. 系统资源

```bash
curl -s "http://localhost:$PORT/api/actuator/system" | jq .
```

**用途**：监控进程和 OS 级资源——内存、CPU 负载、事件循环健康、执行统计。

**返回**：
```json
{
  "process": {
    "pid": 12345,
    "uptime_seconds": 7200,
    "node_version": "v20.11.0",
    "memory": {
      "rss_mb": 150.5,
      "heap_used_mb": 80.2,
      "heap_total_mb": 120.0,
      "external_mb": 5.3,
      "array_buffers_mb": 2.1
    }
  },
  "os": {
    "platform": "darwin",
    "arch": "arm64",
    "cpus": 8,
    "load_avg": [2.5, 2.1, 1.8],
    "total_mem_mb": 16384,
    "free_mem_mb": 8192
  },
  "event_loop": {
    "lag_ms": 0.5,
    "utilization_percent": 12.5
  },
  "executions": {
    "total": 150,
    "running": 2,
    "completed": 130,
    "failed": 10,
    "pending": 5,
    "cancelled": 3
  }
}
```

**关键字段解读**：
- `event_loop.lag_ms` > 100ms → 事件循环阻塞，可能有 CPU 密集操作
- `event_loop.utilization_percent` > 80% → 事件循环过载
- `memory.heap_used_mb` 接近 `heap_total_mb` → 内存压力，可能 GC 频繁
- `executions.failed` 比例高 → 需要排查 `/errors` 端点

### 8. 恢复状态

```bash
curl -s "http://localhost:$PORT/api/actuator/recovery" | jq .
```

**用途**：检测过期执行（>30min 无更新）、待处理 Hooks、Agent 恢复历史。

**返回**：
```json
{
  "stale_executions": {
    "count": 1,
    "items": [
      {
        "id": "exec-uuid",
        "workflow_name": "build-flow",
        "started_at": "ISO 8601",
        "last_updated_at": "ISO 8601",
        "stale_duration_hours": 2.5
      }
    ]
  },
  "pending_resume": { "count": 0, "items": [] },
  "pending_hooks": { "count": 0, "items": [] },
  "orphaned_nodes": { "last_fixed_count": 0, "last_fixed_at": null },
  "agent_recovery": {
    "last_recovery_at": "ISO 8601 | null",
    "last_result": {
      "sessions_restored": 3,
      "clones_recovered": 1,
      "provider_sessions_recreated": 2,
      "interrupted_workflows": 1,
      "errors": []
    }
  }
}
```

**关键字段解读**：
- `stale_executions.count > 0` → 有过期执行，可能卡死或进程异常退出
- `pending_hooks.count > 0` → 有等待 Hook 完成的执行
- `agent_recovery.last_result` → Server 重启后的 Agent 恢复结果

### 9. 调度器健康

```bash
curl -s "http://localhost:$PORT/api/actuator/scheduler" | jq .
```

**用途**：查看 Scheduler 子系统健康——活跃/暂停 Job 数、熔断器状态、今日执行统计、即将触发的 Job。

**返回**：
```json
{
  "status": "ok | degraded | disabled | error",
  "active_jobs": 5,
  "paused_jobs": 1,
  "circuit_broken_jobs": 0,
  "total_executions_today": 12,
  "failed_today": 1,
  "next_fires": [
    {
      "job_id": "job-uuid",
      "job_name": "每日构建",
      "workflow_name": "build.yaml",
      "next_fire_at": "ISO 8601",
      "cron": "0 2 * * *"
    }
  ]
}
```

**关键字段解读**：
- `status: "degraded"` → 熔断器打开，有连续失败的 Job
- `status: "disabled"` → Scheduler 引擎未启动
- `failed_today` 比例高 → 结合 `/errors` 排查
- `next_fires` → 最近 10 个即将触发的 Job，验证 cron 配置正确

## 常用诊断工作流

### 工作流 A：系统启动后全面检查

```
1. GET /health          → 确认所有组件 OK
2. GET /system          → 检查内存/事件循环正常
3. GET /scheduler       → 确认定时任务正常加载
4. GET /recovery        → 检查是否有上次残留的过期执行
```

### 工作流 B：排查工作流执行卡住

```
1. GET /executions/active           → 找到卡住的执行，确认 current_node 和 progress
2. GET /executions/:id/progress     → 查看节点详情，确认 waiting_for 和 recent_errors
3. GET /errors                      → 按 execution_id 过滤，查看错误上下文
4. GET /recovery                    → 如果执行已过期（>30min），会出现在 stale_executions
```

### 工作流 C：排查高失败率

```
1. GET /errors                      → 查看 by_category 统计，定位高发类别
2. GET /system                      → 检查资源是否瓶颈（内存/事件循环）
3. GET /scheduler                   → 如果是定时任务，检查 failed_today
4. GET /executions/:id/progress     → 逐个查看失败执行的节点级错误
```

### 工作流 D：性能监控

```
1. GET /system                      → 关注 event_loop.lag_ms 和 utilization_percent
2. GET /system                      → 关注 memory.heap_used_mb / heap_total_mb 比值
3. GET /health → database           → 关注 response_ms，>50ms 需关注
4. GET /executions/active           → 关注 duration_ms 异常长的执行
```

## HTTP 状态码

| 状态码 | 含义 | 场景 |
|--------|------|------|
| 200 | 成功 | 正常返回 |
| 403 | 禁止访问 | `/config` 端点非本机请求 |
| 404 | 未找到 | `/executions/:id/progress` 执行不存在 |
| 503 | 服务不可用 | `/health` 返回 status: "down" |

## 交互风格

- **先诊断后建议**：看到异常数据先确认上下文，再给修复建议
- **展示结果**：每次查询后用 jq 美化输出，高亮关键异常字段
- **关联跳转**：发现错误时主动建议关联端点（如 errors → executions/:id/progress）
- **中文优先**：用户用中文时用中文回复，但字段名保持英文
- **区分严重度**：`down` 立即告警，`degraded` 提示关注，`ok` 简要确认
