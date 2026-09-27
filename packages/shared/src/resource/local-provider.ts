import fs from "fs"
import path from "path"
import os from "os"
import { ResourceError } from "./errors"
import { copyDirSync, generateFileHash, isPathWithinBase } from "./fs-utils"

/**
 * LocalProvider — install resources from local filesystem paths.
 * Security: isPathWithinBase + allowlist default deny.
 */

/**
 * Default allowed base directories for local provider (B5 fix).
 * Empty allowlist = allow any = insecure. Default to user home.
 */
const DEFAULT_ALLOWED_BASES: string[] = [os.homedir()]

export interface LocalProviderConfig {
  allowedBases?: string[]
}

export class LocalProvider {
  private allowedBases: string[]

  constructor(config?: LocalProviderConfig) {
    this.allowedBases = config?.allowedBases ?? DEFAULT_ALLOWED_BASES
  }

  /** Validate path is within allowed bases (prevent path traversal) */
  private validatePath(sourcePath: string): void {
    const resolved = path.resolve(sourcePath)

    // Check for path traversal attempts
    if (resolved.includes("..")) {
      throw new ResourceError("PATH_TRAVERSAL", `Path traversal detected: ${sourcePath}`)
    }

    // Resolve symlinks for real path check (B4 — also at copy level)
    let realResolved: string
    try {
      realResolved = fs.realpathSync(resolved)
    } catch {
      throw new ResourceError("LOCAL_PATH_INVALID", `Path does not exist: ${sourcePath}`)
    }

    // B5 fix: allowlist must be checked — no early return for empty list
    // 两侧同尺：source 走了 realpath，base 也必须走——macOS /var→/private/var
    // 等符号链下混用 resolve/realpath 会把合法路径误判 PATH_TRAVERSAL。
    // base 不存在时退回 resolve 值（保持旧的「允许未来路径」行为）。
    const withinBase = this.allowedBases.some((base) => {
      const resolvedBase = path.resolve(base)
      let realBase = resolvedBase
      try {
        realBase = fs.realpathSync(resolvedBase)
      } catch {
        // base 尚不存在：用未解析值比较
      }
      return isPathWithinBase(realResolved, realBase)
    })

    if (!withinBase) {
      throw new ResourceError(
        "PATH_TRAVERSAL",
        `Path not within allowed directories: ${sourcePath}`,
      )
    }
  }

  /** Check if local resource exists */
  exists(sourcePath: string): boolean {
    try {
      return fs.statSync(sourcePath).isDirectory()
    } catch {
      return false
    }
  }

  /** Copy local resource to install path */
  install(sourcePath: string, installPath: string): { fileCount: number; hash: string } {
    this.validatePath(sourcePath)

    if (!this.exists(sourcePath)) {
      throw new ResourceError("LOCAL_PATH_INVALID", `Local path does not exist: ${sourcePath}`)
    }

    fs.mkdirSync(installPath, { recursive: true })

    let fileCount = 0
    try {
      fileCount = copyDirSync(sourcePath, installPath)
    } catch (err: any) {
      if (err instanceof ResourceError) throw err
      throw new ResourceError("FILE_COPY_FAILED", `Failed to copy from ${sourcePath}: ${err.message}`)
    }

    const hash = generateFileHash(installPath)
    return { fileCount, hash }
  }

  /** Add allowed base directory */
  addAllowedBase(base: string): void {
    const resolved = path.resolve(base)
    if (!this.allowedBases.includes(resolved)) {
      this.allowedBases.push(resolved)
    }
  }
}
