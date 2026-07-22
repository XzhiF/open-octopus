// Octopus Web UI - Core Types
//
// ── Shared type bridge ──────────────────────────────────────────────
// Types below that have counterparts in @octopus/shared are documented.
// The web-app types extend shared types with UI-specific fields (camelCase,
// eager-loaded relations, display-only fields). New code should prefer
// importing from @octopus/shared when the shared shape is sufficient.
// ─────────────────────────────────────────────────────────────────────

export type {
  // Re-export shared base types for direct use when UI extensions are not needed
  Workspace as SharedWorkspace,
  Execution as SharedExecution,
  NodeExecution as SharedNodeExecution,
  ChatSession as SharedChatSession,
  ChatMessage as SharedChatMessage,
  ExecutionStatus as SharedExecutionStatus,
  GateStatus as SharedGateStatus,
  NodeType as SharedNodeType,
  TokenUsage as SharedTokenUsage,
} from "@octopus/shared"

// ============ Workspace ============
// Shared counterpart: @octopus/shared → Workspace (snake_case: created_at, updated_at)
// Web-app extends with: projectCount, workflowCount, lastActivityAt
export type WorkspaceStatus = "active" | "inactive" | "error"

export interface Workspace {
  id: string
  name: string
  description: string
  status: WorkspaceStatus
  org: string
  projectCount: number
  workflowCount: number
  createdAt: string
  updatedAt: string
  lastActivityAt?: string
  path: string
}

// ============ Project ============
export interface Project {
  id: string
  workspaceId: string
  name: string
  path: string
  description: string
  createdAt: string
  updatedAt: string
}

// ============ Workflow ============
export type WorkflowStatus = "valid" | "invalid" | "draft"

export interface WorkflowStep {
  id: string
  name: string
  type: "shell" | "script" | "api" | "condition" | "loop"
  command?: string
  description?: string
  dependsOn?: string[]
}

export interface Workflow {
  id: string
  projectId: string
  workspaceId: string
  name: string
  description: string
  status: WorkflowStatus
  steps: WorkflowStep[]
  yamlContent: string
  createdAt: string
  updatedAt: string
}

// ============ Token Usage ============
export interface TokenUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number | null
  costComplete?: boolean
}

// ============ Execution ============
export type ExecutionStatus = "pending" | "running" | "completed" | "completed_with_failures" | "failed" | "cancelled" | "paused" | "skipped" | "rejected" | "pending_approval" | "pending_resume"

export type GateStatus = "open" | "closed" | "bypassed"

export type StepExecutionStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled" | "paused" | "rejected" | "pending_approval"

export interface StatusOverlay {
  stepStatus: StepExecutionStatus
  duration?: number
  startedAt?: string
  error?: string
  tokenUsage?: TokenUsage
  tokenUsages?: TokenUsage[]
}

export interface StepExecution {
  stepId: string
  stepName: string
  status: StepExecutionStatus
  startedAt?: string
  completedAt?: string
  duration?: number // in seconds
  output?: string
  error?: string
  model?: string
  tokensInput?: number
  tokensOutput?: number
  tokenUsages?: TokenUsage[]
}

// ============ Approval Metadata ============
export interface ApprovalOption {
  label: string
  value: string
}

export interface ApprovalMetadata {
  prompt: string
  options: ApprovalOption[]
  nodeId: string
  commentLabel?: string
  commentPlaceholder?: string
}

export interface Execution {
  id: string
  workflowId: string
  workflowName: string
  workspaceId: string
  workspaceName: string
  status: ExecutionStatus
  progress: number // 0-100
  currentStep?: string
  steps?: StepExecution[]
  startedAt: string
  completedAt?: string
  duration?: number // in seconds
  triggeredBy: "manual" | "schedule" | "webhook" | "chat"
  logs?: string[]
  approvalMetadata?: ApprovalMetadata | null
}

// ============ Workflow Selection ============
export interface WorkflowOption {
  value: string
  label: string
  name: string
  description?: string
  group: string
  path?: string
  inputs?: Record<string, WorkflowInputDef>
}

// ============ Create Node Form ============
export interface CreateNodeFormData {
  workflowRef: string
  name: string
  rollbackOnError: boolean
  syncMainBranch: boolean
  inputValues: Record<string, string>
}

// ============ Workflow Input Definition ============
export interface WorkflowInputDef {
  description: string
  required: boolean
  default: string
}

