import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import type { ReposConfig, ManifestEntry } from "@octopus/shared"
import {
  parseManifest,
  generateIndex,
  parseIndexLocalPaths,
  parseIndexBranches,
  findManifestEntry,
  findManifestGroup,
  findLocalRepo,
  buildProjectInfos,
  applyAiDesc,
  scanExternalDirs,
  cloneMissingProjects,
  cloneProject,
  pullProject,
} from "@octopus/shared"

export class ReposError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReposError"
  }
}

export interface SyncOptions {
  clone?: boolean
  pull?: boolean
  rebuild?: boolean
  branchOverride?: string
  aiDescCli?: string
  scanDirs?: string[]
}

export interface SyncResult {
  cloned: { success: number; failed: number }
  pulled: { success: number; failed: number }
  rebuilt: boolean
}

export interface CloneResult {
  success: string[]
  failed: Array<{ name: string; reason: string }>
  skipped: string[]
}

export class ReposManager {
  constructor(private config: ReposConfig) {}

  async update(scanDirs?: string[], cloneMissing?: boolean, aiDescCli?: string): Promise<void> {
    const manifest = this.parseManifestFile()

    let externalPaths: Record<string, string> | undefined
    if (scanDirs && scanDirs.length > 0) {
      console.log("Scanning external directories")
      externalPaths = scanExternalDirs(scanDirs, manifest)
    }

    if (cloneMissing) {
      console.log("\nCloning missing projects")
      const { cloned, failed } = cloneMissingProjects(manifest, this.config.cloneBase, externalPaths)
      console.log(`\nClone result: ${cloned} success, ${failed} fail`)
    }

    console.log("\nRebuilding index")
    this.runFullMode(manifest, externalPaths, aiDescCli)
  }

  async pull(projectNames?: string[], branchOverride?: string): Promise<void> {
    const manifest = this.parseManifestFile()
    const { paths: localPaths, branches: indexBranches } = this.parseIndexData()

    let targets: Array<[string, string]>
    if (projectNames && projectNames.length > 0) {
      targets = []
      for (const name of projectNames) {
        const entry = findManifestEntry(manifest, name)
        if (!entry) {
          console.error(`'${name}' not found in manifest`)
          continue
        }
        const branch = branchOverride || entry.branch
        targets.push([name, branch])
      }
    } else {
      targets = []
      for (const name in localPaths) {
        const branch = branchOverride || indexBranches[name] || "master"
        targets.push([name, branch])
      }
    }

    if (targets.length === 0) {
      console.warn("No projects found to pull")
      return
    }

    console.log(`Pulling ${targets.length} projects`)

    let successCount = 0
    let failCount = 0

    for (const [name, branch] of targets) {
      const local = localPaths[name]
      if (!local) {
        console.warn(`Skip ${name} — not cloned`)
        failCount++
        continue
      }

      const result = pullProject(local, branch)
      if (result.success) {
        successCount++
      } else {
        console.error(`Fail ${name}: ${result.message}`)
        failCount++
      }
    }

    console.log(`\nResult: ${successCount} success, ${failCount} fail`)

    if (failCount > 0) {
      throw new ReposError(`Pull failed: ${failCount} projects failed`)
    }
  }

  async rebuildIndex(aiDescCli?: string, scanDirs?: string[]): Promise<void> {
    const manifest = this.parseManifestFile()

    let externalPaths: Record<string, string> | undefined
    if (scanDirs && scanDirs.length > 0) {
      console.log("Scanning external directories")
      externalPaths = scanExternalDirs(scanDirs, manifest)
    }

    this.runFullMode(manifest, externalPaths, aiDescCli)
  }

