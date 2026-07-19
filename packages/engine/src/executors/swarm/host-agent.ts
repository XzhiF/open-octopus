import type { HostOutput, ExpertResult, Message } from "./swarm-types"
import { HOST_DEGRADED_RECOMMENDATION_CHARS } from "./swarm-constants"
import type { ExpertDef } from "@octopus/shared"

export interface HostAgentConfig {
  outputFormat?: string
  mode?: string
  topic: string
  host?: ExpertDef
}

/**
 * Host agent synthesizes expert outputs into a final report.
 * In debate mode, also assesses consensus and decides whether to continue.
 *
 * Degradation chain:
 *   1. Try host.model ?? "pro-max"
 *   2. On failure: try "pro" fallback
 *   3. On all models failed: degrade to concatenation, set degraded: true
 *
 * When host.prompt is provided, it replaces the built-in synthesis instructions.
 * When host.perspective is provided, it is injected into the prompt context.
 *
 * TC-038: When ALL experts fail (0 completed), skip synthesis entirely.
 */
export class HostAgent {
  constructor(
    private llmCall: (prompt: string, model?: string) => Promise<string>,
  ) {}

  async synthesize(
    expertOutputs: ExpertResult[],
    messages: Message[],
    config: HostAgentConfig,
  ): Promise<HostOutput & { degraded?: boolean }> {
    // TC-038: All experts failed -> no synthesis possible
    const completedExperts = expertOutputs.filter(e => e.status === "completed")
    if (completedExperts.length === 0) {
      return { synthesis: "", degraded: true }
    }

    const prompt = this.buildPrompt(completedExperts, messages, config)
    // Degradation chain: host.model ?? pro-max → pro → concatenation
    const primaryModel = config.host?.model ?? "pro-max"
    const models = primaryModel === "pro" ? ["pro"] : [primaryModel, "pro"]

    for (const model of models) {
      try {
        const response = await this.llmCall(prompt, model)
        return this.parseResponse(response, config)
      } catch (e: any) {
        console.warn(`[HostAgent] ${model} failed: ${e.message}`)
      }
      console.warn(`[HostAgent] Model ${model} failed, trying next fallback...`)
    }

    // All models and retries exhausted -> degraded concatenation
    console.warn("[HostAgent] All models failed, degrading to concatenation")
    return { ...this.degradedSynthesis(completedExperts), degraded: true }
  }

  private buildPrompt(
    expertOutputs: ExpertResult[],
    messages: Message[],
    config: HostAgentConfig,
  ): string {
    const expertSections = expertOutputs
      .filter(e => e.status === "completed")
      .map(e => `## Expert: ${e.role}\n${e.output}`)
      .join("\n\n")

    const isDebate = config.mode === "debate" || config.mode === "swarm"

    let prompt = `You are the Host agent synthesizing expert opinions.`

    // Inject host perspective if provided
    if (config.host?.perspective) {
      prompt += `\nYour perspective: ${config.host.perspective}`
    }

    prompt += `\n\n===USER TOPIC START===\n${config.topic}\n===USER TOPIC END===\n\n## Expert Opinions\n\n${expertSections}\n`

    // Layer 1: Task instructions (custom or built-in)
    if (config.host?.prompt) {
      prompt += `\n## Your Instructions\n${config.host.prompt}`
    } else if (isDebate) {
      prompt += `
## Your Task
1. Assess the consensus among experts (score 0.0-1.0)
2. Identify key agreements and disagreements
3. Determine if further rounds of discussion would be productive
4. Provide a comprehensive synthesis (keep under 6000 words to avoid truncation)`
    } else {
      prompt += `
## Your Task
Provide a comprehensive synthesis of the expert opinions above.
Consider all perspectives and provide a balanced analysis.
Keep the synthesis under 6000 words to avoid output truncation.`
    }

    // Layer 2: System-enforced output format (always appended for debate/swarm)
    // Ensures parseable assessment regardless of custom prompt content.
    if (isDebate) {
      prompt += `

## Output Format (MANDATORY)
You MUST respond with a single JSON object in this exact structure:
{
  "synthesis": "your comprehensive analysis (under 6000 words)...",
  "assessment": {
    "consensus_score": 0.0-1.0,
    "key_agreements": ["agreement 1", ...],
    "key_disagreements": ["disagreement 1", ...],
    "should_continue": true/false,
    "confidence": 0.0-1.0
  }
}
Do NOT use markdown code fences around the JSON. Respond with the raw JSON object only.`
    }

    // ponytail: custom host.prompt defines its own output format — don't
    // append structured schema that would conflict with vars_update instructions.
    if (config.outputFormat === "structured" && !config.host?.prompt) {
      prompt += `

Respond in this JSON structure:
{
  "synthesis": "...(under 6000 words)...",
  "experts": [{"role": "...", "opinion": "..."}],
  "disagreements": ["..."],
  "recommendation": "...",
  "confidence": 0.0-1.0
}`
    }

    return prompt
  }

