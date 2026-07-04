import { existsSync, rmSync } from "fs"
import path from "path"
import type { ResourceType, LockFile } from "@octopus/shared"
import { RepoError, isPathWithinBase, ReverseDependencyError } from "@octopus/shared"

export interface UninstallResult {
  uninstalled: { name: string; type: ResourceType; target: string }
  warnings: string[]
}

export class WorkspaceUninstaller {
  /**
   * Check reverse dependencies: which installed resources depend on the target?
   *
   * Uses the lock file's dependency metadata to determine dependents.
   * Returns list of dependent resource names that would break.
   */
  checkReverseDeps(name: string, type: ResourceType, lockFile: LockFile): string[] {
    const dependents: string[] = []
    for (const resource of lockFile.resources) {
      // Skip the target itself
      if (resource.name === name && resource.type === type) continue

      // Check if this resource has dependencies that include the target
      // LockResourceEntry doesn't carry dependency info directly,
      // so we check by convention: resources that list the target in their manifest.
      // The caller should provide lock file entries with dependency metadata.
      const deps = (resource as any).dependencies as Array<{ name: string; type: string }> | undefined
      if (deps?.some(d => d.name === name && d.type === type)) {
        dependents.push(`${resource.type}:${resource.name}`)
      }
    }
    return dependents
  }

  async uninstall(
    name: string,
    type: ResourceType,
    wsDir: string,
    targetPath: string,
    opts?: { force?: boolean }
  ): Promise<UninstallResult> {
    const fullPath = path.resolve(wsDir, targetPath)
    const warnings: string[] = []

    // SEC-04: Path traversal protection — ensure target is within workspace
    if (!isPathWithinBase(fullPath, wsDir)) {
      throw new RepoError(
        `Uninstall target escapes workspace: ${targetPath}`,
        "SECURITY_ERROR",
        "Target path must be within the workspace directory",
        5
      )
    }

    // Prevent removing the workspace root itself
    if (fullPath === path.resolve(wsDir)) {
      throw new RepoError(
        "Refusing to remove workspace root directory",
        "SECURITY_ERROR",
        "Target path must be a subdirectory within the workspace",
        5
      )
    }

    if (!existsSync(fullPath)) {
      throw new RepoError(
        `Resource not installed: ${type}:${name}`,
        "RESOURCE_NOT_FOUND",
        "Nothing to uninstall",
        4
      )
    }

    rmSync(fullPath, { recursive: true, force: true })

    return {
      uninstalled: { name, type, target: targetPath },
      warnings,
    }
  }
}
