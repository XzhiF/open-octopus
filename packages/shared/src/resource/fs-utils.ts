import fs from "fs"
import path from "path"
import crypto from "crypto"
import { ResourceError } from "./errors"

/**
 * Shared filesystem utilities for resource providers.
 * Consolidated from local-provider.ts and builtin-provider.ts (B10).
 */

/**
 * Copy directory recursively.
 * Rejects symlinks to prevent path escape (B4).
 */
export function copyDirSync(src: string, dest: string): number {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  let count = 0
  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    // Reject symlinks — prevent escape from base directory (B4)
    if (entry.isSymbolicLink()) {
      throw new ResourceError(
        "SYMLINK_REJECTED",
        `Symlinks not allowed in resource directory: ${entry.name}`
      )
    }

    if (entry.isDirectory()) {
      count += copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
      count++
    }
  }

  return count
}

/**
 * List files recursively, returning relative paths.
 * Skips symlinks for safety.
 */
export function listFilesRecursive(dir: string, prefix = ""): string[] {
  const results: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    // Skip symlinks
    if (entry.isSymbolicLink()) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(path.join(dir, entry.name), rel))
    } else {
      results.push(rel)
    }
  }
  return results
}

/**
 * Generate SHA256 hash from file manifest.
 */
export function generateFileHash(dir: string): string {
  const hash = crypto.createHash("sha256")
  const files = listFilesRecursive(dir).sort()
  for (const f of files) {
    hash.update(f)
  }
  return hash.digest("hex").slice(0, 16)
}

/**
 * isPathWithinBase — security utility.
 * Resolves path and checks it stays within base directory.
 */
export function isPathWithinBase(targetPath: string, base: string): boolean {
  const resolved = path.resolve(targetPath)
  const resolvedBase = path.resolve(base)
  return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase
}