// ============ Execute Node Form ============
export interface ExecuteNodeFormData {
  inputValues: Record<string, string>
  rollbackOnError: boolean
  syncMainBranch: boolean
}

// ============ Execution Tree (for flow panel) ============
export interface ExecutionTreeNode {
  id: string
  parentId: string | null
  executionId: string
  workflowId: string
  workflowName: string
  executionStatus: ExecutionStatus
  gateStatus: GateStatus
  rollback: "git-revert" | "none"
  progress: number
  startedAt: string
  completedAt?: string
  duration?: number
  childrenCount: number
  isLeaf: boolean
  triggeredBy: "manual" | "schedule" | "webhook" | "chat"
  logs?: string[]
  steps?: StepExecution[]
  name: string
  workflowRef: string
  rollbackOnError: boolean
  childIndex: number
  inputValues: Record<string, string>
  output: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  workspaceId: string
  org: string
  nodeType?: "normal" | "fork"
  branch?: string
  startCommitId?: Record<string, string>
  endCommitId?: Record<string, string>
  tokenUsages?: TokenUsage[]
  approvalMetadata?: ApprovalMetadata | null
  executorType?: "agent" | "bash" | "python" | "condition" | "approval" | "loop"
  costUsd?: number
  turnCount?: number
  toolCount?: number
}

export interface ExecutionNodeData {
  id: string
  parentId: string | null
  executionId: string
  workflowId: string
  workflowName: string
  executionStatus: ExecutionStatus
  gateStatus: GateStatus
  rollback: "git-revert" | "none"
  progress: number
  childrenCount: number
  isLeaf: boolean
  parentGateStatus: GateStatus | null
  startedAt: string
  triggeredBy: "manual" | "schedule" | "webhook" | "chat"
  name: string
  workflowRef: string
  rollbackOnError: boolean
  childIndex: number
  inputValues: Record<string, string>
  branch?: string
  nodeType?: "normal" | "fork"
  executorType?: "agent" | "bash" | "python" | "condition" | "approval" | "loop"
  isLastCompleted?: boolean
  completedAt?: string
  duration?: number
  branchColor?: { bg: string; text: string; border: string; hex: string; name: string } | null
  tokenUsages?: TokenUsage[]
  approvalMetadata?: ApprovalMetadata | null
  costUsd?: number
  turnCount?: number
  toolCount?: number
}

// ============ Editor Tab ============
export type EditorTabType = "execution" | "detail" | "workflow-editor" | "text-editor" | "schedule" | "image-viewer"

export interface EditorTab {
  id: string
  name: string
  type: EditorTabType
  closable: boolean
  executionId?: string
  filePath?: string
  fileName?: string
  extension?: string
}

// ============ Workflow Step Node (for detail flow chart) ============
export type WorkflowStepNodeType = "agent" | "bash" | "python" | "approval" | "condition" | "loop"

export interface WorkflowStepNode {
  id: string
  name: string
  type: WorkflowStepNodeType
  status: StepExecutionStatus
  x: number
  y: number
  description?: string
  next?: string[]
  condition?: string
}

// ============ Chat ============
export type MessageRole = "user" | "assistant" | "system"
export type MessageDisplayType = "user" | "thinking" | "tool_call" | "ask_user_question" | "text" | "error" | "file"

export interface ChatMessage {
  id: string
  sessionId: string
  role: MessageRole
  displayType: MessageDisplayType
  content: string
  timestamp: string
  thinkingContent?: string
  thinkingDone?: boolean
  toolCallId?: string
  toolName?: string
  toolInput?: unknown
  toolStatus?: "running" | "done" | "error"
  toolResult?: string
  toolDuration?: string
  thinkingStartMs?: number
  thinkingDuration?: string
  tokens?: { input: number; output: number }
  costUsd?: number
}

export interface ChatSession {
  id: string
  workspaceId: string
  title: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
  isActive: boolean
}

