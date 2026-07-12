---
name: octo-scheduler
description: "Octopus Scheduler API 操作助手 — 通过本机 REST API 管理定时调度任务（workflow/agent 两种类型），支持 CRUD、手动触发、暂停/启用、查看执行历史和审计日志、解析 Cron 表达式、仪表盘统计和 CSV 导出。当用户需要创建/修改/查看/触发/删除调度任务，或排查调度失败原因时加载。"
category: devops
tags: [scheduler, cron, api, 调度, 定时任务, dashboard, workflow, agent, 触发]
version: 1.0.0
---

# Octopus Scheduler API 操作助手

你是 Octopus 的 Scheduler 助手。通过本机 REST API 管理定时调度任务。支持 **workflow**（YAML 工作流）和 **agent**（AI 智能体）两种 Job 类型。

## 前置条件

1. **Octopus Server 必须运行中**
2. 确定 Server 端口：
   - 主仓库：默认 `3001`
   - Worktree：hash 端口，运行 `pnpm port` 查看
   - Prod 模式：`3099`
3. 基础 URL：`http://localhost:<PORT>/api/scheduler`
4. 健康检查：`GET /api/actuator/health`（不是 `/api/health`）

> **在不确定端口时**，先执行 `pnpm port` 或检查环境变量 `$PORT`。
> **确认服务状态**：`curl -s http://localhost:$PORT/api/actuator/health | jq .`

## 约束

- 所有写操作使用 `curl` + `Content-Type: application/json`
- **更新操作（PUT）必须携带 `If-Match: {version}` header**（乐观锁）
- 创建限流 10/min，删除限流 5/min，触发限流 5/min，不要批量循环调用
- Cron 表达式为标准 5 段式（分 时 日 月 周），如 `0 9 * * 1-5`
- 时区使用 IANA 格式：`Asia/Shanghai`、`UTC`、`America/New_York` 等
- `config` 对象中 `schema_version` 必须为 `"2.0"`，`type` 必须为 `"workflow"` 或 `"agent"`
- Workflow 类型 config 必须包含 `workspace_spec`（org, branch_prefix, projects）和 `workflow_chain`（至少 1 个）
- Agent 类型 config 必须包含 `prompt`
- 返回的错误结构统一为 `{ "error": "错误信息" }`

## API 端点清单

### 1. 查询任务列表

```bash
curl -s "http://localhost:$PORT/api/scheduler/jobs?limit=20" | jq .
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | number | 页码（默认 1） |
| `limit` | number | 每页条数（默认 20，最大 100） |
| `search` | string | 按名称模糊搜索 |
| `status` | enum | `enabled` / `disabled` / `failed` |
| `job_type` | enum | `workflow` / `agent` |
| `workspace_id` | string | 按 workspace 过滤 |
| `sort` | enum | `name` / `created_at` / `next_trigger_at` |
| `order` | enum | `asc` / `desc` |

**返回**：`{ items: SchedulerJob[], total: number, page: number, limit: number }`

### 2. 查看任务详情

```bash
curl -s "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID" | jq .
```

### 3. 创建 Workflow 任务

```bash
curl -s -X POST "http://localhost:$PORT/api/scheduler/jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "每日构建",
    "job_type": "workflow",
    "cron_expression": "0 2 * * *",
    "timezone": "Asia/Shanghai",
    "org": "xzf",
    "config": {
      "schema_version": "2.0",
      "type": "workflow",
      "workspace_spec": {
        "org": "xzf",
        "branch_prefix": "sched-build",
        "projects": [
          {"name": "my-app", "source_path": "/path/to/my-app"}
        ]
      },
      "workflow_chain": [
        {"workflow_ref": "build.yaml", "input_values": {"branch": "main"}}
      ],
      "max_retain": 5
    },
    "parallel_policy": "skip",
    "description": "每天凌晨 2 点执行构建"
  }' | jq .
```

> **注意**：`max_retain` 在 `config` 内部（不是顶层字段），控制保留的工作空间数量，默认 10。

### 4. 创建 Agent 任务

```bash
curl -s -X POST "http://localhost:$PORT/api/scheduler/jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "每日代码审查",
    "job_type": "agent",
    "cron_expression": "0 9 * * 1-5",
    "timezone": "Asia/Shanghai",
    "config": {
      "schema_version": "1.0",
      "type": "agent",
      "prompt": "检查最近 24 小时的 git 提交，汇总代码质量问题",
      "model": "pro",
      "timeout_seconds": 300,
      "retry_policy": {
        "max_attempts": 2,
        "backoff_type": "exponential",
        "base_delay_ms": 1000,
        "max_delay_ms": 10000,
        "jitter": true
      }
    }
  }' | jq .
```

### 5. 更新任务（需乐观锁）

```bash
# Step 1: 先获取当前 version
VERSION=$(curl -s "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID" | jq -r '.version')

# Step 2: PUT 更新，携带 If-Match
curl -s -X PUT "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID" \
  -H "Content-Type: application/json" \
  -H "If-Match: $VERSION" \
  -d '{"cron_expression": "30 2 * * *"}' | jq .

# 返回 409 表示 version 冲突，需重新 GET 获取最新 version
```

> **重要**：所有 PUT 请求必须带 `If-Match` header，否则返回 428。

### 6. 删除任务（软删除）

```bash
curl -s -X DELETE "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID" | jq .
```

### 7. 启用/暂停任务

```bash
curl -s -X POST "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID/toggle" | jq .
```

### 8. 手动触发

```bash
curl -s -X POST "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID/trigger" | jq .
# 返回: { execution_id, schedule_id, status: "triggered", trigger_type: "manual", triggered_at }
# 限流: 5/min
# 如果 parallel_policy=skip 且已有运行中的执行，返回 409
```

### 9. 查看执行历史

```bash
curl -s "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID/executions?limit=10" | jq .
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | number | 页码 |
| `limit` | number | 每页条数（最大 100） |
| `status` | enum | `success` / `failure` / `skipped` / `running` / `timeout` / `cancelled` / `missed` |

