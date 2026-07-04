import type { SourceRef } from "@octopus/shared"

export interface FetchResult {
  path: string
  version: string
  size: number
}

export interface ValidationResult {
  valid: boolean
  reason?: string
}

export interface SourceProvider {
  protocol: "npm" | "github" | "local" | "builtin"
  fetch(ref: SourceRef, tempDir: string): Promise<FetchResult>
  validate(ref: SourceRef): Promise<ValidationResult>
  estimateSize(ref: SourceRef): Promise<number>
}
