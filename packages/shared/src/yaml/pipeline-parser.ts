import * as yaml from "js-yaml"
import { PipelineConfigSchema, type PipelineConfig } from "../types/pipeline"
import { ValueError } from "./parser"

// Re-export ValueError for backward compatibility
export { ValueError }

export function parsePipelineConfig(input: string | Record<string, unknown>): PipelineConfig {
  let raw: unknown
  if (typeof input === "string") {
    try {
      raw = yaml.load(input, { schema: yaml.JSON_SCHEMA })
    } catch (e: unknown) {
      throw new ValueError(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    raw = input
  }
  const result = PipelineConfigSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path?.join(".") ?? "root"
    throw new ValueError(`Pipeline config validation error at "${path}": ${issue?.message ?? "unknown"}`)
  }
  return result.data
}

export function isOctopusPipeline(input: unknown): boolean {
  let obj: unknown = input
  if (typeof input === "string") {
    try {
      obj = yaml.load(input, { schema: yaml.JSON_SCHEMA })
    } catch {
      return false
    }
  }
  if (typeof obj !== "object" || obj === null) return false
  const record = obj as Record<string, unknown>
  return (
    typeof record.apiVersion === "string" &&
    record.apiVersion.startsWith("octopus/") &&
    record.kind === "Pipeline"
  )
}

export function validatePipelineConfig(config: PipelineConfig): void {
  if (config.retry.default.retry_on?.includes("agent_partial_completion")) {
    process.stderr.write(
      "[pipeline] WARNING: agent_partial_completion is in retry_on. " +
      "Retrying agent nodes with partial side effects may cause duplicate operations.\n"
    )
  }
}
