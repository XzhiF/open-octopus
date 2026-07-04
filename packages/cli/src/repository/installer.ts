import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, writeFileSync } from "fs"
import path from "path"
import type { ResourceType, ResourceDependency, LockFile, LockResourceEntry, ISecurityContext } from "@octopus/shared"
import { DEFAULT_TARGETS, InstallVerificationError, RepoError, isPathWithinBase, LockFileSchema } from "@octopus/shared"
import { RepositoryManager } from "./repository-manager"
import { SnapshotManager } from "./snapshot"

// ── Local types ──────────────────────────────────────────────────

export interface InstallStepManifest {
  target?: { dir: string }
  dependencies: ResourceDependency[]
}

export interface InstallStep {
  name: string
  type: ResourceType
  manifest: InstallStepManifest
}

export interface InstallPlan {
  ordered: InstallStep[]
  /** Optional deps that were skipped during resolution (not found in registry) */
  skipped?: string[]
}

export type { ISecurityContext }

// ── Installer ────────────────────────────────────────────────────

export type InstallMode = "FRESH" | "MERGE" | "FORCE"

export interface InstallOptions {
  workspaceDir: string
  mode?: InstallMode
  yes?: boolean
  confirmed?: boolean
  dryRun?: boolean
  json?: boolean
}

export interface InstallResult {
  installed: { name: string; type: ResourceType; target: string; hash: string }[]
  failed: { name: string; type: ResourceType; reason: string }[]
  skipped: { name: string; reason: string }[]
  status: "success" | "partial" | "failed"
  lockFile?: LockFile
}

export class WorkspaceInstaller {
  constructor(
    private repoManager: RepositoryManager,
    private security?: ISecurityContext,
  ) {}

  async install(plan: InstallPlan, opts: InstallOptions): Promise<InstallResult> {
    const result: InstallResult = {
      installed: [],
      failed: [],
      skipped: [],
      status: "success",
    }

    const wsDir = opts.workspaceDir
    const mode = opts.mode ?? "FRESH"

    // B-7: Propagate skipped optional deps from resolution phase
    if (plan.skipped) {
      for (const name of plan.skipped) {
        result.skipped.push({ name, reason: "Optional dependency not found in registry" })
      }
    }

    // Create snapshot for rollback
    const backupDir = path.join(wsDir, ".octopus", ".backup")
    const snapshot = SnapshotManager.create(
      wsDir,
      plan.ordered.map(step => ({ targetPath: this.getTargetPath(step) })),
      backupDir
    )

    let criticalFailure = false

    for (const step of plan.ordered) {
      try {
        const targetPath = this.getTargetPath(step)

        // SEC-04: Path traversal protection
        const resolved = path.resolve(wsDir, targetPath)
        if (!isPathWithinBase(resolved, wsDir)) {
          throw new RepoError(
            `Install target escapes workspace: ${targetPath}`,
            "SECURITY_ERROR",
            "Check manifest target.dir — must be relative to workspace",
            5
          )
        }

        this.installOne(step, wsDir, mode)
        this.verifyInstalled(step, wsDir)

        const entry = this.repoManager.lookup(step.name, step.type)
        result.installed.push({
          name: step.name,
          type: step.type,
          target: targetPath,
          hash: entry?.hash ?? "unknown",
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        // B-6: Check if this step is an optional dependency of any OTHER step in the plan
        const isOptional = plan.ordered.some(otherStep =>
          otherStep.name !== step.name &&
          otherStep.manifest.dependencies.some(d => d.name === step.name && d.optional)
        )
        if (isOptional) {
          result.skipped.push({ name: step.name, reason: message })
        } else {
          result.failed.push({ name: step.name, type: step.type, reason: message })
          criticalFailure = true
          break
        }
      }
    }

    // Rollback on critical failure
    if (criticalFailure) {
      SnapshotManager.rollback(snapshot)
      result.status = "failed"
    } else if (result.failed.length > 0) {
      result.status = "partial"
    }

    // Cleanup backup
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true })
    }

