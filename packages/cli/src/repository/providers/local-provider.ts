import type { SourceProvider, FetchResult, ValidationResult } from "./types"
import type { SourceRef } from "@octopus/shared"
import { existsSync, statSync, cpSync } from "fs"
import path from "path"

export class LocalProvider implements SourceProvider {
  protocol = "local" as const

  async validate(ref: SourceRef): Promise<ValidationResult> {
    if (ref.protocol !== "local") return { valid: false, reason: "Wrong protocol" }
    if (!existsSync(ref.path)) return { valid: false, reason: `Path not found: ${ref.path}` }
    return { valid: true }
  }

  async fetch(ref: SourceRef, tempDir: string): Promise<FetchResult> {
    if (ref.protocol !== "local") throw new Error("Wrong protocol")
    const srcPath = path.resolve(ref.path)
    const stat = statSync(srcPath)
    if (stat.isDirectory()) {
      cpSync(srcPath, tempDir, { recursive: true })
    } else {
      cpSync(srcPath, path.join(tempDir, path.basename(srcPath)))
    }
    return { path: tempDir, version: "0.0.0", size: stat.size ?? 0 }
  }

  async estimateSize(ref: SourceRef): Promise<number> {
    if (ref.protocol !== "local") return 0
    if (!existsSync(ref.path)) return 0
    return statSync(ref.path).size ?? 0
  }
}
