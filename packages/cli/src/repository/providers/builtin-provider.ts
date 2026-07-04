import type { SourceProvider, FetchResult, ValidationResult } from "./types"
import type { SourceRef } from "@octopus/shared"
import { existsSync, statSync, cpSync } from "fs"
import path from "path"

export class BuiltinProvider implements SourceProvider {
  protocol = "builtin" as const
  private corePackDir: string

  constructor(corePackDir?: string) {
    // When running from dist/: __dirname = packages/cli/dist/ → core-pack is at ./core-pack/
    // When running from source: __dirname = packages/cli/src/repository/providers/ → core-pack is at ../../../core-pack/
    const distPath = path.resolve(__dirname, "core-pack")
    const srcPath = path.resolve(__dirname, "../../../core-pack")
    this.corePackDir = corePackDir ?? (existsSync(distPath) ? distPath : srcPath)
  }

  async validate(ref: SourceRef): Promise<ValidationResult> {
    if (ref.protocol !== "builtin") return { valid: false, reason: "Wrong protocol" }
    const candidates = this.findCandidates(ref.id)
    if (candidates.length === 0) return { valid: false, reason: `Builtin resource not found: ${ref.id}` }
    return { valid: true }
  }

  async fetch(ref: SourceRef, tempDir: string): Promise<FetchResult> {
    if (ref.protocol !== "builtin") throw new Error("Wrong protocol")
    const candidates = this.findCandidates(ref.id)
    if (candidates.length === 0) throw new Error(`Builtin resource not found: ${ref.id}`)

    const src = candidates[0]
    const stat = statSync(src)
    if (stat.isDirectory()) {
      cpSync(src, tempDir, { recursive: true })
    } else {
      cpSync(src, path.join(tempDir, path.basename(src)))
    }
    return { path: tempDir, version: "builtin", size: stat.size ?? 0 }
  }

  async estimateSize(_ref: SourceRef): Promise<number> {
    return 10_000
  }

  private findCandidates(id: string): string[] {
    return [
      path.join(this.corePackDir, "skills", id),
      path.join(this.corePackDir, "agents", `${id}.md`),
      path.join(this.corePackDir, "presets", "workflows", `${id}.yaml`),
    ].filter(p => existsSync(p))
  }
}
