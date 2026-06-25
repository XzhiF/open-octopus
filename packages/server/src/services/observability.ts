import Database from "better-sqlite3"
import type { AgentEvent } from "@octopus/engine"
import type { LLMCallRecord } from "@octopus/providers"
import { PrivacyFilter } from "./privacy-filter"
import { computeCost } from "@octopus/providers"
import { ExecutionDAO, TokenUsageDAO } from "../db/dao"
import type { AgentEventRow, LlmCallRow } from "../db/types"

interface FilteredAgentEvent {
  type: string
  timestamp: number
  content?: string
  contentLength?: number
  toolCallId?: string
  toolName?: string
  toolInput?: string
  toolResult?: string
  toolIsError?: boolean
  toolDurationMs?: number
  statusValue?: string
  errorCode?: string
  errorMessage?: string
  turnIndex: number
}

interface EventMeta {
  executionId: string
  nodeId: string
  org: string
  workspaceId: string
  workflowRef: string
  sessionId?: string
}

interface NodeBuffer {
  events: FilteredAgentEvent[]
  meta: EventMeta
  turnIndex: number
  lastEventOrder: number
  timer: ReturnType<typeof setTimeout> | null
}

function computeTurnIndex(eventType: string, currentTurn: number): number {
  if (eventType === 'thinking_start') {
    return currentTurn + 1
  }
  if (currentTurn === 0) {
    return 1
  }
  return currentTurn
}

