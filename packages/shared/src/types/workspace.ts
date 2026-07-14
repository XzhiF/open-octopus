import { z } from "zod"

export const ArchiveModeSchema = z.enum(["full", "cleanup"])
export type ArchiveMode = z.infer<typeof ArchiveModeSchema>

export const WorkspaceStatusSchema = z.enum(["active", "inactive", "error"])
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  org: z.string().min(1),
  description: z.string().optional(),
  status: WorkspaceStatusSchema.default("active"),
  path: z.string().min(1),
  knowledge_extraction: z.enum(['auto', 'manual', 'disabled']).default('auto').optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1),
  org: z.string().min(1),
  description: z.string().optional(),
  path: z.string().min(1),
  knowledge_extraction: z.enum(['auto', 'manual', 'disabled']).default('auto').optional(),
})

export const UpdateWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  org: z.string().min(1).optional(),
  description: z.string().optional(),
  status: WorkspaceStatusSchema.optional(),
})

export const ExecutionStatusSchema = z.enum([
  "pending", "running", "completed", "failed", "paused", "cancelled", "pending_approval",
  "completed_with_failures", "skipped", "rejected", "pending_resume",
])
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>

export const GateStatusSchema = z.enum(["open", "closed", "bypassed"])
export type GateStatus = z.infer<typeof GateStatusSchema>

export const ExecutionSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  parent_id: z.string().default("0"),
  child_index: z.number().int().default(0),
  workflow_ref: z.string().min(1),
  workflow_name: z.string().min(1),
  status: ExecutionStatusSchema.default("pending"),
  gate_status: GateStatusSchema.default("closed"),
  rollback: z.enum(["git-revert", "none"]).default("none"),
  rollback_on_error: z.number().int().default(0),
  input_values: z.string().default("{}"),
  var_pool: z.string().default("{}"),
  progress: z.number().int().min(0).max(100).default(0),
  triggered_by: z.enum(["manual", "schedule", "webhook", "chat"]).default("manual"),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  duration: z.number().int().optional(),
  node_type: z.enum(["normal", "fork"]).default("normal"),
  branch: z.string().optional(),
  start_commit_id: z.string().optional(),
  end_commit_id: z.string().optional(),
  org: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
})
export type Execution = z.infer<typeof ExecutionSchema>

export const CreateExecutionSchema = z.object({
  workflow_ref: z.string().min(1),
  parent_id: z.string().nullable().optional(),
  child_index: z.number().int().optional(),
  input_values: z.record(z.unknown()).optional(),
  triggered_by: z.enum(["manual", "schedule", "webhook", "chat"]).optional(),
})

export const NodeTypeSchema = z.enum([
  "bash", "python", "agent", "condition", "approval", "loop", "swarm",
])
export type NodeType = z.infer<typeof NodeTypeSchema>

export const NodeExecutionStatusSchema = z.enum([
  "pending", "running", "completed", "failed", "skipped", "cancelled", "paused", "rejected", "pending_approval",
])
export type NodeExecutionStatus = z.infer<typeof NodeExecutionStatusSchema>

export const NodeExecutionSchema = z.object({
  id: z.string().min(1),
  execution_id: z.string().min(1),
  node_id: z.string().min(1),
  node_type: NodeTypeSchema,
  status: NodeExecutionStatusSchema.default("pending"),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  duration: z.number().int().optional(),
  exit_code: z.number().int().optional(),
  error: z.string().optional(),
  vars_snapshot: z.string().optional(),
  outputs: z.string().optional(),
})
export type NodeExecution = z.infer<typeof NodeExecutionSchema>

export const EdgeTypeSchema = z.enum([
  "dependency", "condition_true", "condition_false",
])
export type EdgeType = z.infer<typeof EdgeTypeSchema>

export const NodeEdgeSchema = z.object({
  id: z.string().min(1),
  execution_id: z.string().min(1),
  from_node_id: z.string().min(1),
  to_node_id: z.string().min(1),
  edge_type: EdgeTypeSchema,
  label: z.string().optional(),
})
export type NodeEdge = z.infer<typeof NodeEdgeSchema>

