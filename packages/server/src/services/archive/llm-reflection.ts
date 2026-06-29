import type { ExecutionArchiveRow } from "../../db/types"
import type { ExperiencePotential } from "./layer-filter"

export interface ExperienceItem {
  type: "bug" | "pattern" | "cost" | "failure"
  title: string
  content: string
  project?: string
  package?: string
  file_pattern?: string
  keywords: string[]
}

export interface ReflectionResult {
  lessons: string
  items: ExperienceItem[]
}

export class LLMReflection {
  constructor(private anthropicClient?: any) {}

  async reflect(archive: ExecutionArchiveRow, potential: ExperiencePotential): Promise<ReflectionResult> {
    if (!this.anthropicClient) {
      console.warn("[LLMReflection] No Anthropic client, skipping reflection")
      return { lessons: "", items: [] }
    }

    const prompt = this.buildPrompt(archive, potential)

    try {
      const response = await this.anthropicClient.messages.create({
        model: "claude-3-haiku-20240307",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      })

      const text = response.content[0]?.text ?? ""
      return this.parseResponse(text)
    } catch (err) {
      console.warn("[LLMReflection] Reflection failed:", err)
      return { lessons: "", items: [] }
    }
  }

  private buildPrompt(archive: ExecutionArchiveRow, potential: ExperiencePotential): string {
    return `Analyze this workflow execution and extract actionable lessons:

Workflow: ${archive.workflow_name}
Status: ${archive.status}
Duration: ${archive.duration_ms}ms
Cost: $${archive.total_cost_usd.toFixed(2)}
Tokens: ${archive.total_input_tokens} input, ${archive.total_output_tokens} output

Anomaly signals:
- Cost anomaly: ${potential.signals.cost_anomaly}
- Duration anomaly: ${potential.signals.duration_anomaly}
- Retry pattern: ${potential.signals.retry_pattern}
- Failure recovery: ${potential.signals.failure_recovery}
- New error type: ${potential.signals.new_error_type}
- Var pool delta: ${potential.signals.var_pool_delta}
- Token spike: ${potential.signals.token_spike}

${archive.error_message ? `Error: ${archive.error_message}` : ""}
${archive.failed_nodes ? `Failed nodes: ${archive.failed_nodes}` : ""}

Extract lessons in JSON format:
{
  "lessons": "Summary of key learnings (2-3 sentences)",
  "items": [
    {
      "type": "bug|pattern|cost|failure",
      "title": "Short title",
      "content": "Detailed explanation",
      "project": "project name (optional)",
      "package": "package name (optional)",
      "file_pattern": "file pattern (optional)",
      "keywords": ["keyword1", "keyword2"]
    }
  ]
}

Return ONLY valid JSON, no markdown fences.`
  }

  private parseResponse(text: string): ReflectionResult {
    try {
      const parsed = JSON.parse(text)
      return {
        lessons: parsed.lessons ?? "",
        items: Array.isArray(parsed.items) ? parsed.items : [],
      }
    } catch {
      console.warn("[LLMReflection] Failed to parse JSON response")
      return { lessons: "", items: [] }
    }
  }
}