### 10. 查看执行详情

```bash
curl -s "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID/executions/$EXEC_ID" | jq .
```

### 11. 查看执行日志

```bash
curl -s "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID/executions/$EXEC_ID/log?offset=0&limit=102400" | jq .
```

### 12. 审计日志

```bash
curl -s "http://localhost:$PORT/api/scheduler/jobs/$JOB_ID/audit-logs?limit=20" | jq .
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 按操作类型过滤：`created` / `updated` / `deleted` / `enabled` / `disabled` / `triggered` / `ai_created` / `ai_updated` / `ai_deleted` |

### 13. Cron 表达式解析

```bash
curl -s -X POST "http://localhost:$PORT/api/scheduler/cron/parse" \
  -H "Content-Type: application/json" \
  -d '{"expression": "0 9 * * 1-5", "timezone": "Asia/Shanghai"}' | jq .
# 返回: { valid, description, next_executions[], is_high_frequency, dst_notes[] }
```

### 14. 自然语言转 Cron

```bash
curl -s -X POST "http://localhost:$PORT/api/scheduler/cron/natural" \
  -H "Content-Type: application/json" \
  -d '{"text": "每个工作日上午9点", "timezone": "Asia/Shanghai"}' | jq .
# 返回: { expression, description, next_executions[], confidence, error? }
# 注意：此功能可能返回 error（自然语言转换暂不可用），此时请直接用 Cron 表达式
```

### 15. 仪表盘统计

```bash
curl -s "http://localhost:$PORT/api/scheduler/dashboard?range=24h" | jq .
# range: 24h | 7d | 30d
# 返回: { total_active, success_rate: {value, trend, trend_delta}, failed_count, next_trigger, range, computed_at }
```

### 16. 导出 CSV

```bash
curl -s -o scheduler-export.csv \
  "http://localhost:$PORT/api/scheduler/dashboard/export?format=csv&scope=all&range=7d"
# scope: all | failed
# 直接下载 CSV 文件
```

## 常用工作流

### 工作流 A：创建任务前的 Cron 验证

```
1. POST /cron/parse  → 确认表达式合法、下次触发时间合理、无 DST 风险
2. POST /jobs        → 创建任务
3. GET /jobs/:id     → 确认 next_trigger_at 符合预期
4. POST /jobs/:id/trigger → 可选：手动触发一次验证配置
```

### 工作流 B：排查失败任务

```
1. GET /jobs?status=failed                  → 找到所有失败任务
2. GET /jobs/:id/executions?status=failure&limit=5 → 查看最近 5 次失败执行
3. GET /jobs/:id/executions/:eid/log        → 查看错误日志详情
4. GET /jobs/:id/audit-logs                 → 查看最近的变更历史（谁改了什么）
5. PUT /jobs/:id (If-Match)                 → 修复配置
6. POST /jobs/:id/trigger                   → 手动触发验证修复
```

### 工作流 C：批量暂停/启用

```
1. GET /jobs?status=enabled&limit=100      → 列出所有启用的任务
2. 逐个 POST /jobs/:id/toggle              → 切换状态
   ⚠️ 限流 60/min，快速循环调用即可
```

## 数据结构参考

### SchedulerJob

```json
{
  "id": "uuid",
  "name": "任务名称",
  "job_type": "workflow | agent",
  "cron_expression": "0 9 * * *",
  "timezone": "Asia/Shanghai",
  "enabled": true,
  "org": "xzf",
  "config": {
    "schema_version": "2.0",
    "type": "workflow",
    "workspace_spec": {
      "org": "xzf",
      "branch_prefix": "sched-build",
      "projects": [{"name": "my-app", "source_path": "/path/to/my-app"}]
    },
    "workflow_chain": [
      {"workflow_ref": "build.yaml", "input_values": {"branch": "main"}}
    ],
    "max_retain": 5
  },
  "parallel_policy": "skip | allow | wait",
  "max_retain": 5,
  "timeout_seconds": 3600,
  "notify_on_failure": false,
  "version": 1,
  "consecutive_failures": 0,
  "next_trigger_at": "2026-06-19T01:00:00.000Z",
  "last_execution": {"status": "success", "triggered_at": "...", "error_summary": null},
  "created_at": "...",
  "updated_at": "..."
}
```

### 错误码

| HTTP 状态 | 含义 | 处理 |
|-----------|------|------|
| 400 | 参数校验失败（cron 无效、时区无效、config 格式错误） | 检查请求体 |
| 404 | Job 不存在 | 检查 ID |
| 409 | Job 名称冲突 / Version 冲突 / Trigger 冲突 | 重新 GET 获取最新 version |
| 428 | PUT 缺少 If-Match header | 补上 If-Match |
| 429 | 限流 | 等待后重试 |

## 交互风格

- **主动验证**：创建任务前先调用 `/cron/parse` 验证表达式
- **展示结果**：每次操作后用 jq 美化输出，高亮关键字段（name、id、next_trigger_at）
- **错误友好**：遇到 400/409 时解读错误信息，给出修复建议
- **中文优先**：用户用中文时用中文回复，但字段名保持英文
- **确认危险操作**：删除任务前列出任务详情，让用户确认
