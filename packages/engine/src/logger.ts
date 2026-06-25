import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"

export class JsonlLogger {
  private logDir: string

  constructor(orgDir: string, executionId: string) {
    this.logDir = join(orgDir, "logs", executionId)
    mkdirSync(this.logDir, { recursive: true })
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

    const entry = {
      timestamp: new Date().toISOString(),
      nodeId,
      event,
      ...filteredData,
    }
    appendFileSync(
      join(this.logDir, `${nodeId}.jsonl`),
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
}