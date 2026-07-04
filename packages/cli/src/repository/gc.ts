/**
 * GcScanner — 扫描仓库 cache 目录，找出未被 registry 引用的缓存条目
 *
 * 从 commands/repo.ts `gc` 子命令中提取的独立模块，
 * 支持 dry-run 预览与实际清理两种模式。
 */
import { join } from "path"
import { existsSync, readdirSync, rmSync, statSync } from "fs"
import { computeDirSize } from "@octopus/shared"
import type { ResourceType } from "@octopus/shared"

export interface GcEntry {
  /** 相对仓库根目录的路径 (e.g. "cache/skill/foo") */
  relPath: string
  /** 磁盘占用字节 */
  sizeBytes: number
}

export interface GcResult {
  /** 将被（或已经）移除的条目 */
  unused: GcEntry[]
  /** 总释放字节 */
  freedBytes: number
  /** registry 中仍被引用的条目数 */
  retained: number
}

const RESOURCE_TYPES: ResourceType[] = ["skill", "agent", "workflow", "source"]

/**
 * 扫描 cache 目录，返回未被引用的缓存条目
 *
 * @param repoDir   仓库根目录
 * @param usedPaths 当前 registry 中所有 entry 的 cache_path 集合
 */
export function scanUnusedCache(
  repoDir: string,
  usedPaths: Set<string>,
): GcEntry[] {
  const cacheDir = join(repoDir, "cache")
  if (!existsSync(cacheDir)) return []

  const unused: GcEntry[] = []

  for (const type of RESOURCE_TYPES) {
    const typeDir = join(cacheDir, type)
    if (!existsSync(typeDir)) continue

    for (const dir of readdirSync(typeDir)) {
      const relPath = join("cache", type, dir)
      if (usedPaths.has(relPath)) continue

      const fullPath = join(repoDir, relPath)
      let sizeBytes = 0
      try {
        const stat = statSync(fullPath)
        sizeBytes = stat.isDirectory() ? computeDirSize(fullPath) : stat.size
      } catch {
        // skip entries we can't stat
      }
      unused.push({ relPath, sizeBytes })
    }
  }

  return unused
}

/**
 * 执行清理：删除所有未使用的缓存目录
 */
export function runGc(repoDir: string, unused: GcEntry[]): void {
  for (const entry of unused) {
    const fullPath = join(repoDir, entry.relPath)
    if (existsSync(fullPath)) {
      rmSync(fullPath, { recursive: true, force: true })
    }
  }
}

/**
 * 聚合 GC 结果（保留条目数由调用方传入）
 */
export function aggregateGcResult(unused: GcEntry[], retained: number): GcResult {
  return {
    unused,
    freedBytes: unused.reduce((sum, e) => sum + e.sizeBytes, 0),
    retained,
  }
}