export interface ObservabilitySink {
  writeBatch(events: FilteredAgentEvent[], nodeExecId: string): Promise<void>
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export class SQLiteSink implements ObservabilitySink {
  private execDao: ExecutionDAO

  constructor(execDaoOrDb: ExecutionDAO | Database.Database) {
    if (execDaoOrDb instanceof ExecutionDAO) {
      this.execDao = execDaoOrDb
    } else {
      this.execDao = new ExecutionDAO(execDaoOrDb)
    }
  }

  async writeBatch(events: FilteredAgentEvent[], nodeExecId: string): Promise<void> {
    if (events.length === 0) return

    const rows: AgentEventRow[] = events.map((event, i) => ({
      node_execution_id: nodeExecId,
      event_order: i + 1,
      turn_index: event.turnIndex,
      event_type: event.type,
      timestamp: event.timestamp,
      content: event.content ?? null,
      content_length: event.contentLength ?? 0,
      tool_call_id: event.toolCallId ?? null,
      tool_name: event.toolName ?? null,
      tool_input: event.toolInput ?? null,
      tool_result: event.toolResult ?? null,
      tool_is_error: event.toolIsError ? 1 : 0,
      tool_duration_ms: event.toolDurationMs ?? null,
      status_value: event.statusValue ?? null,
      error_code: event.errorCode ?? null,
      error_message: event.errorMessage ?? null,
    }))

    this.execDao.insertAgentEventBatch(rows)
  }

  async writeLLMCalls(calls: LlmCallRow[]): Promise<void> {
    if (calls.length === 0) return
    // writeLLMCalls uses a separate TokenUsageDAO — caller should use the ObservabilityService method instead
    // Kept for interface compatibility; batch LLM insert is done via ObservabilityService.persistLLMCalls
  }

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export class ObservabilityService {
  private execDao: ExecutionDAO
  private tokenDao: TokenUsageDAO
  private buffers = new Map<string, NodeBuffer>()
  private consecutiveErrors = 0
  private degraded = false
  private privacyFilter: PrivacyFilter
  private sink: SQLiteSink

  constructor(execDao: ExecutionDAO, tokenDao: TokenUsageDAO, privacyFilter?: PrivacyFilter) {
    this.execDao = execDao
    this.tokenDao = tokenDao
    this.privacyFilter = privacyFilter ?? new PrivacyFilter()
    this.sink = new SQLiteSink(this.execDao)
  }

  bufferEvent(nodeExecId: string, event: AgentEvent, meta: EventMeta): void {
    if (this.degraded) return

    let buf = this.buffers.get(nodeExecId)
    if (!buf) {
      buf = { events: [], meta, turnIndex: 0, lastEventOrder: 0, timer: null }
      this.buffers.set(nodeExecId, buf)
    }

    buf.turnIndex = computeTurnIndex(event.type, buf.turnIndex)

    const filtered = this.filterEvent(event, buf.turnIndex)
    buf.events.push(filtered)

    if (buf.events.length >= 50) {
      this.flushNode(nodeExecId)
    } else if (!buf.timer) {
      buf.timer = setTimeout(() => this.flushNode(nodeExecId), 2000)
    }
  }

  flushNode(nodeExecId: string): void {
    const buf = this.buffers.get(nodeExecId)
    if (!buf || buf.events.length === 0) return

    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null }

    const events = buf.events.splice(0)
    buf.lastEventOrder += events.length

    try {
      const rows: AgentEventRow[] = events.map((event, i) => ({
        node_execution_id: nodeExecId,
        event_order: buf.lastEventOrder - events.length + i + 1,
        turn_index: event.turnIndex,
        event_type: event.type,
        timestamp: event.timestamp,
        content: event.content ?? null,
        content_length: event.contentLength ?? 0,
        tool_call_id: event.toolCallId ?? null,
        tool_name: event.toolName ?? null,
        tool_input: event.toolInput ?? null,
        tool_result: event.toolResult ?? null,
        tool_is_error: event.toolIsError ? 1 : 0,
        tool_duration_ms: event.toolDurationMs ?? null,
        status_value: event.statusValue ?? null,
        error_code: event.errorCode ?? null,
        error_message: event.errorMessage ?? null,
      }))

      this.execDao.insertAgentEventBatch(rows)
      this.consecutiveErrors = 0
    } catch (error) {
      this.consecutiveErrors++
      if (this.consecutiveErrors >= 10) {
        this.degraded = true
      }
      console.error(`[Observability] flushNode failed for ${nodeExecId}:`, error)
    }
  }

  flushExecution(executionId: string): void {
    for (const [nodeExecId] of this.buffers) {
      if (nodeExecId.startsWith(executionId + '-')) {
        this.flushNode(nodeExecId)
      }
    }
  }

  persistLLMCalls(
    nodeExecId: string,
    executionId: string,
    calls: LLMCallRecord[],
    instanceId: string
  ): void {
    const meta = this.buffers.get(nodeExecId)?.meta
    if (!meta) return

    try {
      const rows: LlmCallRow[] = calls.map((call, i) => ({
        id: crypto.randomUUID(),
        node_execution_id: nodeExecId,
        execution_id: executionId,
        turn_index: call.turnIndex,
        call_index: i,
        message_id: call.messageId ?? null,
        model: call.model ?? null,
        stop_reason: call.stopReason ?? null,
        timestamp: call.timestamp,
        duration_ms: call.durationMs,
        ttft_ms: call.ttftMs ?? null,
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
        cache_read_tokens: call.cacheReadTokens,
        cache_creation_tokens: call.cacheCreationTokens,
        cost_usd: call.costUsd ?? computeCost(call, call.model ?? 'default'),
        org: meta.org,
        workspace_id: meta.workspaceId,
        workflow_ref: meta.workflowRef,
        node_id: meta.nodeId,
        session_id: meta.sessionId ?? null,
        instance_id: instanceId,
      }))

      this.tokenDao.insertLlmCallBatch(rows)
    } catch {
      // silent — observability never blocks execution
    }
  }

  isDegraded(): boolean {
    return this.degraded
  }

  resetDegraded(): void {
    this.degraded = false
    this.consecutiveErrors = 0
  }

  shutdown(): void {
    for (const [nodeExecId] of this.buffers) {
      this.flushNode(nodeExecId)
    }
  }

  private filterEvent(event: AgentEvent, turnIndex: number): FilteredAgentEvent {
    const base: FilteredAgentEvent = {
      type: event.type,
      timestamp: event.timestamp,
      turnIndex,
    }

    switch (event.type) {
      case 'thinking':
      case 'thinking_done': {
        const content = event.type === 'thinking' ? event.content : undefined
        if (content) {
          const filtered = this.privacyFilter.filterContent(content)
          base.content = filtered.content
          base.contentLength = filtered.contentLength
        }
        break
      }
      case 'tool_start':
        base.toolCallId = event.toolCallId
        base.toolName = event.toolName
        break
      case 'tool_input':
        base.toolCallId = event.toolCallId
        base.toolName = event.toolName
        if (event.input) {
          const inputStr = typeof event.input === 'string' ? event.input : JSON.stringify(event.input)
          base.toolInput = this.privacyFilter.filterToolInput(inputStr)
        }
        break
      case 'tool_result': {
        base.toolCallId = event.toolCallId
        const filtered = this.privacyFilter.filterToolResult(event.content)
        base.toolResult = filtered
        base.toolIsError = event.isError ?? false
        if (event.duration) {
          const ms = parseFloat(event.duration)
          base.toolDurationMs = isNaN(ms) ? undefined : Math.round(ms * 1000)
        }
        break
      }
      case 'text_delta': {
        const filtered = this.privacyFilter.filterContent(event.content)
        base.content = filtered.content
        base.contentLength = filtered.contentLength
        break
      }
      case 'status':
        base.statusValue = event.status
        break
      case 'error':
        base.errorCode = event.code
        base.errorMessage = event.message
        break
    }

    return base
  }
}
