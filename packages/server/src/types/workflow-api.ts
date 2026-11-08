import type { WorkflowDef, WorkflowInput, WorkflowStage } from "@octopus/shared"

export interface WorkflowInfo {
  ref: string
  name: string
  /** YAML `description:` — the one-line "what/when to use" summary (2026-11-06). */
  description?: string
  /** Numeric release version (`version:` in YAML), when declared. */
  version?: string
  /** Resolved release stage — absent YAML `stage` defaults to `snapshot`. */
  stage: WorkflowStage
  inputs?: Record<string, WorkflowInput>
  group: string
}

export interface WorkflowDetail {
  ref: string
  content: string
  parsed: WorkflowDef
}