  async cloneProjects(projectNames: string[], branchOverride?: string): Promise<CloneResult> {
    const manifest = this.parseManifestFile()
    const result: CloneResult = { success: [], failed: [], skipped: [] }

    console.log(`Cloning ${projectNames.length} projects...`)

    for (const name of projectNames) {
      const entry = findManifestEntry(manifest, name)
      if (!entry) {
        console.error(`  ✗ ${name}: not found in manifest`)
        result.failed.push({ name, reason: `'${name}' not found in manifest` })
        continue
      }

      if (!entry.git_url) {
        console.error(`  ✗ ${name}: no git_url`)
        result.failed.push({ name, reason: `'${name}' has no git_url` })
        continue
      }

      const group = findManifestGroup(manifest, name) || ""

      const existing = findLocalRepo(group, name, this.config.cloneBase)
      if (existing) {
        console.log(`  - ${name}: already exists, skipped`)
        result.skipped.push(name)
        continue
      }

      const branch = branchOverride || entry.branch
      try {
        const cloneResult = cloneProject(entry.git_url, group, name, branch, this.config.cloneBase)
        if (cloneResult.success) {
          console.log(`  ✓ ${name}: cloned`)
          result.success.push(name)
        } else {
          console.error(`  ✗ ${name}: ${cloneResult.message}`)
          result.failed.push({ name, reason: cloneResult.message })
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`  ✗ ${name}: unexpected error - ${reason}`)
        result.failed.push({ name, reason })
      }
    }

    console.log(
      `\nClone: ${result.success.length} success, ${result.failed.length} failed, ${result.skipped.length} skipped`
    )

    if (result.success.length === 0 && result.skipped.length === 0 && result.failed.length > 0) {
      throw new ReposError(`All ${result.failed.length} projects failed`)
    }

    return result
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    const opts = { clone: true, pull: true, rebuild: true, ...options }
    const manifest = this.parseManifestFile()

    let externalPaths: Record<string, string> | undefined
    if (opts.scanDirs && opts.scanDirs.length > 0) {
      console.log("Scanning external directories")
      externalPaths = scanExternalDirs(opts.scanDirs, manifest)
    }

    // Step 1: Clone missing
    const cloned = { success: 0, failed: 0 }
    if (opts.clone) {
      console.log("\nClone missing projects...")
      const result = cloneMissingProjects(manifest, this.config.cloneBase, externalPaths)
      cloned.success = result.cloned
      cloned.failed = result.failed
      console.log(`  Clone: ${cloned.success} success, ${cloned.failed} failed`)
    }

    // Step 2: Pull all
    const pulled = { success: 0, failed: 0 }
    if (opts.pull) {
      console.log("\nPull all projects...")
      const targets = this.collectClonedProjects(manifest, opts.branchOverride)
      if (targets.length === 0) {
        console.log("  No cloned projects found to pull")
      }
      for (const [name, branch, localPath] of targets) {
        const result = pullProject(localPath, branch)
        if (result.success) {
          console.log(`  ✓ ${name}: pulled`)
          pulled.success++
        } else {
          console.error(`  ✗ ${name}: ${result.message}`)
          pulled.failed++
        }
      }
      console.log(`  Pull: ${pulled.success} success, ${pulled.failed} failed`)
    }

    // Step 3: Rebuild index
    let rebuilt = false
    if (opts.rebuild) {
      console.log("\nRebuild index...")
      try {
        this.runFullMode(manifest, externalPaths, opts.aiDescCli)
        rebuilt = true
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`  Rebuild failed: ${reason}`)
      }
    }

    // Summary
    const totalFailed = cloned.failed + pulled.failed
    console.log(
      `\nSync complete: ${cloned.success} cloned, ${pulled.success} pulled, ` +
      `${totalFailed} failed` +
      (rebuilt ? ", index rebuilt" : "")
    )

    return { cloned, pulled, rebuilt }
  }

  private collectClonedProjects(
    manifest: Record<string, ManifestEntry[]>,
    branchOverride?: string
  ): Array<[string, string, string]> {
    const targets: Array<[string, string, string]> = []
    for (const [group, entries] of Object.entries(manifest)) {
      for (const entry of entries) {
        const local = findLocalRepo(group, entry.name, this.config.cloneBase)
        if (local) {
          const branch = branchOverride || entry.branch
          targets.push([entry.name, branch, local])
        }
      }
    }
    return targets
  }

  private parseManifestFile(): Record<string, ManifestEntry[]> {
    const content = readFileSync(this.config.manifestPath, "utf-8")
    return parseManifest(content)
  }

  private parseIndexData(): { paths: Record<string, string>; branches: Record<string, string> } {
    if (!existsSync(this.config.outputPath)) return { paths: {}, branches: {} }
    const content = readFileSync(this.config.outputPath, "utf-8")
    return {
      paths: parseIndexLocalPaths(content),
      branches: parseIndexBranches(content),
    }
  }

  private runFullMode(
    manifest: Record<string, ManifestEntry[]>,
    externalPaths?: Record<string, string>,
    aiDescCli?: string
  ): void {
    console.log(`Scanning local clones in: ${this.config.cloneBase}`)

    const existingPaths = existsSync(this.config.outputPath)
      ? parseIndexLocalPaths(readFileSync(this.config.outputPath, "utf-8"))
      : undefined

    const projectInfos = buildProjectInfos(
      manifest,
      this.config.cloneBase,
      externalPaths,
      true,
      existingPaths
    )

    if (aiDescCli) {
      console.log(`Applying AI desc using: ${aiDescCli}`)
      applyAiDesc(projectInfos, aiDescCli)
    }

    const content = generateIndex(projectInfos)

    const outputDir = dirname(this.config.outputPath)
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(this.config.outputPath, content, "utf-8")
    console.log(`Index written to: ${this.config.outputPath}`)
  }
}