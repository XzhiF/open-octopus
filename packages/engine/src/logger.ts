import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs"
import { join } from "path"

/** Event types produced by the merge algorithm. */
export type MergedEventType =
  | "thinking_block"
  | "text_block"
  | "tool_call"
  | "bash_output"
  | "bash_stderr"
  | "python_output"
  | "python_stderr"

/** Set of merged event type strings — used to detect already-compacted entries. */
export const MERGED_EVENT_TYPES: Set<string> = new Set<MergedEventType>([
  "thinking_block",
  "text_block",
  "tool_call",
  "bash_output",
  "bash_stderr",
  "python_output",
  "python_stderr",
])

/** Returns true if the entry is a merged (compacted) event. */
export function isMergedEvent(entry: { event: string }): boolean {
  return MERGED_EVENT_TYPES.has(entry.event)
}

/** Sanitize a node ID for use in filenames. Replaces unsafe chars and escapes -iter-N suffix. */
export function sanitizeId(id: string): string {
  let safe = id.replace(/[^a-zA-Z0-9_-]/g, "_")
  // Escape -iter-N suffix to prevent filename collision with loop iteration files
  safe = safe.replace(/-iter-\d+$/, "_escaped")
  return safe
}

export interface ParsedLogFilename {
  loopId?: string
  iteration?: number
  nodeId: string
}

/** Parse a JSONL log filename to extract loop/iteration/node information. */
export function parseLogFilename(filename: string): ParsedLogFilename {
  const base = filename.replace('.jsonl', '')
  const lastSep = base.lastIndexOf('__')
  if (lastSep === -1) return { nodeId: base }
  const prefix = base.substring(0, lastSep)
  const nodeId = base.substring(lastSep + 2)
  const iterMatch = prefix.match(/^(.+)-iter-(\d+)$/)
  if (iterMatch) {
    return { loopId: iterMatch[1], iteration: parseInt(iterMatch[2], 10), nodeId }
  }
  // Has __ but not a loop iteration file — treat entire base as nodeId
  return { nodeId: base }
}

export class JsonlLogger {
  private logDir: string
  private loopNodeId?: string
  private iteration?: number

  constructor(orgDir: string, executionId: string) {
    this.logDir = join(orgDir, "logs", executionId)
    mkdirSync(this.logDir, { recursive: true })
  }

  /** Set loop context so subsequent log() calls write to iteration-scoped files. Returns previous context for nesting. */
  setLoopContext(loopNodeId: string, iteration: number): { loopNodeId: string | undefined; iteration: number | undefined } {
    const prev = { loopNodeId: this.loopNodeId, iteration: this.iteration }
    this.loopNodeId = loopNodeId
    this.iteration = iteration
    return prev
  }

  /** Restore a previously saved loop context — supports nested loops. */
  restoreLoopContext(saved: { loopNodeId: string | undefined; iteration: number | undefined }): void {
    this.loopNodeId = saved.loopNodeId
    this.iteration = saved.iteration
  }

  /** Resolve the JSONL file path for a given node, considering loop context. */
  private getLogFilePath(nodeId: string): string {
    if (this.loopNodeId && this.iteration !== undefined) {
      const safeLoopId = sanitizeId(this.loopNodeId)
      const safeNodeId = sanitizeId(nodeId)
      return join(this.logDir, `${safeLoopId}-iter-${this.iteration}__${safeNodeId}.jsonl`)
    }
    return join(this.logDir, `${sanitizeId(nodeId)}.jsonl`)
  }

  log(nodeId: string, event: string, data: Record<string, any>): void {
    // Strip event_data.timestamp — redundant with outer ISO timestamp; SSE path still carries it
    const filteredData: Record<string, any> = {}
    for (const [key, value] of Object.entries(data)) {
      if (key === "event_data" && value && typeof value === "object") {
        const { timestamp: _, ...rest } = value
        filteredData[key] = rest
      } else {
        filteredData[key] = value
      }
    }

    const entry: Record<string, any> = {
      timestamp: new Date().toISOString(),
      nodeId,
      event,
      ...filteredData,
    }

    // Add iteration field when loop context is active
    if (this.loopNodeId && this.iteration !== undefined) {
      entry.iteration = this.iteration
    }

    appendFileSync(
      this.getLogFilePath(nodeId),
      JSON.stringify(entry) + "\n",
    )
  }

  /**
   * Log a swarm-specific event to the JSONL log.
   * Event types: expert_spawn, expert_message, expert_complete,
   *              consensus_check, swarm_round_end, swarm_complete
   */
  logSwarmEvent(nodeId: string, event: string, data: Record<string, any>): void {
    this.log(nodeId, event, data)
  }

