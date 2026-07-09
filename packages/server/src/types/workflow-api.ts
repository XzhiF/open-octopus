import type { WorkflowDef, WorkflowInput } from "@octopus/shared"

export interface WorkflowInfo {
  ref: string
  name: string
  inputs?: Record<string, WorkflowInput>
  group: string
}

export interface WorkflowDetail {
  ref: string
  content: string
  parsed: WorkflowDef
}