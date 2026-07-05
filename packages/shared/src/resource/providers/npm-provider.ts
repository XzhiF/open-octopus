import { execFile } from "child_process"
import { mkdtempSync, rmSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { SourceProvider, SourceRef, FetchResult } from "./index"
import { readDirRecursive, computeHash } from "./index"
import { ResourceError, ResourceErrorCode } from "../errors"

/**
 * NpmSourceProvider — 从 npm 注册表获取包
 *
 * 使用 npm pack + tar 提取文件，避免全局 install 副作用
 */
export class NpmSourceProvider implements SourceProvider {
  validatePackageName(name: string): boolean {
    return /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9.-]*$/.test(name)
  }

  async fetch(ref: SourceRef): Promise<FetchResult> {
    if (!this.validatePackageName(ref.location)) {
      throw new ResourceError(ResourceErrorCode.INVALID_MANIFEST, `INVALID_MANIFEST: Invalid npm package name: ${ref.location}`)
    }
    const tmpDir = mkdtempSync(join(tmpdir(), "npm-fetch-"))
    try {
      // npm pack to download the tarball
      await new Promise<void>((resolve, reject) => {
        execFile("npm", ["pack", ref.location, "--pack-destination", tmpDir], { cwd: tmpDir }, (err) => {
          if (err) reject(new ResourceError(ResourceErrorCode.FETCH_FAILED, `FETCH_FAILED: npm pack failed: ${err.message}`))
          else resolve()
        })
      })
      // Extract .tgz
      const tgzFiles = readdirSync(tmpDir).filter(f => f.endsWith(".tgz"))
      if (tgzFiles.length === 0) throw new ResourceError(ResourceErrorCode.FETCH_FAILED, "FETCH_FAILED: No .tgz file found after npm pack")
      await new Promise<void>((resolve, reject) => {
        execFile("tar", ["-xzf", tgzFiles[0]], { cwd: tmpDir }, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      const packageDir = join(tmpDir, "package")
      const subpath = ref.subpath ? join(packageDir, ref.subpath) : packageDir
      const files = await readDirRecursive(subpath)
      return { files, hash: computeHash(files), version: ref.version }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}