  getLogDir(): string {
    return this.logDir
  }

  // ── JSONL compaction ──────────────────────────────────────

  /**
   * Compact a node's JSONL log by merging related event fragments.
   * Reads → parses → merges → writes back (with .bak safety net).
   * Returns the merged events array on success (for SQLite sync), or null on failure.
   * Uses getLogFilePath() to respect loop iteration context.
   */
  compactFile(nodeId: string): any[] | null {
    const filePath = this.getLogFilePath(nodeId)
    const bakPath = `${filePath}.bak`

    try {
      if (!existsSync(filePath)) return null

      const content = readFileSync(filePath, "utf8")
      const entries: any[] = []
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        try {
          entries.push(JSON.parse(line))
        } catch {
          // skip malformed lines
        }
      }

      const merged = this.mergeEvents(entries)

      // backup → write → delete backup
      renameSync(filePath, bakPath)
      try {
        writeFileSync(filePath, merged.map(e => JSON.stringify(e)).join("\n") + "\n")
        unlinkSync(bakPath)
      } catch (writeErr) {
        // restore from backup on write failure
        try { renameSync(bakPath, filePath) } catch { /* already lost */ }
        throw writeErr
      }
      return merged
    } catch (err) {
      console.warn(`[JsonlLogger] compactFile failed for ${nodeId}:`, err)
      return null
    }
  }

  /**
   * Merge related JSONL event fragments into compact blocks.
   *
   * Rules:
   * - thinking_start + thinking* + thinking_done → thinking_block
   * - consecutive text_delta → text_block
   * - tool_start + tool_input + tool_result → tool_call
   * - consecutive bash_log → bash_output
   * - consecutive bash_stderr → bash_stderr (merged)
   * - consecutive python_log → python_output
   * - consecutive python_stderr → python_stderr (merged)
   * - start / end / branch_start / branch_end pass through unchanged
   * - already-merged events pass through (idempotent)
   */
  private mergeEvents(entries: any[]): any[] {
    return mergeAgentEvents(entries)
  }
}

/**
 * Merge related event fragments into compact blocks.
 * Standalone function for reuse in server-side SQLite merge.
 */