/** Map a raw DB row to a ChatMessage, deserializing metadata JSON */
export function fromDBMessage(row: {
  id: string
  session_id: string
  role: string
  type: string
  content: string
  metadata: string | null
  created_at: string
}): ChatMessage {
  let meta: Record<string, unknown> = {}
  if (row.metadata) {
    try { meta = JSON.parse(row.metadata) } catch { /* ignore */ }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    displayType: (meta.displayType as MessageDisplayType)
      ?? (row.role === "user" ? "user" : mapDBType(row.type)),
    content: row.content,
    timestamp: row.created_at,
    thinkingContent: meta.thinkingContent as string | undefined,
    thinkingDone: (meta.thinkingDone as boolean) ?? true,
    toolCallId: meta.toolCallId as string | undefined,
    toolName: meta.toolName as string | undefined,
    toolInput: meta.toolInput,
    toolStatus: (meta.toolStatus as ChatMessage["toolStatus"]),
    toolResult: meta.toolResult as string | undefined,
    toolDuration: meta.toolDuration as string | undefined,
    thinkingStartMs: meta.thinkingStartMs as number | undefined,
    thinkingDuration: meta.thinkingDuration as string | undefined,
    tokens: meta.tokens as ChatMessage["tokens"],
    costUsd: meta.costUsd as number | undefined,
  }
}

function mapDBType(dbType: string): MessageDisplayType {
  const map: Record<string, MessageDisplayType> = {
    text: 'text',
    command: 'text',
    execution: 'text',
    error: 'error',
    file: 'file',
    tool: 'tool_call',
    tool_call: 'tool_call',
    thinking: 'thinking',
  }
  return map[dbType] ?? 'text'
}

// ============ File Tree ============
export type FileNodeType = "file" | "directory"

export interface FileNode {
  id: string
  name: string
  type: FileNodeType
  path: string
  children?: FileNode[]
  isExpanded?: boolean
  extension?: string
}

// ============ Dashboard Stats ============
export interface DashboardStats {
  activeWorkspaces: number
  totalWorkspaces: number
  runningExecutions: number
  pendingExecutions: number
  completedToday: number
  failedToday: number
}

// ============ API Response Types ============
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

// ============ Leaderboard Types ============

export interface ModelUsageGroup {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number | null
  costComplete: boolean
}

export interface WorkspaceRanking {
  workspaceId: string
  workspaceName: string
  totalTokens: number
  totalCostUsd: number | null
  costComplete: boolean
  models: ModelUsageGroup[]
}

export interface ExecutionRanking {
  executionId: string
  workflowRef: string
  workflowName: string
  workspaceId: string
  workspaceName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number | null
  costComplete: boolean
  models: ModelUsageGroup[]
}

export interface WorkflowRanking {
  workflowRef: string
  workflowName: string
  workspaceId: string
  workspaceName: string
  totalTokens: number
  totalCostUsd: number | null
  costComplete: boolean
  models: ModelUsageGroup[]
}

export interface ModelRanking {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number | null
  costComplete: boolean
}

export interface LeaderboardResponse {
  byWorkspace: WorkspaceRanking[]
  byWorkflow: ExecutionRanking[]
  byModel: ModelRanking[]
}

// ============ Observability ============

export interface AgentTraceEvent {
  node_execution_id: string
  event_order: number
  turn_index: number
  event_type: string
  timestamp: number
  content?: string
  content_length?: number
  tool_call_id?: string
  tool_name?: string
  tool_input?: string
  tool_result?: string
  tool_is_error?: number
  tool_duration_ms?: number
  status_value?: string
  error_code?: string
  error_message?: string
  node_id?: string
}

export interface TurnGroup {
  turn_index: number
  events: AgentTraceEvent[]
  eventCount: number
}

export interface NodeTraceData {
  node_execution_id: string
  node_id?: string
  turns: TurnGroup[]
}

export interface LLMCallData {
  id: string
  node_execution_id: string
  execution_id: string
  turn_index: number
  call_index: number
  message_id?: string
  model?: string
  stop_reason?: string
  timestamp: number
  duration_ms: number
  ttft_ms?: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd?: number
}

export interface LLMCallAggregates {
  totalCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCost: number
  cacheHitRate: number
  modelBreakdown: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>
}

// ============ Analytics ============

export interface WorkspaceAnalytics {
  totalExecutions: number
  successRate: number
  totalCost: number
  avgDurationMs: number
  days: number
}

export interface WorkflowAnalytics {
  workflowRef: string
  healthScore: number
  grade: string
  totalExecutions: number
  successRate: number
  avgDurationMs: number
  totalCost: number
  avgCostPerRun: number
  healthDimensions: {
    success: number
    speedStability: number
    costEfficiency: number
    tokenEfficiency: number
    reliability: number
  }
}

export interface CostAnalysisData {
  totalCost: number
  totalCalls: number
  days: number
}

// ============ SuggestionEngine ============

export interface OptimizationSuggestion {
  id: string
  workspace_id: string
  workflow_ref: string
  rule_name: string
  node_id?: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  detection: string
  diagnosis: string
  prescription: string
  impact_estimate?: string
  status: 'pending' | 'applied' | 'dismissed'
  applied_at?: string
  applied_changes?: string
  created_at: string
}

