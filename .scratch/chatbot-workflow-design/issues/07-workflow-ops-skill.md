# Ticket 7: octo-workflow-ops Skill — Chatbot Workflow Integration

## Summary
Create the `octo-workflow-ops` skill in `@octopus/core-pack` that enables the workspace chatbot (clone agent) to query and control workflow executions via the Workflow Ops API using natural language.

## Scope

### 7.1 Skill Definition

Create `packages/core-pack/skills/octo-workflow-ops/SKILL.md`:

```markdown
# octo-workflow-ops

Query and control workflow executions via the Workflow Ops API.

## Capabilities
- List running/completed/failed workflow executions
- Get detailed status of a specific execution
- Abort a running execution
- View agent events for a specific node

## API Endpoints

### List Executions
```
GET /api/workspaces/{workspaceId}/workflows/executions
Query params: ?status=running|completed|failed|pending_interaction
Response: { executions: Execution[] }
```

### Get Execution Status
```
GET /api/workspaces/{workspaceId}/workflows/executions/{executionId}/status
Response: { status, progress, currentNode, nodeCount, startedAt, duration }
```

### Abort Execution
```
POST /api/workspaces/{workspaceId}/workflows/executions/{executionId}/abort
Response: { ok: true }
```

### Get Node Events
```
GET /api/workspaces/{workspaceId}/workflows/executions/{executionId}/nodes/{nodeId}/events
Response: { events: AgentEvent[] }
```

## Usage Examples
- "当前有什么工作流在运行？" → GET /executions?status=running
- "工作流 abc123 的状态是什么？" → GET /executions/abc123/status
- "停止工作流 abc123" → POST /executions/abc123/abort
- "查看交互节点的事件日志" → GET /executions/abc123/nodes/interaction-1/events
```

### 7.2 Skill Configuration

No additional configuration needed — the skill is a markdown instruction file that the clone agent loads. The agent uses its built-in HTTP tool capabilities to call the API.

## Files to Create
- `packages/core-pack/skills/octo-workflow-ops/SKILL.md`

## Files to Modify
- None

## Verification
- [ ] Skill file exists and is well-formed
- [ ] Chatbot can load the skill (manual test: ask "当前有什么工作流在运行？")
