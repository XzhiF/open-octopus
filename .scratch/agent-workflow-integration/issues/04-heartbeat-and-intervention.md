# 04 — Heartbeat Observation + SSE Wiring + Basic Intervention

## What to build
实现 Layer 3 (Observation) 和 Layer 4 (基础 Intervention)：HeartbeatHandler 定时状态上报、AgentEvent heartbeat 变体、SSE agent_heartbeat 事件推送、heartbeat JSONL 日志持久化、harness-intervene API 端点。

## Blocked by
03 — OctopusAgentExecutor (需要 executor 内部的 AgentEvent 流接入 heartbeat)

## Status
done

## Acceptance Criteria
- [ ] AC1: HeartbeatHandler 在每 N 步 (heartbeat_interval, default=3) 发出 heartbeat 事件
- [ ] AC2: heartbeat 数据包含: step, tokens_used, tokens_budget, artifacts, current_activity (v1: confidence=-1, issues=[])
- [ ] AC3: AgentEvent 新增 heartbeat 变体，通过 onAgentEvent → EngineCallbacks → SSEService 桥接
- [ ] AC4: SSE 客户端收到 `agent_heartbeat` 事件，data 含 execution_id, node_id, agent_name, version, heartbeat
- [ ] AC5: `agent_heartbeat` 加入 SILENT_EVENTS 集合（高频事件不打印 console）
- [ ] AC6: Heartbeat 同时写入 JSONL 日志文件 `{executionDir}/heartbeats.jsonl`
- [ ] AC7: auto_abort_on_budget 检查: tokens_used > max_tokens 时发出 harness_directive abort 事件
- [ ] AC8: heartbeat_timeout 检测: 超过阈值无事件时发出 heartbeat_stall 警告事件
- [ ] AC9: `POST /api/workspaces/:id/executions/:executionId/harness-intervene` 端点可用
- [ ] AC10: intervene directive `{ type: 'abort' }` → 调用 ExecutionLifecycle.cancel()
- [ ] AC11: intervene directive `{ type: 'pause' }` → 调用 ExecutionLifecycle.pause()
- [ ] AC12: v1 pause 是 execution-level（暂停整个 workflow），与现有 pause() 语义一致

## Verification Method
**Verification type**: integration test + SSE event verification

**Verification steps**:
```bash
# 1. 执行包含 octopus_agent 的 workflow，订阅 SSE
# (在另一个终端)
curl -N "http://localhost:3001/api/workspaces/:id/events" | grep agent_heartbeat
# Expect: 收到多个 agent_heartbeat 事件

# 2. 检查 JSONL 日志
cat ~/.octopus/executions/{execId}/heartbeats.jsonl | head -3
# Expect: JSON lines with step, tokens_used, etc.

# 3. Intervention: pause
curl -X POST "http://localhost:3001/api/workspaces/:id/executions/{execId}/harness-intervene" \
  -H 'Content-Type: application/json' \
  -d '{"nodeId":"dev-agent","directive":{"type":"pause","reason":"Review","issued_by":"user"}}'
# Expect: 200 + {success: true}

# 4. Verify execution paused
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT status FROM executions WHERE id='{execId}'"
# Expect: paused

# 5. Intervention: abort
curl -X POST "http://localhost:3001/api/workspaces/:id/executions/{execId2}/harness-intervene" \
  -H 'Content-Type: application/json' \
  -d '{"nodeId":"dev-agent","directive":{"type":"abort","reason":"Budget exceeded","issued_by":"user"}}'
# Expect: 200 + {success: true}
```

**Pass criteria**: All 12 ACs pass, SSE events received, intervention works
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
