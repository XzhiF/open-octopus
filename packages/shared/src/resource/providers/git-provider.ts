import fs from "fs"
import path from "path"
import { execFileSync } from "child_process"
import { ResourceError } from "../errors"

/**
 * GitProvider — clone/pull git repositories to local cache.
 * Shallow clone (--depth 1) for performance.
 * GitHub-only URLs for Phase 5 security.
 */

export interface GitProviderConfig {
  cacheBase: string
}

export class GitProvider {
  private cacheBase: string

  constructor(config: GitProviderConfig) {
    this.cacheBase = config.cacheBase
  }

  /** Clone repository to cache directory */
  clone(url: string, name: string, branch = "main"): { cachePath: string } {
    if (!this.validateUrl(url)) {
      throw new ResourceError("GIT_URL_INVALID", `Invalid git URL: ${url}`)
    }

    const cachePath = this.getCachePath(name)

    if (fs.existsSync(cachePath)) {
      throw new ResourceError("SOURCE_ALREADY_EXISTS", `Source ${name} already cached`)
    }

    fs.mkdirSync(path.dirname(cachePath), { recursive: true })

    try {
      execFileSync(
        "git",
        ["clone", "--depth", "1", "--branch", branch, "--single-branch", url, cachePath],
        { timeout: 60_000, stdio: "pipe" },
      )
    } catch (err: any) {
      // Clean up partial clone on failure
      if (fs.existsSync(cachePath)) {
        fs.rmSync(cachePath, { recursive: true, force: true })
      }
      throw new ResourceError("GIT_CLONE_FAILED", `Failed to clone ${url}: ${err.message}`)
    }

    return { cachePath }
  }

  /** Pull latest changes (fast-forward only) */
  pull(cachePath: string): void {
    if (!fs.existsSync(cachePath)) {
      throw new ResourceError("SOURCE_NOT_FOUND", `Source cache not found: ${cachePath}`)
    }

    try {
      execFileSync("git", ["pull", "--ff-only"], {
        cwd: cachePath,
        timeout: 30_000,
        stdio: "pipe",
      })
    } catch (err: any) {
      throw new ResourceError("GIT_PULL_FAILED", `Failed to pull: ${err.message}`)
    }
  }

  /** Remove cache directory */
  clean(name: string): void {
    const cachePath = this.getCachePath(name)
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath, { recursive: true, force: true })
    }
  }

  /** Validate URL is https://github.com/{owner}/{repo} */
  validateUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      return parsed.protocol === "https:" && parsed.hostname === "github.com"
    } catch {
      return false
    }
  }

  /** Get cache path for source name */
  getCachePath(name: string): string {
    return path.join(this.cacheBase, name)
  }

  /** Check if source cache exists */
  exists(name: string): boolean {
    return fs.existsSync(this.getCachePath(name))
  }
}
