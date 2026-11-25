// packages/server/src/services/agent/clone-kit-registry.ts
//
// 分身的自定义工具包加载器（clone-dev · 2026-11-25）。
//
// 一个分身目录下可以有 `kit/`（由任务合入时从 packages/clone-kits/<slug>/ 装进来）。
// 这里只做两件事：
//   1) 按分身名解析 kit 入口（用户目录优先，仓库 workspace 包兜底，便于开发期验证）
//   2) 懒加载并缓存模块（会话开始时按分身取，合入即生效，不需要重启 server）
//
// 依赖方向是单向的：kit 可以 import 核心；核心只通过本文件按名字动态加载 kit，
// 不静态 import 任何 clone-kit（`clone-kit-boundary.test.ts` 守住这条）。

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { getCloneDir } from "./paths"
import { isValidCloneName } from "./clone-resolver"

export interface KitToolResult {
  name: string
  ok: boolean
  detail?: string
}

/** kit 模块的最小契约。工具包各自实现，server 只认这两个导出。 */
export interface CloneKitModule {
  /** 交给 SDK 的进程内 MCP server（createSdkMcpServer 的返回值）。 */
  createKitServer: (ctx: CloneKitContext) => unknown
  /** 可选自检：验证脚本会逐个跑，全部 ok 才算「工具可用」。 */
  selfTest?: (ctx: CloneKitContext) => Promise<KitToolResult[]>
  /** 声明的工具名（用于与 task_spec 对账）。 */
  tools?: string[]
}

export interface CloneKitContext {
  cloneName: string
  cloneDir: string
  /** 仓库根（开发期自检/夹具用）。 */
  repoRoot: string | null
  /** kit 自己的目录（读写夹具用）。 */
  kitDir: string
}

export interface LoadedKit {
  name: string
  entry: string
  module: CloneKitModule
}

interface CacheEntry {
  mtimeMs: number
  loaded: LoadedKit
}

const cache = new Map<string, CacheEntry>()

/** 从 cwd / 本文件向上找含 packages/clone-kits 的仓库根。 */
export function findRepoRoot(start = process.cwd()): string | null {
  const env = process.env.OCTOPUS_REPO_ROOT
  if (env && fs.existsSync(path.join(env, "packages", "clone-kits"))) return env
  let dir = path.resolve(start)
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "packages", "clone-kits"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 用户目录里的 kit 优先；仓库 workspace 包兜底（开发期尚未合入时）。 */
export function resolveKitEntry(cloneName: string): string | null {
  if (!isValidCloneName(cloneName)) return null
  const candidates = [
    path.join(getCloneDir(cloneName), "kit", "dist", cloneName, "index.js"),
    path.join(getCloneDir(cloneName), "kit", "dist", "index.js"),
    path.join(getCloneDir(cloneName), "kit", "index.js"),
  ]
  const repoRoot = findRepoRoot()
  if (repoRoot) {
    candidates.push(path.join(repoRoot, "packages", "clone-kits", "dist", cloneName, "index.js"))
    candidates.push(path.join(repoRoot, "packages", "clone-kits", cloneName, "dist", "index.js"))
    candidates.push(path.join(repoRoot, "packages", "clone-kits", cloneName, "index.js"))
  }
  for (const entry of candidates) {
    if (fs.existsSync(entry)) return entry
  }
  return null
}

export async function loadCloneKit(cloneName: string): Promise<LoadedKit | null> {
  const entry = resolveKitEntry(cloneName)
  if (!entry) return null
  const stat = fs.statSync(entry)
  const cached = cache.get(cloneName)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.loaded.entry === entry) return cached.loaded

  const mod = (await import(`${pathToFileURL(entry).href}?v=${stat.mtimeMs}`)) as Partial<CloneKitModule>
  if (typeof mod.createKitServer !== "function") {
    throw new Error(`clone kit ${cloneName} 缺少 createKitServer 导出（${entry}）`)
  }
  const loaded: LoadedKit = {
    name: cloneName,
    entry,
    module: {
      createKitServer: mod.createKitServer,
      selfTest: mod.selfTest,
      tools: mod.tools,
    },
  }
  cache.set(cloneName, { mtimeMs: stat.mtimeMs, loaded })
  return loaded
}

export function kitContext(cloneName: string, entry: string): CloneKitContext {
  const repoRoot = findRepoRoot()
  const cloneDir = getCloneDir(cloneName)
  // 用户目录装包 → kitDir 就是 <clone>/kit；仓库构建产物 → 回到源码目录。
  const kitDir = entry.startsWith(path.join(cloneDir, "kit"))
    ? path.join(cloneDir, "kit")
    : repoRoot && entry.startsWith(path.join(repoRoot, "packages", "clone-kits"))
      ? path.join(repoRoot, "packages", "clone-kits", cloneName)
      : path.dirname(entry)
  return {
    cloneName,
    cloneDir,
    repoRoot,
    kitDir,
  }
}

/** 清缓存（测试 / 合入装包后强制重载）。 */
export function clearCloneKitCache(cloneName?: string): void {
  if (cloneName) cache.delete(cloneName)
  else cache.clear()
}
