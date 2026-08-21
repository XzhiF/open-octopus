import { workflowConfigSchema, type WorkflowConfig } from "@octopus/shared"

export type ExtractResult =
  | { ok: true; config: WorkflowConfig }
  | { ok: false; reason: "no_block" | "parse_error" | "schema_error"; message: string }

const FENCED_JSON_RE = /```json\s*([\s\S]*?)\s*```/

export function extractWorkflowConfig(content: string): ExtractResult {
  const match = content.match(FENCED_JSON_RE)
  if (!match) return { ok: false, reason: "no_block", message: "未找到 JSON 围栏" }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return { ok: false, reason: "parse_error", message: "JSON 格式错误，请重试" }
  }

  const result = workflowConfigSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, reason: "schema_error", message: "JSON 不符合 WorkflowConfig schema" }
  }
  return { ok: true, config: result.data }
}
