import { execFile } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { SourceProvider, SourceRef, FetchResult } from "./index"
import { readDirRecursive, computeHash } from "./index"
import { ResourceError, ResourceErrorCode } from "../errors"

// Whitelist: only https://, git://, and git@ protocols
const ALLOWED_GIT_URL = /^https?:\/\/|^git:\/\/|^git@/

/**
 * GitSourceProvider — 从 Git 仓库获取资源
 *
 * 使用 shallow clone (--depth 1) 减少下载量
 */
export class GitSourceProvider implements SourceProvider {
  validateGitUrl(url: string): boolean {
    return ALLOWED_GIT_URL.test(url)
  }

  async fetch(ref: SourceRef): Promise<FetchResult> {
    if (!this.validateGitUrl(ref.location)) {
      throw new ResourceError(
        ResourceErrorCode.INVALID_MANIFEST,
        `INVALID_MANIFEST: Git URL must use https://, git://, or git@ protocol. Got: ${ref.location}`,
      )
    }
    const tmpDir = mkdtempSync(join(tmpdir(), "git-fetch-"))
    const repoDir = join(tmpDir, "repo")
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["clone", "--depth", "1", ref.location, repoDir], (err) => {
          if (err) reject(new ResourceError(ResourceErrorCode.FETCH_FAILED, `FETCH_FAILED: git clone failed: ${err.message}`))
          else resolve()
        })
      })
      const subpath = ref.subpath ? join(repoDir, ref.subpath) : repoDir
      const files = await readDirRecursive(subpath)
      return { files, hash: computeHash(files), version: ref.version }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}
