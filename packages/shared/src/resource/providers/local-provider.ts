import { existsSync } from "fs"
import type { SourceProvider, SourceRef, FetchResult } from "./index"
import { readDirRecursive, computeHash } from "./index"
import { ResourceError, ResourceErrorCode } from "../errors"

/**
 * LocalSourceProvider — 从本地路径获取资源
 */
export class LocalSourceProvider implements SourceProvider {
  async fetch(ref: SourceRef): Promise<FetchResult> {
    if (!existsSync(ref.location)) {
      throw new ResourceError(ResourceErrorCode.FETCH_FAILED, `FETCH_FAILED: Local path not found: ${ref.location}`)
    }
    const files = await readDirRecursive(ref.location)
    return { files, hash: computeHash(files), version: ref.version }
  }
}
