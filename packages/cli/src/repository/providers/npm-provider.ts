import type { SourceProvider, FetchResult, ValidationResult } from "./types"
import type { SourceRef } from "@octopus/shared"
import { SourceFetchError, isPathWithinBase } from "@octopus/shared"
import { execFile } from "child_process"
import { promisify } from "util"
import { readFileSync, readdirSync, statSync } from "fs"
import path from "path"

const execFileAsync = promisify(execFile)

export class NpmProvider implements SourceProvider {
  protocol = "npm" as const

  async validate(ref: SourceRef): Promise<ValidationResult> {
    if (ref.protocol !== "npm") return { valid: false, reason: "Wrong protocol" }
    if (!/^[a-z0-9@][a-z0-9._/@-]*$/.test(ref.package)) {
      return { valid: false, reason: `Invalid npm package name: ${ref.package}` }
    }
    return { valid: true }
  }

  async fetch(ref: SourceRef, tempDir: string): Promise<FetchResult> {
    if (ref.protocol !== "npm") throw new Error("Wrong protocol")
    const validation = await this.validate(ref)
    if (!validation.valid) throw new SourceFetchError(ref.package, validation.reason!)

    const pkg = ref.package
    const version = ref.version || "latest"
    try {
      await execFileAsync("npm", ["pack", `${pkg}@${version}`, "--pack-destination", tempDir], {
        timeout: 120_000,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw new SourceFetchError(`${pkg}@${version}`, message)
    }

    const tgzFiles = readdirSync(tempDir).filter(f => f.endsWith(".tgz"))
    if (tgzFiles.length === 0) throw new SourceFetchError(pkg, "No .tgz file produced")

    const tgzPath = path.join(tempDir, tgzFiles[0])
    await execFileAsync("tar", ["xzf", tgzPath, "-C", tempDir, "--strip-components=1"], {
      timeout: 30_000,
    })

    // SEC: Zip Slip protection — verify no files escaped the temp directory
    const resolvedTemp = path.resolve(tempDir)
    for (const extractedFile of readdirSync(tempDir, { withFileTypes: true })) {
      const extractedPath = path.resolve(tempDir, extractedFile.name)
      if (!isPathWithinBase(extractedPath, resolvedTemp)) {
        throw new SourceFetchError(pkg, "Package contains path traversal entries — possible Zip Slip attack")
      }
    }

    let resolvedVersion = version
    try {
      const pkgJson = JSON.parse(readFileSync(path.join(tempDir, "package.json"), "utf-8"))
      resolvedVersion = pkgJson.version || version
    } catch { /* use fallback */ }

    const size = this.calcDirSize(tempDir)
    return { path: tempDir, version: resolvedVersion, size }
  }

  async estimateSize(_ref: SourceRef): Promise<number> {
    return 50_000
  }

  private calcDirSize(dir: string): number {
    let total = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isFile()) total += statSync(full).size
      else if (entry.isDirectory()) total += this.calcDirSize(full)
    }
    return total
  }
}
