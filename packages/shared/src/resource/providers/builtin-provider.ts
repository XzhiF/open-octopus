import { join } from "path"
import { existsSync } from "fs"
import type { SourceProvider, SourceRef, FetchResult } from "./index"
import { readDirRecursive, computeHash } from "./index"

/**
 * BuiltinSourceProvider — 从 core-pack 目录获取内置资源
 */
export class BuiltinSourceProvider implements SourceProvider {
  constructor(private corePackDir: string) {}

  async fetch(ref: SourceRef): Promise<FetchResult> {
    const subpath = ref.subpath ?? ""
    const targetDir = join(this.corePackDir, subpath)
    if (!existsSync(targetDir)) {
      throw new Error(`FETCH_FAILED: Builtin path not found: ${targetDir}`)
    }
    const files = await readDirRecursive(targetDir)
    return { files, hash: computeHash(files), version: ref.version }
  }
}
