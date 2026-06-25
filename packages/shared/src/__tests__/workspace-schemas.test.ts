import { describe, it, expect } from "vitest"
import {
  WorkspaceStatusSchema,
  WorkspaceSchema,
  CreateWorkspaceSchema,
  UpdateWorkspaceSchema,
  ExecutionStatusSchema,
  GateStatusSchema,
  ExecutionSchema,
  CreateExecutionSchema,
  NodeTypeSchema,
  NodeExecutionStatusSchema,
  NodeExecutionSchema,
  EdgeTypeSchema,
  NodeEdgeSchema,
  BranchExecutionSchema,
  MessageRoleSchema,
  MessageTypeSchema,
  ChatSessionSchema,
  CreateChatSessionSchema,
  ChatMessageSchema,
  CreateChatMessageSchema,
  SSEExecutionEventSchema,
  SSEWorkspaceEventSchema,
  SSEChatEventSchema,
} from "../types/workspace"

describe("WorkspaceSchema", () => {
  it("validates minimal workspace", () => {
    const result = WorkspaceSchema.safeParse({
      id: "ws-1",
      name: "my-workspace",
      org: "xzf",
      path: "/tmp/ws",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("active")
    }
  })

  it("rejects workspace without required fields", () => {
    const result = WorkspaceSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it("rejects empty string id", () => {
    const result = WorkspaceSchema.safeParse({
      id: "",
      name: "test",
      org: "xzf",
      path: "/tmp",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(false)
  })
})

describe("CreateWorkspaceSchema", () => {
  it("validates create workspace input", () => {
    const result = CreateWorkspaceSchema.safeParse({
      name: "my-workspace",
      org: "xzf",
      path: "/tmp/ws",
    })
    expect(result.success).toBe(true)
  })

  it("rejects create without name", () => {
    const result = CreateWorkspaceSchema.safeParse({ org: "xzf", path: "/tmp/ws" })
    expect(result.success).toBe(false)
  })
})

describe("UpdateWorkspaceSchema", () => {
  it("allows partial updates", () => {
    const result = UpdateWorkspaceSchema.safeParse({ name: "updated-name" })
    expect(result.success).toBe(true)
  })

  it("allows empty object (all optional)", () => {
    const result = UpdateWorkspaceSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe("ExecutionSchema", () => {
  it("validates minimal execution", () => {
    const result = ExecutionSchema.safeParse({
      id: "exec-1",
      workspace_id: "ws-1",
      workflow_ref: "flows/test",
      workflow_name: "test-flow",
      org: "xzf",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("pending")
      expect(result.data.gate_status).toBe("closed")
      expect(result.data.rollback).toBe("none")
      expect(result.data.parent_id).toBe("0")
      expect(result.data.progress).toBe(0)
    }
  })

  it("rejects execution without required fields", () => {
    const result = ExecutionSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it("validates execution with all fields", () => {
    const result = ExecutionSchema.safeParse({
      id: "exec-1",
      workspace_id: "ws-1",
      parent_id: "exec-parent",
      child_index: 0,
      workflow_ref: "flows/test",
      workflow_name: "test-flow",
      status: "running",
      gate_status: "open",
      rollback: "git-revert",
      rollback_on_error: 1,
      input_values: '{"key":"value"}',
      output: '{"result":"ok"}',
      progress: 50,
      triggered_by: "manual",
      started_at: "2025-01-01T00:00:00Z",
      completed_at: null,
      duration: 120,
      org: "xzf",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.rollback).toBe("git-revert")
      expect(result.data.gate_status).toBe("open")
    }
  })
})

describe("CreateExecutionSchema", () => {
  it("validates create execution input", () => {
    const result = CreateExecutionSchema.safeParse({
      workflow_ref: "flows/test",
    })
    expect(result.success).toBe(true)
  })
})

describe("NodeExecutionSchema", () => {
  it("validates minimal node execution", () => {
    const result = NodeExecutionSchema.safeParse({
      id: "ne-1",
      execution_id: "exec-1",
      node_id: "node-1",
      node_type: "bash",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("pending")
    }
  })
})

describe("NodeEdgeSchema", () => {
  it("validates node edge", () => {
    const result = NodeEdgeSchema.safeParse({
      id: "edge-1",
      execution_id: "exec-1",
      from_node_id: "node-1",
      to_node_id: "node-2",
      edge_type: "dependency",
    })
    expect(result.success).toBe(true)
  })
})

describe("BranchExecutionSchema", () => {
  it("validates branch execution", () => {
    const result = BranchExecutionSchema.safeParse({
      id: "branch-1",
      node_execution_id: "ne-1",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("pending")
    }
  })

  it("validates branch with iteration", () => {
    const result = BranchExecutionSchema.safeParse({
      id: "branch-1",
      node_execution_id: "ne-1",
      iteration: 1,
      branch_label: "loop-1",
    })
    expect(result.success).toBe(true)
  })
})

describe("ChatSessionSchema", () => {
  it("validates chat session", () => {
    const result = ChatSessionSchema.safeParse({
      id: "sess-1",
      workspace_id: "ws-1",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.is_active).toBe(1)
    }
  })
})

describe("ChatMessageSchema", () => {
  it("validates chat message", () => {
    const result = ChatMessageSchema.safeParse({
      id: "msg-1",
      session_id: "sess-1",
      role: "user",
      content: "hello",
      created_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("text")
    }
  })

  it("rejects message without role", () => {
    const result = ChatMessageSchema.safeParse({
      id: "msg-1",
      session_id: "sess-1",
      content: "hello",
      created_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(false)
  })
})

describe("SSEEventSchemas", () => {
  it("validates execution node_start event", () => {
    const result = SSEExecutionEventSchema.safeParse({
      event: "node_start",
      data: { executionId: "exec-1", nodeId: "node-1", nodeType: "bash" },
    })
    expect(result.success).toBe(true)
  })

  it("validates execution complete event", () => {
    const result = SSEExecutionEventSchema.safeParse({
      event: "complete",
      data: { executionId: "exec-1", finalStatus: "completed" },
    })
    expect(result.success).toBe(true)
  })

  it("rejects invalid SSE event", () => {
    const result = SSEExecutionEventSchema.safeParse({
      event: "invalid_event",
      data: {},
    })
    expect(result.success).toBe(false)
  })

  it("validates workspace execution_created event", () => {
    const result = SSEWorkspaceEventSchema.safeParse({
      event: "execution_created",
      data: { executionId: "exec-1", treeNodeId: "tree-1" },
    })
    expect(result.success).toBe(true)
  })

  it("validates chat message event", () => {
    const result = SSEChatEventSchema.safeParse({
      event: "message",
      data: { id: "msg-1", role: "user", type: "text", content: "hi" },
    })
    expect(result.success).toBe(true)
  })

  it("validates workspace complete event", () => {
    const result = SSEWorkspaceEventSchema.safeParse({
      event: "complete",
      data: { executionId: "exec-1", finalStatus: "completed" },
    })
    expect(result.success).toBe(true)
  })

  it("validates workspace gate_change event", () => {
    const result = SSEWorkspaceEventSchema.safeParse({
      event: "gate_change",
      data: { executionId: "exec-1", gateStatus: "open" },
    })
    expect(result.success).toBe(true)
  })
})

describe("ExecutionSchema new fields", () => {
  it("defaults node_type to 'normal' and parent_id to '0'", () => {
    const result = ExecutionSchema.safeParse({
      id: "exec-1",
      workspace_id: "ws-1",
      workflow_ref: "deploy",
      workflow_name: "Deploy",
      org: "xzf",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.node_type).toBe("normal")
      expect(result.data.parent_id).toBe("0")
    }
  })

  it("accepts fork node_type", () => {
    const result = ExecutionSchema.safeParse({
      id: "exec-1",
      workspace_id: "ws-1",
      workflow_ref: "deploy",
      workflow_name: "Deploy",
      node_type: "fork",
      org: "xzf",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.node_type).toBe("fork")
    }
  })

  it("rejects invalid node_type", () => {
    const result = ExecutionSchema.safeParse({
      id: "exec-1",
      workspace_id: "ws-1",
      workflow_ref: "deploy",
      workflow_name: "Deploy",
      node_type: "invalid",
      org: "xzf",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(false)
  })

  it("accepts optional branch, start_commit_id, end_commit_id", () => {
    const result = ExecutionSchema.safeParse({
      id: "exec-1",
      workspace_id: "ws-1",
      workflow_ref: "deploy",
      workflow_name: "Deploy",
      branch: "feature/test",
      start_commit_id: JSON.stringify({ "project-a": "abc123" }),
      end_commit_id: JSON.stringify({ "project-a": "def456" }),
      org: "xzf",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
  })
})