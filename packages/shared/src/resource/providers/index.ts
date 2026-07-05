/**
 * SourceProvider — 资源来源提供者接口 + 工具函数
 *
 * 4 种协议实现：builtin / local / npm / git
 * 每种实现负责获取资源文件 + 计算 hash
 */
import { createHash } from "crypto"
import { readdir, readFile } from "fs/promises"
import { join } from "path"

export interface SourceRef {
  protocol: string
  location: string
  version: string
  subpath?: string
}

export interface FetchResult {
  files: { path: string; content: Buffer }[]
  hash: string
  version: string
}

export interface SourceProvider {
  fetch(ref: SourceRef): Promise<FetchResult>
}

/**
 * 计算文件列表的 SHA-256 hash（排序后拼接路径+内容）
 */
export function computeHash(files: { path: string; content: Buffer }[]): string {
  const hash = createHash("sha256")
  for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(f.path)
    hash.update(f.content)
  }
  return hash.digest("hex")
}

/**
 * 递归读取目录下所有文件
 */
export async function readDirRecursive(
  dir: string,
  base = dir,
): Promise<{ path: string; content: Buffer }[]> {
  const files: { path: string; content: Buffer }[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await readDirRecursive(fullPath, base))
    } else if (entry.isFile()) {
      const content = await readFile(fullPath)
      files.push({ path: fullPath.slice(base.length + 1), content })
    }
  }
  return files
}
