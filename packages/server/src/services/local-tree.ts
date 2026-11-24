// 只读目录树（2026-11-24 目录窗优化）· 本舱 cwd / 项目 worktree 共用的磁盘直扫。
//
// 旧口径（v20 design 29 §6）是同步 DFS + depth≤6 / 2000 条：Java 项目
// `src/main/java/com/x/项目/模块/...` 从根算 7 段以上，整个包目录被截空 —— 用户
// 「新加的 Java 文件看不到」就是它。现在：
//   · depth 6 → 14（覆盖 src/main/java 下的包层级）；
//   · 文件配额 2000 → 20000，目录条目单独记账（空目录海不占文件配额）；
//   · 扫描改异步（fs.promises + 并发 8）—— 不再阻塞 Node 事件循环，SSE / 聊天不顿；
//   · 截断如实上报 `truncated / reason / maxDepth`，界面不再把截断当完整；
//   · 默认不取每个文件的 stat（bytes=0）；要大小显式 `sizes=1`；
//   · 10s TTL + in-flight 去重缓存：三处界面打开同一棵树只扫一次；
//     chokidar（tree-watch.ts）在文件变化时立刻失效缓存。

import fs from "fs"
import fsp from "fs/promises"
import path from "path"

export interface LocalTreeEntry {
  path: string
  type: "dir" | "file"
  /** sizes=1 时的字节数；默认 0 = 未取。 */
  bytes: number
}

export type TreeTruncReason = "depth" | "count"

export interface LocalTreeScan {
  entries: LocalTreeEntry[]
  truncated: boolean
  reason: TreeTruncReason | null
  /** 本次扫描允许的最大目录层数（界面提示用）。 */
  maxDepth: number
}

/** 目录层数上限（根的 depth = 0）。Java 的 src/main/java/com/a/b/c/d 远在 14 之内。 */
export const TREE_MAX_DEPTH = 14
/** 文件条目上限（不含目录）。 */
export const TREE_MAX_FILES = 20_000
/** 目录条目上限（防止空目录海把内存吃满）。 */
export const TREE_MAX_DIRS = 20_000
/** 重目录跳过：与旧口径一致，补上常见的构建产物目录。 */
export const TREE_SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", ".next", ".nuxt", ".output", "target",
  "__pycache__", ".venv", "build", "out", "coverage", ".cache", ".turbo",
])

const READ_CONCURRENCY = 8
const CACHE_TTL_MS = 10_000
const CACHE_MAX_ENTRIES = 24

/** 并发闸：readdir 走 libuv 线程池，限制在途数量避免一次性把队列打满。 */
function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

async function scanTree(root: string, withSizes: boolean): Promise<LocalTreeScan> {
  const resolvedRoot = path.resolve(root)
  const entries: LocalTreeEntry[] = []
  const limit = createLimiter(READ_CONCURRENCY)
  let files = 0
  let dirs = 0
  let truncated = false
  let reason: TreeTruncReason | null = null

  const cut = (why: TreeTruncReason) => {
    truncated = true
    if (reason == null) reason = why
  }

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (truncated) return
    if (depth > TREE_MAX_DEPTH) {
      cut("depth")
      return
    }
    let names: fs.Dirent[]
    try {
      names = await limit(() => fsp.readdir(dir, { withFileTypes: true }))
    } catch {
      return
    }
    names.sort((a, b) => a.name.localeCompare(b.name))
    const childDirs: Array<{ abs: string; rel: string }> = []
    for (const name of names) {
      if (truncated) return
      const relPath = rel ? `${rel}/${name.name}` : name.name
      if (name.isDirectory()) {
        if (TREE_SKIP_DIRS.has(name.name)) continue
        if (dirs >= TREE_MAX_DIRS) {
          cut("count")
          return
        }
        dirs += 1
        entries.push({ path: `${relPath}/`, type: "dir", bytes: 0 })
        childDirs.push({ abs: path.join(dir, name.name), rel: relPath })
      } else if (name.isFile()) {
        if (files >= TREE_MAX_FILES) {
          cut("count")
          return
        }
        files += 1
        let bytes = 0
        if (withSizes) {
          try {
            bytes = (await limit(() => fsp.stat(path.join(dir, name.name)))).size
          } catch {
            bytes = 0
          }
        }
        entries.push({ path: relPath, type: "file", bytes })
      }
    }
    // 并行下钻；每层都受并发闸约束，整体仍是异步、不阻塞事件循环。
    await Promise.all(childDirs.map((child) => walk(child.abs, child.rel, depth + 1)))
  }

  await walk(resolvedRoot, "", 0)
  return { entries, truncated, reason, maxDepth: TREE_MAX_DEPTH }
}

interface CacheEntry {
  at: number
  scan: LocalTreeScan
  /** 规范化根（用于按根失效）。 */
  root: string
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<LocalTreeScan>>()

function normRoot(root: string): string {
  const resolved = path.resolve(root)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function cacheKey(root: string, withSizes: boolean): string {
  return `${normRoot(root)}|${withSizes ? "s" : "f"}`
}

function trimCache(): void {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

export interface GetLocalTreeOptions {
  /** 手动重扫：绕过 TTL（in-flight 仍复用，避免并发打开重复扫）。 */
  fresh?: boolean
  /** 取文件字节数（每文件一次 stat，默认关）。 */
  withSizes?: boolean
}

export async function getLocalTree(root: string, opts: GetLocalTreeOptions = {}): Promise<LocalTreeScan> {
  const withSizes = opts.withSizes === true
  const key = cacheKey(root, withSizes)
  const running = inflight.get(key)
  if (running) return running
  const hit = cache.get(key)
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scan

  const task = scanTree(root, withSizes)
    .then((scan) => {
      cache.set(key, { at: Date.now(), scan, root: normRoot(root) })
      trimCache()
      return scan
    })
    .finally(() => { inflight.delete(key) })
  inflight.set(key, task)
  return task
}

/** chokidar 发现变化时立刻失效该根的缓存（下次请求重扫）。 */
export function invalidateTreeCache(root: string): void {
  const target = normRoot(root)
  for (const [key, entry] of [...cache]) {
    if (entry.root === target) cache.delete(key)
  }
}

/** 测试用：清空缓存（不影响 watcher）。 */
export function clearTreeCache(): void {
  cache.clear()
  inflight.clear()
}
