import type { SourceProvider, FetchResult, ValidationResult } from "./types"
import type { SourceRef } from "@octopus/shared"
import { SourceFetchError } from "@octopus/shared"
import { execFile } from "child_process"
import { promisify } from "util"
import { readdirSync, statSync, cpSync, rmSync, mkdirSync } from "fs"
import path from "path"

const execFileAsync = promisify(execFile)

export class GitProvider implements SourceProvider {
  protocol = "github" as const

  async validate(ref: SourceRef): Promise<ValidationResult> {
    if (ref.protocol !== "github") return { valid: false, reason: "Wrong protocol" }
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(ref.repo)) {
      return { valid: false, reason: `Invalid GitHub repo: ${ref.repo}` }
    }
    if (ref.ref && !/^[a-zA-Z0-9/_.-]+$/.test(ref.ref)) {
      return { valid: false, reason: `Invalid branch: ${ref.ref}` }
    }
    if (ref.path && (ref.path.includes("..") || path.isAbsolute(ref.path))) {
      return { valid: false, reason: `Invalid path: ${ref.path}` }
    }
    return { valid: true }
  }

  async fetch(ref: SourceRef, tempDir: string): Promise<FetchResult> {
    if (ref.protocol !== "github") throw new Error("Wrong protocol")
    const validation = await this.validate(ref)
    if (!validation.valid) throw new SourceFetchError(ref.repo, validation.reason!)

    const repoUrl = `https://github.com/${ref.repo}.git`
    const branch = ref.ref || "main"
    try {
      await execFileAsync("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, tempDir], {
        timeout: 300_000,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw new SourceFetchError(ref.repo, message)
    }

    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir })
    const version = stdout.trim().substring(0, 12)

    if (ref.path) {
      const subDir = path.join(tempDir, ref.path)
      const stagingDir = `${tempDir}_staging`
      mkdirSync(stagingDir, { recursive: true })
      cpSync(subDir, stagingDir, { recursive: true })
      rmSync(tempDir, { recursive: true, force: true })
      mkdirSync(tempDir, { recursive: true })
      cpSync(stagingDir, tempDir, { recursive: true })
      rmSync(stagingDir, { recursive: true, force: true })
    }

    const size = this.calcDirSize(tempDir)
    return { path: tempDir, version, size }
  }

  async estimateSize(_ref: SourceRef): Promise<number> {
    return 500_000
  }

  private calcDirSize(dir: string): number {
    let total = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue
      const full = path.join(dir, entry.name)
      if (entry.isFile()) total += statSync(full).size
      else if (entry.isDirectory()) total += this.calcDirSize(full)
    }
    return total
  }
}
