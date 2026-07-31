# octo-workflow-ops

Query and control workflow executions via the Workflow Ops API.

## Capabilities

- List running, completed, or failed workflow executions
- Get detailed status of a specific execution
- Abort a running execution
- View agent events for a specific workflow node

## API Base URL

All endpoints are relative to: `/api/workspaces/{workspaceId}/workflows/ops`

## Endpoints

### List Executions

```
GET /api/workspaces/{workspaceId}/workflows/ops/executions
Query: ?status=running|completed|failed|pending_interaction|cancelled
Response: { "executions": [...] }
```

Returns all executions for the workspace. Filter by status to see only running or completed ones.

### Get Execution Status

```
GET /api/workspaces/{workspaceId}/workflows/ops/executions/{executionId}/status
Response: {
  "status": "running" | "completed" | "failed" | "pending_interaction" | ...,
  "progress": 0-100,
  "gateStatus": "open" | "closed" | "pending",
  "startedAt": "ISO timestamp",
  "completedAt": "ISO timestamp" | null,
  "duration": number | null,
  "nodeCount": number,
  "workflowName": string
}
```

### Abort Execution

```
POST /api/workspaces/{workspaceId}/workflows/ops/executions/{executionId}/abort
Response: { "ok": true }
```

Stops a running execution. Returns error if execution is already terminal.

### Get Node Events

```
GET /api/workspaces/{workspaceId}/workflows/ops/executions/{executionId}/nodes/{nodeId}/events
Response: { "events": [...] }
```

Returns agent events (LLM calls, tool uses, errors) for a specific node execution.

## Usage Examples

- "当前有什么工作流在运行？" → GET /executions?status=running
- "工作流 abc123 的状态是什么？" → GET /executions/abc123/status
- "停止工作流 abc123" → POST /executions/abc123/abort
- "查看交互节点的事件日志" → GET /executions/abc123/nodes/interaction-1/events
- "列出所有失败的工作流" → GET /executions?status=failed