// ============ Scheduler Types ============

export interface Schedule {
  id: string
  workspace_id: string
  name: string
  workflow_ref: string
  cron_expression: string
  timezone: string
  input_values: Record<string, string>
  enabled: boolean
  timeout_seconds: number
  notify_on_failure: boolean
  notify_channel: string | null
  notify_target: string | null
  container_execution_id: string | null
  missed_alert_dismissed_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  next_trigger_at: string | null
  cron_description?: string
  workflow_exists?: boolean
  running_execution_count?: number
  missed_execution_count?: number
}

export interface ScheduleExecution {
  id: string
  schedule_id: string
  execution_id: string | null
  status: 'triggered' | 'running' | 'completed' | 'failed' | 'skipped' | 'missed'
  trigger_type: 'scheduled' | 'manual' | 'retry'
  triggered_at: string
  timezone_offset: string
  timezone_iana: string
  duration_ms: number | null
  skip_reason: string | null
  missed_reason: string | null
  retry_of: string | null
  error_summary: string | null
  created_at: string
  completed_at: string | null
}

export interface ScheduleAuditLog {
  id: string
  action: 'created' | 'updated' | 'deleted' | 'enabled' | 'disabled' | 'emergency_stop'
  actor_id: string | null
  actor_name: string
  schedule_id: string | null
  schedule_name: string | null
  workspace_id: string
  changes: Record<string, { before: unknown; after: unknown }> | null
  created_at: string
}

export interface SchedulePermissions {
  canCreate: boolean
  canEdit: boolean
  canDelete: boolean
  canEnableDisable: boolean
  canTrigger: boolean
  canEmergencyStop: boolean
  canViewAuditLogs: boolean
}

export interface CreateScheduleInput {
  name: string
  workflow_ref: string
  cron_expression: string
  timezone: string
  input_values?: Record<string, string>
  timeout_seconds?: number
  notify_on_failure?: boolean
  notify_channel?: string
  notify_target?: string
}

export type UpdateScheduleInput = Partial<CreateScheduleInput>

export interface CronParseResult {
  valid: boolean
  description: string
  nextExecutions: string[]
  error?: string
}

export interface NaturalLanguageCronResult {
  expression: string
  description: string
  nextExecutions: string[]
  confidence: 'high' | 'medium' | 'error'
  error?: string
}

// ============ Agent Events & Loop Iterations (PRD-001) ============

export type MergedEventType =
  | "thinking_block" | "text_block" | "tool_call"
  | "bash_output" | "bash_stderr"
  | "python_output" | "python_stderr"
  | "branch_start" | "branch_end"

export const MERGED_EVENT_TYPES: Set<string> = new Set([
  "thinking_block", "text_block", "tool_call",
  "bash_output", "bash_stderr", "python_output", "python_stderr",
  "branch_start", "branch_end",
])

export function isMergedEvent(entry: { event: string }): boolean {
  return MERGED_EVENT_TYPES.has(entry.event)
}

export interface AgentEvent {
  nodeId: string
  event: string
  timestamp?: string
  iteration?: number
  // Merged event fields
  startedAt?: string
  completedAt?: string
  content?: string
  lines?: string[]
  toolCallId?: string
  toolName?: string
  input?: unknown
  result?: string
  isError?: boolean
  // Legacy compat
  type?: string
  line?: string
  status?: string
  durationMs?: number
  exitCode?: number
  event_data?: {
    type: string
    content?: string
    toolCallId?: string
    toolName?: string
    input?: unknown
    isError?: boolean
    duration?: string
    status?: string
    code?: string
    message?: string
  }
}

export interface AgentEventsResponse {
  executionId: string
  events: AgentEvent[]
  source: "sqlite" | "jsonl"
  _degraded: boolean
  _message: string | null
  loopIterations?: Record<string, LoopIterationSummary>
}

export interface LoopIterationSummary {
  total?: number
  completed: number
  failed: number
  current?: number
  mode: "fixed" | "dynamic"
  iterations: IterationDetail[]
}

export interface IterationDetail {
  iteration: number
  status: "pending" | "running" | "completed" | "failed"
  startedAt?: string
  completedAt?: string
  durationMs?: number
  error?: string
  nodes: IterationNodeResult[]
}

export interface IterationNodeResult {
  nodeId: string
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  durationMs?: number
  error?: string
}
