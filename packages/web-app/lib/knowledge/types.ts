// ============ 知识 UI 类型（票09 收口后余量）============
// 旧知识/审核面类型（KnowledgeFile*、Review*、PendingItem 转出口）随 /experience
// 整页与审批链退役删除；此处只留 workspace 归档流共享件（ArchiveDialog /
// ExecutionSummaryPanel / KnowledgeAssistantPanel）消费的三个响应类型。

export interface ArchiveSummaryResponse {
  executionId: string
  nodes: Array<{
    id: string
    status: 'completed' | 'failed' | 'skipped'
    durationMs: number
    exitCode: number | null
    lastOutput: string | null
  }>
  reviewBlockers: string[]
  e2eResults: string
  poolSnapshot: Record<string, string> | null
}

export interface ArchiveProposeResponse {
  rules: Array<{
    text: string
    scope: string
    target: string
    conflicts: Array<{ existingRule: string; conflictType: string }> | null
  }>
  pendingCount: number
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  suggestion?: string
}