export const BranchExecutionSchema = z.object({
  id: z.string().min(1),
  node_execution_id: z.string().min(1),
  iteration: z.number().int().nullable().optional(),
  branch_label: z.string().optional(),
  status: z.enum(["pending", "running", "completed", "failed"]).default("pending"),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  duration: z.number().int().optional(),
  output: z.string().optional(),
})
export type BranchExecution = z.infer<typeof BranchExecutionSchema>

export const MessageRoleSchema = z.enum(["user", "assistant", "system"])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export const MessageTypeSchema = z.enum([
  "text", "command", "execution", "error", "file", "thinking", "tool_call",
])
export type MessageType = z.infer<typeof MessageTypeSchema>

export const ChatSessionSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  title: z.string().optional(),
  is_active: z.number().int().default(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
})
export type ChatSession = z.infer<typeof ChatSessionSchema>

export const CreateChatSessionSchema = z.object({
  title: z.string().optional(),
})

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: MessageRoleSchema,
  type: MessageTypeSchema.default("text"),
  content: z.string(),
  metadata: z.string().optional(),
  created_at: z.string().min(1),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const CreateChatMessageSchema = z.object({
  role: MessageRoleSchema,
  type: MessageTypeSchema.optional(),
  content: z.string().min(1),
  metadata: z.string().optional(),
})

export const SSEExecutionEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("node_start"), data: z.object({ executionId: z.string(), nodeId: z.string(), nodeType: NodeTypeSchema }) }),
  z.object({ event: z.literal("node_end"), data: z.object({ executionId: z.string(), nodeId: z.string(), status: z.string(), durationMs: z.number() }) }),
  z.object({ event: z.literal("node_log"), data: z.object({ executionId: z.string(), nodeId: z.string(), logLine: z.string() }) }),
  z.object({ event: z.literal("branch_start"), data: z.object({ executionId: z.string(), nodeExecutionId: z.string(), iteration: z.number() }) }),
  z.object({ event: z.literal("branch_end"), data: z.object({ executionId: z.string(), nodeExecutionId: z.string(), iteration: z.number(), status: z.string() }) }),
  z.object({ event: z.literal("status_change"), data: z.object({ executionId: z.string(), status: ExecutionStatusSchema, progress: z.number() }) }),
  z.object({ event: z.literal("gate_change"), data: z.object({ executionId: z.string(), gateStatus: GateStatusSchema }) }),
  z.object({ event: z.literal("error"), data: z.object({ executionId: z.string(), nodeId: z.string().optional(), error: z.string() }) }),
  z.object({ event: z.literal("complete"), data: z.object({ executionId: z.string(), finalStatus: z.string() }) }),
])

export const SSEWorkspaceEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("execution_created"), data: z.object({ executionId: z.string(), treeNodeId: z.string() }) }),
  z.object({ event: z.literal("execution_status"), data: z.object({ executionId: z.string(), status: ExecutionStatusSchema }) }),
  z.object({ event: z.literal("execution_progress"), data: z.object({ executionId: z.string(), progress: z.number(), currentNodeId: z.string() }) }),
  z.object({ event: z.literal("complete"), data: z.object({ executionId: z.string(), finalStatus: z.string() }) }),
  z.object({ event: z.literal("gate_change"), data: z.object({ executionId: z.string(), gateStatus: GateStatusSchema }) }),
  z.object({ event: z.literal("chat_message"), data: z.object({ sessionId: z.string(), message: ChatMessageSchema }) }),
  z.object({ event: z.literal("file_change"), data: z.object({ path: z.string(), changeType: z.string() }) }),
])

export const SSEChatEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("message"), data: z.object({ id: z.string(), role: MessageRoleSchema, type: MessageTypeSchema, content: z.string(), metadata: z.string().optional() }) }),
  z.object({ event: z.literal("command_result"), data: z.object({ command: z.string(), result: z.string() }) }),
  z.object({ event: z.literal("error"), data: z.object({ error: z.string() }) }),
])

export type SSEExecutionEvent = z.infer<typeof SSEExecutionEventSchema>
export type SSEWorkspaceEvent = z.infer<typeof SSEWorkspaceEventSchema>
export type SSEChatEvent = z.infer<typeof SSEChatEventSchema>