    // B-13: Generate resources.lock after successful install
    if (!criticalFailure && result.installed.length > 0) {
      result.lockFile = this.generateLockFile(wsDir, result)
    }

    return result
  }

  /**
   * B-13: Generate resources.lock file capturing installed state.
   * Merges with existing lock entries for resources not in this install.
   */
  private generateLockFile(wsDir: string, result: InstallResult): LockFile {
    const lockPath = path.join(wsDir, ".octopus", "resources.lock")
    const entries: LockResourceEntry[] = []

    // Preserve existing entries not in this install
    if (existsSync(lockPath)) {
      try {
        const existing = JSON.parse(readFileSync(lockPath, "utf-8"))
        const installedNames = new Set(result.installed.map(i => `${i.type}:${i.name}`))
        for (const e of (existing.resources ?? [])) {
          if (!installedNames.has(`${e.type}:${e.name}`)) {
            entries.push(e)
          }
        }
      } catch { /* start fresh if corrupt */ }
    }

    // Add newly installed entries
    for (const inst of result.installed) {
      const registryEntry = this.repoManager.lookup(inst.name, inst.type)
      entries.push({
        name: inst.name,
        type: inst.type,
        hash: inst.hash,
        source: registryEntry?.source ?? { protocol: "local" as const, path: "." },
        installed_at: new Date().toISOString(),
        target: inst.target,
        installed_by: (process.env.OCTOPUS_CALLER as "human" | "agent") || "human",
      })
    }

    const lockFile = LockFileSchema.parse({
      version: 1,
      generated_at: new Date().toISOString(),
      resources: entries,
    })

    mkdirSync(path.dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify(lockFile, null, 2), "utf-8")

    return lockFile
  }

  installOne(step: InstallStep, wsDir: string, mode: InstallMode): void {
    const targetPath = this.getTargetPath(step)
    const fullPath = path.resolve(wsDir, targetPath)
    const entry = this.repoManager.lookup(step.name, step.type)

    if (!entry) {
      throw new RepoError(
        `Resource not found in registry: ${step.type}:${step.name}`,
        "RESOURCE_NOT_FOUND",
        `Register it first: octopus repo register <ref> --type ${step.type}`,
        4
      )
    }

    const cacheDir = path.join(this.repoManager.getRepoDir(), entry.cache_path)
    if (!existsSync(cacheDir)) {
      throw new RepoError(
        `Cache not found for ${step.name}`,
        "INSTALL_VERIFY_FAILED",
        `Re-register: octopus repo register <ref> --type ${step.type} --force`,
        1
      )
    }

    mkdirSync(path.dirname(fullPath), { recursive: true })

    switch (mode) {
      case "FORCE":
        if (existsSync(fullPath)) rmSync(fullPath, { recursive: true, force: true })
        cpSync(cacheDir, fullPath, { recursive: true })
        break
      case "MERGE":
        this.mergeDir(cacheDir, fullPath)
        break
      default: // FRESH
        if (existsSync(fullPath)) rmSync(fullPath, { recursive: true, force: true })
        cpSync(cacheDir, fullPath, { recursive: true })
    }
  }

  verifyInstalled(step: InstallStep, wsDir: string): void {
    const targetPath = this.getTargetPath(step)
    const fullPath = path.resolve(wsDir, targetPath)
    if (!existsSync(fullPath)) {
      throw new InstallVerificationError(step.name, step.type, targetPath)
    }
  }

  getTargetPath(step: InstallStep): string {
    if (step.manifest.target) {
      return step.manifest.target.dir
    }
    const defaults = DEFAULT_TARGETS[step.type]
    return path.join(defaults.dir, step.name)
  }

  private mergeDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true })
    const entries = readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        this.mergeDir(srcPath, destPath)
      } else if (!existsSync(destPath)) {
        cpSync(srcPath, destPath)
      }
    }
  }
}
