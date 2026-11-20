// 本舱变更窗的纯数据模型（v22 十三轮 · 2026-11-20 用户 #1）：
//   统计条 / 左目录树 / 键映射 —— 与 React 无关，单测钉住语义。
// 口径 = 受管目录的工作区改动（worktree vs HEAD + 未跟踪），与编队
// 「作战详情 → 变更」同一套语义（状态 + ±行 + 懒拉 patch）。

import type { CabinWorktreeChangeFile, CabinWorktreeChangeRepo } from '@/lib/cabin-api'

/** 树里的一个文件（repo + 文件成对）。 */
export interface ChangeEntry {
  repo: string
  file: CabinWorktreeChangeFile
  /** 稳定键 `${repo}:${path}`（tab / patch 缓存 / 选中都用它）。 */
  key: string
}

export interface ChangeTreeNode {
  name: string
  /** 仓内相对目录路径（根为 ""）—— 折叠键 = `${repo}:${path}`。 */
  path: string
  dirs: Map<string, ChangeTreeNode>
  files: ChangeEntry[]
}

export function changeKey(repo: string, path: string): string {
  return `${repo}:${path}`
}

/** 所有受管目录的改动文件拍平成一张表（过滤 / 树 / 统计同源）。 */
export function collectChangeFiles(repos: readonly CabinWorktreeChangeRepo[]): ChangeEntry[] {
  const out: ChangeEntry[] = []
  for (const repo of repos) {
    for (const file of repo.files) {
      out.push({ repo: repo.name, file, key: changeKey(repo.name, file.path) })
    }
  }
  return out
}

/** 统计条：有改动的目录数 / 文件 / ±行 / 未跟踪 / 干净仓数。 */
export function changeTotals(repos: readonly CabinWorktreeChangeRepo[]): {
  dirs: number
  files: number
  adds: number
  dels: number
  untracked: number
  clean: number
} {
  let dirs = 0
  let files = 0
  let adds = 0
  let dels = 0
  let untracked = 0
  for (const repo of repos) {
    if (repo.files.length) dirs += 1
    files += repo.files.length
    for (const file of repo.files) {
      adds += file.adds
      dels += file.dels
      if (file.untracked) untracked += 1
    }
  }
  return { dirs, files, adds, dels, untracked, clean: repos.length - dirs }
}

export function buildChangeTree(entries: readonly ChangeEntry[]): ChangeTreeNode {
  const root: ChangeTreeNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const entry of entries) {
    const parts = entry.file.path.split('/').filter(Boolean)
    let node = root
    for (const part of parts.slice(0, -1)) {
      const dirPath = node.path ? `${node.path}/${part}` : part
      let next = node.dirs.get(part)
      if (!next) {
        next = { name: part, path: dirPath, dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(entry)
  }
  return root
}

/** IntelliJ 风格目录压缩：当前层没有文件、且只有一个子目录时，把名字一路接起来，
 *  直到遇到「有文件」或「分叉（>1 子目录）」的那层（同 FilesTab 口径）。 */
export function compactChangeDir(node: ChangeTreeNode): { label: string; target: ChangeTreeNode } {
  let target = node
  let label = node.name
  while (target.files.length === 0 && target.dirs.size === 1) {
    const child = target.dirs.values().next().value as ChangeTreeNode
    label = `${label}/${child.name}`
    target = child
  }
  return { label, target }
}

/** 过滤：命中文件路径（含仓名）→ 文件集 + 需要展开的目录键（自动展开匹配链）。 */
export function filterChanges(
  entries: readonly ChangeEntry[],
  query: string,
): { files: ChangeEntry[]; keep: Set<string> | null } {
  const q = query.trim().toLowerCase()
  if (!q) return { files: [...entries], keep: null }
  const files: ChangeEntry[] = []
  const keep = new Set<string>()
  for (const entry of entries) {
    const hay = `${entry.repo}/${entry.file.path}`.toLowerCase()
    if (!hay.includes(q)) continue
    files.push(entry)
    const parts = entry.file.path.split('/').filter(Boolean)
    let p = ''
    for (const part of parts.slice(0, -1)) {
      p = p ? `${p}/${part}` : part
      keep.add(changeKey(entry.repo, p))
    }
  }
  return { files, keep }
}
