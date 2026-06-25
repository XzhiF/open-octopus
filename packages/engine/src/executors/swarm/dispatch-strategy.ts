import { SwarmStrategy } from "./swarm-strategy"
import type { SwarmServices, ExpertOutput } from "./swarm-strategy"
import type { SwarmResult, ExpertResult, TaskBreakdown, FileConflict } from "./swarm-types"
import type { ExpertDef } from "@octopus/shared"
import type { MessageBus } from "./message-bus"
import type { SharedMemory } from "./shared-memory"
import { buildDAG } from "./dag-builder"
import { SSE_SYNTHESIS_PREVIEW_CHARS } from "./swarm-constants"
import type { ContextTierResolver } from "./context-tier-resolver"

/**
 * DispatchStrategy — DAG-based expert execution with dependency resolution.
 *
 * Experts are organized into levels by the DAG builder. Levels execute sequentially,
 * but experts within a level run in parallel. If an expert's dependency fails,
 * the dependent expert is skipped (or the whole execution fails with fail_fast).
 */
export class DispatchStrategy extends SwarmStrategy {
  async run(experts: ExpertDef[], bus: MessageBus, memory: SharedMemory): Promise<SwarmResult> {
    const dag = buildDAG(experts)
    const expertMap = new Map(experts.map(e => [e.role, e]))
    const expertResults: ExpertResult[] = []
    const failedExperts: string[] = []
    const skippedExperts: string[] = []

    // Hook: swarm_start
    this.services.triggerHook("on_swarm_start", {
      nodeId: this.config.nodeId,
      mode: "dispatch",
      expertCount: experts.length,
      topic: this.config.topic,
      dagLevels: dag.levels.length,
    })

    // Execute by levels
    for (let levelIdx = 0; levelIdx < dag.levels.length; levelIdx++) {
      const level = dag.levels[levelIdx]
      const budget = this.services.checkBudget()
      if (budget.status === "exhausted") break

      const levelExperts = level.map(role => expertMap.get(role)!).filter(Boolean)

      const levelPromises = levelExperts.map(async (expert): Promise<ExpertResult> => {
        // Check if any dependency failed -> skip this expert
        if (expert.depends_on) {
          for (const dep of expert.depends_on) {
            const depResult = expertResults.find(r => r.role === dep)
            if (depResult && (depResult.status === "failed" || depResult.status === "skipped")) {
              skippedExperts.push(expert.role)
              return {
                role: expert.role,
                status: "skipped",
                output: "",
                rounds: 1,
                tools_used: [],
                files_changed: [],
                source: "predefined",
                attempts: 0,
                error: `Dependency "${dep}" failed`,
              }
            }
          }
        }

        // Build prompt with full upstream context (structured summaries + direct detail)
        const upstreamContext = buildFullUpstreamContext(expert, expertResults, this.config.contextTier)

        const prompt = this.buildDispatchPrompt(expert, this.config.topic, upstreamContext)

        try {
          // Hook: expert_spawn
          this.services.triggerHook("on_expert_spawn", {
            nodeId: this.config.nodeId,
            role: expert.role,
            round: 1,
          })

          const result = await this.services.runExpert(expert, prompt, 1)

          // Hook: expert_complete
          this.services.triggerHook("on_expert_complete", {
            nodeId: this.config.nodeId,
            role: expert.role,
            round: 1,
            status: "completed",
            tokens: result.tokens,
          })

          bus.send({
            from: expert.role,
            to: "*",
            round: 1,
            content: result.output,
            timestamp: Date.now(),
          })

          this.services.emit({
            type: "expert_message",
            data: {
              nodeId: this.config.nodeId,
              role: expert.role,
              round: 1,
              content: result.output,
              tokens: result.tokens,
            },
          })

          return {
            role: expert.role,
            status: "completed",
            output: result.output,
            rounds: 1,
            tools_used: result.tools_used,
            files_changed: result.files_changed,
            source: "predefined",
            attempts: 1,
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          failedExperts.push(expert.role)

          // Hook: expert_complete (failed)
          this.services.triggerHook("on_expert_complete", {
            nodeId: this.config.nodeId,
            role: expert.role,
            round: 1,
            status: "failed",
            error: message,
          })

          if (this.config.failurePolicy === "fail_fast") {
            throw e
          }

          return {
            role: expert.role,
            status: "failed",
            output: "",
            rounds: 1,
            tools_used: [],
            files_changed: [],
            source: "predefined",
            attempts: 1,
            error: message,
          }
        }
      })

      const results = await Promise.allSettled(levelPromises)
      for (const r of results) {
        if (r.status === "fulfilled") {
          expertResults.push(r.value)
        }
      }

      // fail_fast: stop execution if any expert in this level failed
      if (this.config.failurePolicy === "fail_fast" && results.some(r => r.status === "rejected")) {
        break
      }
    }

    // Final synthesis
    const hostOutput = await this.services.runHost({
      expertOutputs: expertResults,
      messages: bus.getAll(),
      outputFormat: this.config.outputFormat,
      mode: "dispatch",
      topic: this.config.topic,
      host: this.config.host,
    })

    const taskBreakdown: TaskBreakdown = {
      topic: this.config.topic,
      mode: "dispatch",
      dag: { levels: dag.levels },
      experts: experts.map(e => ({ role: e.role, task: e.task || e.prompt || "" })),
    }

    const budgetStatus = this.services.checkBudget()

    // Detect file conflicts: same file modified by multiple experts
    const fileToExperts = new Map<string, string[]>()
    for (const r of expertResults) {
      if (r.status === "completed") {
        for (const f of r.files_changed) {
          const list = fileToExperts.get(f) ?? []
          list.push(r.role)
          fileToExperts.set(f, list)
        }
      }
    }
    const fileConflicts: FileConflict[] = []
    for (const [file, experts] of fileToExperts) {
      if (experts.length > 1) {
        fileConflicts.push({ file, experts, resolution: "manual" })
      }
    }

    // All experts failed → status "failed"
    const allFailed = experts.length > 0 && failedExperts.length === experts.length
    const result: SwarmResult = {
      synthesis: hostOutput.synthesis,
      consensus_score: null,
      rounds_used: 1,
      expert_count: experts.length,
      experts: expertResults,
      history: bus.getAll(),
      task_breakdown: taskBreakdown,
      budget_exhausted: budgetStatus.status === "exhausted",
      timeout_exceeded: false,
      context_overflow: false,
      host_degraded: false,
      failed_experts: failedExperts,
      skipped_experts: skippedExperts,
      file_conflicts: fileConflicts,
      status:
        allFailed
          ? "failed"
          : budgetStatus.status === "exhausted"
            ? "budget_exhausted"
            : failedExperts.length > 0 && this.config.failurePolicy === "fail_fast"
              ? "failed"
              : "completed",
    }

    // Emit swarm_complete SSE event
    this.services.emit({
      type: "swarm_complete",
      data: {
        nodeId: this.config.nodeId,
        mode: "dispatch",
        status: result.status,
        synthesis: result.synthesis.slice(0, SSE_SYNTHESIS_PREVIEW_CHARS),
        result: {
          consensus_score: result.consensus_score,
          rounds_used: result.rounds_used,
          expert_count: result.expert_count,
          budget_exhausted: result.budget_exhausted,
          timeout_exceeded: result.timeout_exceeded,
          host_degraded: result.host_degraded,
          failed_experts: result.failed_experts,
          skipped_experts: result.skipped_experts,
        },
      },
    })

    // Hook: swarm_complete
    this.services.triggerHook("on_swarm_complete", {
      nodeId: this.config.nodeId,
      status: result.status,
      roundsUsed: result.rounds_used,
      expertCount: result.expert_count,
      fileConflicts: fileConflicts.length,
    })

    return result
  }

  private buildDispatchPrompt(expert: ExpertDef, topic: string, upstreamContext: string): string {
    let prompt = `You are an expert: ${expert.role}`
    if (expert.task) prompt += `\nTask: ${expert.task}`
    prompt += `\n\n===USER TOPIC START===\n${topic}\n===USER TOPIC END===`
    if (upstreamContext) prompt += `\n\n## Upstream Expert Outputs\n${upstreamContext}`

    prompt += `\n\n## Output Requirement
At the end of your output, append a structured summary block for downstream experts:
\`\`\`summary
{
  "decisions": ["your core decisions, one sentence each"],
  "key_numbers": ["key numbers, budgets, timelines, and constraints"],
  "downstream_notes": ["information downstream experts need to know"],
  "risks": ["risks or issues you identified"]
}
\`\`\``
    return prompt
  }
}

/**
 * Extract structured context from an expert's output for downstream consumption.
 * Priority: structured summary block > head+tail fallback > full output (if short)
 */
function extractDispatchContext(output: string, role: string, tier: ContextTierResolver): string {
  // Try to extract structured summary block
  const summaryMatch = output.match(/```summary\n([\s\S]*?)\n```/)
  if (summaryMatch) {
    try {
      const parsed = JSON.parse(summaryMatch[1])
      const parts: string[] = []
      if (parsed.decisions?.length)
        parts.push(`**Decisions:** ${parsed.decisions.join("; ")}`)
      if (parsed.key_numbers?.length)
        parts.push(`**Key numbers:** ${parsed.key_numbers.join("; ")}`)
      if (parsed.downstream_notes?.length)
        parts.push(`**Downstream notes:** ${parsed.downstream_notes.join("; ")}`)
      if (parsed.risks?.length)
        parts.push(`**Risks:** ${parsed.risks.join("; ")}`)
      if (parts.length > 0)
        return `[${role}]:\n${parts.join("\n")}`
    } catch { /* fall through to head+tail */ }
  }

  // Fallback: head + tail (preserves intro overview + conclusion)
  if (output.length > tier.dispatchHeadtailTriggerChars) {
    return `[${role}]:\n${output.slice(0, tier.dispatchHeadChars)}\n...\n[Conclusion]:\n${output.slice(-tier.dispatchTailChars)}`
  }
  return `[${role}]: ${output}`
}

/**
 * Build full upstream context for an expert:
 * - Direct dependencies: structured summary + detailed content
 * - Indirect upstream: structured summaries only
 */
function buildFullUpstreamContext(expert: ExpertDef, expertResults: ExpertResult[], tier: ContextTierResolver): string {
  const directDeps = new Set(expert.depends_on ?? [])
  const completed = expertResults.filter(r => r.status === "completed" && r.role !== expert.role)

  if (completed.length === 0) return ""

  const sections: string[] = []

  // Direct dependencies: summary + detail
  for (const dep of directDeps) {
    const r = completed.find(e => e.role === dep)
    if (!r) continue
    const summary = extractDispatchContext(r.output, dep, tier)
    const detail = r.output.length > tier.dispatchDetailMaxChars
      ? r.output.slice(0, tier.dispatchDetailMaxChars) + "\n...(truncated)"
      : r.output
    sections.push(`### Direct upstream [${dep}]\n${summary}\n\n<detail>\n${detail}\n</detail>`)
  }

  // Indirect upstream: summaries only
  const indirect = completed.filter(r => !directDeps.has(r.role))
  if (indirect.length > 0) {
    const indirectSummaries = indirect
      .map(r => extractDispatchContext(r.output, r.role, tier))
      .join("\n\n")
    sections.push(`### Indirect upstream summaries\n${indirectSummaries}`)
  }

  return sections.join("\n\n")
}