  private parseResponse(response: string, config: HostAgentConfig): HostOutput {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        // For structured output, return the full JSON string as synthesis
        if (config.outputFormat === "structured") {
          return {
            synthesis: jsonMatch[0],
            rawResponse: response,
            assessment: parsed.assessment,
          }
        }
        return {
          synthesis: parsed.synthesis || response,
          rawResponse: response,
          assessment: parsed.assessment ?? this.extractAssessmentBlock(response),
        }
      } catch {
        // Not valid JSON — try extracting with balanced braces
        const extracted = this.extractBalancedJson(response)
        if (extracted) {
          try {
            const parsed = JSON.parse(extracted)
            if (config.outputFormat === "structured") {
              return { synthesis: extracted, rawResponse: response, assessment: parsed.assessment }
            }
            return { synthesis: parsed.synthesis || response, rawResponse: response, assessment: parsed.assessment ?? this.extractAssessmentBlock(response) }
          } catch { /* fall through */ }
        }
      }
    }

    // Fallback: try extracting assessment from ```assessment code block
    const blockAssessment = this.extractAssessmentBlock(response)
    if (blockAssessment) {
      return { synthesis: response, rawResponse: response, assessment: blockAssessment }
    }

    // For structured output without JSON: wrap in minimal valid JSON
    if (config.outputFormat === "structured") {
      const fallback = JSON.stringify({
        synthesis: response,
        experts: [],
        disagreements: [],
        recommendation: response.slice(0, HOST_DEGRADED_RECOMMENDATION_CHARS),
        confidence: 0,
      })
      return { synthesis: fallback, rawResponse: response }
    }

    return { synthesis: response, rawResponse: response }
  }

  /**
   * Extract assessment from ```assessment ... ``` code block.
   * Used when custom host.prompt defines its own output format instead of the built-in JSON schema.
   */
  private extractAssessmentBlock(response: string): HostOutput["assessment"] | undefined {
    const match = response.match(/```assessment\s*\n?([\s\S]*?)```/)
    if (!match) return undefined
    try {
      return JSON.parse(match[1].trim())
    } catch {
      // Try to find JSON within the block
      const jsonInBlock = match[1].match(/\{[\s\S]*\}/)
      if (jsonInBlock) {
        try { return JSON.parse(jsonInBlock[0]) } catch { /* ignore */ }
      }
      return undefined
    }
  }

  private extractBalancedJson(text: string): string | null {
    const start = text.indexOf("{")
    if (start === -1) return null
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (escape) { escape = false; continue }
      if (ch === "\\") { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === "{") depth++
      if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1) }
    }
    return null
  }

  /** Degraded synthesis when LLM fails — concatenate all expert outputs */
  private degradedSynthesis(expertOutputs: ExpertResult[]): HostOutput {
    const sections = expertOutputs
      .filter(e => e.status === "completed")
      .map(e => `### ${e.role}\n${e.output}`)
      .join("\n\n")

    return {
      synthesis: `[Host degraded — raw expert opinions concatenated]\n\n${sections}`,
    }
  }
}