export function mergeAgentEvents(entries: any[]): any[] {
    const results: any[] = []
    let block: any = null

    const closeBlock = () => {
      if (!block) return
      const { type: _type, ...emitted } = block
      results.push(emitted)
      block = null
    }

    for (const entry of entries) {
      const topEvent: string = entry.event ?? ""

      // Pass-through: lifecycle markers
      if (topEvent === "start" || topEvent === "end" ||
          topEvent === "branch_start" || topEvent === "branch_end") {
        closeBlock()
        results.push(entry)
        continue
      }

      // Pass-through: already-merged block-shaped events (idempotent)
      // Note: bash_stderr/python_stderr are NOT here — they are also raw top-level events
      if (topEvent === "thinking_block" || topEvent === "text_block" ||
          topEvent === "tool_call" || topEvent === "bash_output" ||
          topEvent === "python_output") {
        closeBlock()
        results.push(entry)
        continue
      }

      // ── agent_event fragments ───────────────────────────
      if (topEvent === "agent_event") {
        const ed = entry.event_data
        const subType: string = ed?.type ?? ""

        if (subType === "thinking_start") {
          closeBlock()
          block = {
            type: "thinking",
            event: "thinking_block",
            nodeId: entry.nodeId,
            content: "",
            startedAt: entry.timestamp,
            completedAt: entry.timestamp,
            iteration: entry.iteration,
          }
          continue
        }

        if (subType === "thinking") {
          if (!block || block.type !== "thinking") {
            // Resilient: SQLite data may lack thinking_start
            closeBlock()
            block = {
              type: "thinking",
              event: "thinking_block",
              nodeId: entry.nodeId,
              content: "",
              startedAt: entry.timestamp,
              completedAt: entry.timestamp,
              iteration: entry.iteration,
            }
          }
          if (block?.type === "thinking") {
            block.content += (ed?.content ?? "")
            block.completedAt = entry.timestamp
          }
          continue
        }

        if (subType === "thinking_done") {
          if (block?.type === "thinking") {
            block.completedAt = entry.timestamp
            closeBlock()
          }
          continue
        }

        if (subType === "text_delta") {
          if (block?.type !== "text") {
            closeBlock()
            block = {
              type: "text",
              event: "text_block",
              nodeId: entry.nodeId,
              content: "",
              startedAt: entry.timestamp,
              completedAt: entry.timestamp,
              iteration: entry.iteration,
            }
          }
          block.content += (ed?.content ?? "")
          block.completedAt = entry.timestamp
          continue
        }

        if (subType === "tool_start") {
          closeBlock()
          block = {
            type: "tool",
            event: "tool_call",
            nodeId: entry.nodeId,
            toolCallId: ed?.tool_use_id ?? ed?.toolCallId ?? "",
            toolName: ed?.tool ?? ed?.name ?? ed?.toolName ?? "",
            input: "",
            result: null,
            isError: false,
            startedAt: entry.timestamp,
            completedAt: entry.timestamp,
            iteration: entry.iteration,
          }
          continue
        }

        if (subType === "tool_input") {
          if (!block || block.type !== "tool") {
            // Resilient: SQLite data may lack tool_start
            closeBlock()
            block = {
              type: "tool",
              event: "tool_call",
              nodeId: entry.nodeId,
              toolCallId: ed?.tool_call_id ?? ed?.toolCallId ?? "",
              toolName: ed?.tool ?? ed?.name ?? ed?.toolName ?? "",
              input: "",
              result: null,
              isError: false,
              startedAt: entry.timestamp,
              completedAt: entry.timestamp,
              iteration: entry.iteration,
            }
          }
          if (block?.type === "tool") {
            if (ed?.input !== undefined) {
              block.input = typeof ed.input === "string" ? ed.input : JSON.stringify(ed.input)
            }
            if (ed?.toolCallId) block.toolCallId = ed.toolCallId
            if (ed?.tool) block.toolName = ed.tool
            block.completedAt = entry.timestamp
          }
          continue
        }

        if (subType === "tool_result") {
          if (!block || block.type !== "tool") {
            // Resilient: SQLite data may lack tool_start/tool_input
            closeBlock()
            block = {
              type: "tool",
              event: "tool_call",
              nodeId: entry.nodeId,
              toolCallId: ed?.tool_call_id ?? ed?.toolCallId ?? "",
              toolName: ed?.tool ?? ed?.name ?? ed?.toolName ?? "",
              input: "",
              result: null,
              isError: false,
              startedAt: entry.timestamp,
              completedAt: entry.timestamp,
              iteration: entry.iteration,
            }
          }
          if (block?.type === "tool") {
            block.result = ed?.content ?? ed?.result ?? null
            block.isError = ed?.is_error ?? ed?.isError ?? false
            block.completedAt = entry.timestamp
            closeBlock()
          }
          continue
        }

        // Unknown agent_event subtype → close any open block, pass through
        closeBlock()
        results.push(entry)
        continue
      }

      // ── bash_log → bash_output ─────────────────────────
      if (topEvent === "bash_log") {
        if (block?.type !== "bash_output") {
          closeBlock()
          block = {
            type: "bash_output",
            event: "bash_output",
            nodeId: entry.nodeId,
            lines: [],
            startedAt: entry.timestamp,
            completedAt: entry.timestamp,
            iteration: entry.iteration,
          }
        }
        block.lines.push(entry.line ?? "")
        block.completedAt = entry.timestamp
        continue
      }

      // ── bash_stderr → bash_stderr ──────────────────────
      if (topEvent === "bash_stderr") {
        if (block?.type !== "bash_stderr") {
          closeBlock()
          block = {
            type: "bash_stderr",
            event: "bash_stderr",
            nodeId: entry.nodeId,
            content: "",
            startedAt: entry.timestamp,
            completedAt: entry.timestamp,
            iteration: entry.iteration,
          }
        }
        block.content += (entry.line ?? "")
        block.completedAt = entry.timestamp
        continue
      }

      // ── python_log → python_output ─────────────────────
      if (topEvent === "python_log") {
        if (block?.type !== "python_output") {
          closeBlock()
          block = {
            type: "python_output",
            event: "python_output",
            nodeId: entry.nodeId,
            lines: [],
            startedAt: entry.timestamp,
            completedAt: entry.timestamp,
            iteration: entry.iteration,
          }
        }
        block.lines.push(entry.line ?? "")
        block.completedAt = entry.timestamp
        continue
      }

      // ── python_stderr → python_stderr ──────────────────
      if (topEvent === "python_stderr") {
        if (block?.type !== "python_stderr") {
          closeBlock()
          block = {
            type: "python_stderr",
            event: "python_stderr",
            nodeId: entry.nodeId,
            content: "",
            startedAt: entry.timestamp,
            completedAt: entry.timestamp,
            iteration: entry.iteration,
          }
        }
        block.content += (entry.line ?? "")
        block.completedAt = entry.timestamp
        continue
      }

      // ── Unknown event → close block, pass through ──────
      closeBlock()
      results.push(entry)
    }

    closeBlock()
    return results
}
