"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { FsNode, KcTree, KcTreeEntry } from "@/lib/knowledge/knowledge-center-api"

/**
 * 知识导航树 — 知识根 `.octopus/knowledge` 的**真实目录树**（改版 20261016，
 * 替代原「按页型五类分组」投影——用户 dogfood 裁定：按实际目录显示）。
 *
 * 数据面：fs 树（GET /api/knowledge/fs，服务端 services/knowledge/fs.ts 单源，
 * 已排除 .git/隐藏/user_preference）+ tree API（wiki 页元数据覆盖层）。
 * 覆盖索引判据（防错绑钉）：**全路径精确等值** `"wiki/" + entry.path`——
 * 绝不走 resolveKcPageTarget 的尾段配（会把 _retired 叶错绑活跃页）；
 * 未命中 entry 的 .md（SCHEMA/drafts/_archive/_retired/未编散页）一律 DocView 兜底。
 *
 * System 三入口收进树：wiki/INDEX.md 叶→总览、wiki/LOG.md 叶→时间线、
 * raw/ 目录行→原料库清单（点击=展开+切视图双动作，A6）；raw 叶走既有 RawView 通道
 * （fs path ≡ RawPointer.path，同为知识根相对）。旧 testid kc-select-index/log/rawlib
 * 直接钉在对应语义节点上（动线测试零改位）。
 * 展开态纯视图态（内存）；初始=智能展开：根下两层内、非 "_" 前缀且非 raw 的目录自动开
 * ——活页叶直接可见（旧平铺视图的信息密度不降级），_retired/_migration/raw/_archive 归档收起。
 * 页叶 aria-label=页标题（旧「按标题点页」动线兼容；行面文本 = 真实文件名）。
 * 行选择主通道 = data-kc-fs-path 属性（testid 的 path 清洗可撞名，仅供挂载证明）。
 */

export interface KcKnowledgeTreeProps {
  fs: FsNode[]
  tree: KcTree | null
  /** 当前视图的目标节点 fs path（高亮唯一落点；目录行仅 raw 有选中语义） */
  selectedPath: string | null
  onSelectPage: (id: string) => void
  onSelectIndex: () => void
  onSelectLog: () => void
  onSelectRawLib: () => void
  onOpenRaw: (pointerPath: string) => void
  onOpenDoc: (fsPath: string) => void
}

/** entry.path（wiki 相对）→ fs.path（知识根相对）全路径精确索引。 */
function buildWikiEntryMap(tree: KcTree | null): Map<string, KcTreeEntry> {
  const map = new Map<string, KcTreeEntry>()
  if (!tree) return map
  for (const d of tree.domains) for (const e of d.entries) map.set(`wiki/${e.path}`, e)
  return map
}

/** testid：语义节点用旧名（动线兼容），其余用 path 清洗（仅挂载证明，定位走 data-kc-fs-path）。 */
function testidOf(node: FsNode): string {
  if (node.path === "wiki/INDEX.md") return "kc-select-index"
  if (node.path === "wiki/LOG.md") return "kc-select-log"
  if (node.path === "raw") return "kc-select-rawlib"
  return `kc-tree-${node.kind}-${node.path.replace(/[^a-zA-Z0-9._-]/g, "-")}`
}

interface RowProps extends Omit<KcKnowledgeTreeProps, "fs" | "tree"> {
  node: FsNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  entryMap: Map<string, KcTreeEntry>
}

function FsRow({ node, depth, expanded, toggle, entryMap, selectedPath, onSelectPage, onSelectIndex, onSelectLog, onSelectRawLib, onOpenRaw, onOpenDoc }: RowProps) {
  const isDir = node.kind === "dir"
  const isOpen = expanded.has(node.path)
  const entry = !isDir ? entryMap.get(node.path) : undefined
  const readable = isDir || node.path.endsWith(".md")
  const selected = selectedPath === node.path

  const onClick = () => {
    if (isDir) {
      if (node.path === "raw") onSelectRawLib() // 目录行双动作：展开 + 原料库清单
      toggle(node.path)
      return
    }
    if (node.path === "wiki/INDEX.md") return onSelectIndex()
    if (node.path === "wiki/LOG.md") return onSelectLog()
    if (node.path.startsWith("raw/")) return onOpenRaw(node.path) // fs path ≡ RawPointer.path
    if (entry) return onSelectPage(entry.id)
    if (node.path.endsWith(".md")) return onOpenDoc(node.path)
  }

  const tip = isDir
    ? node.path
    : entry
      ? `${node.path} — ${entry.title}`
      : readable
        ? node.path
        : `${node.path}（非 .md，不可打开）`

  return (
    <>
      <button
        type="button"
        data-testid={testidOf(node)}
        data-kc-fs-path={node.path}
        aria-label={entry ? entry.title : undefined}
        disabled={!readable}
        onClick={onClick}
        title={tip}
        aria-expanded={isDir ? isOpen : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs font-bold",
          readable ? "text-pop-ink hover:bg-accent" : "cursor-default text-pop-dim/60",
          selected && "bg-pop-pink-soft",
        )}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="w-3 shrink-0 text-[9px] text-pop-dim">{isDir ? (isOpen ? "▾" : "▸") : ""}</span>
        <span className="shrink-0">{isDir ? "📁" : "📄"}</span>
        <span className="truncate flex-1">{node.name}</span>
        {entry && entry.ruleCount > 0 && <span className="shrink-0 text-[9px] text-pop-dim">约束×{entry.ruleCount}</span>}
      </button>
      {isDir && isOpen && (node.children ?? []).map(child => (
        <FsRow
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          toggle={toggle}
          entryMap={entryMap}
          selectedPath={selectedPath}
          onSelectPage={onSelectPage}
          onSelectIndex={onSelectIndex}
          onSelectLog={onSelectLog}
          onSelectRawLib={onSelectRawLib}
          onOpenRaw={onOpenRaw}
          onOpenDoc={onOpenDoc}
        />
      ))}
    </>
  )
}

/** 初始展开集：见文件头「智能展开」律。 */
function initialExpanded(fs: FsNode[]): Set<string> {
  const out = new Set<string>()
  const walk = (nodes: FsNode[], depth: number) => {
    for (const n of nodes) {
      if (n.kind !== "dir" || n.name.startsWith("_") || n.name === "raw") continue
      if (depth >= 2) continue
      out.add(n.path)
      walk(n.children ?? [], depth + 1)
    }
  }
  walk(fs, 0)
  return out
}

/** 收集全部目录 path（一键展开用；归档默认收起是常态，全开是显式动作）。 */
function allDirPaths(fs: FsNode[]): string[] {
  const out: string[] = []
  const walk = (nodes: FsNode[]) => {
    for (const n of nodes) if (n.kind === "dir") { out.push(n.path); walk(n.children ?? []) }
  }
  walk(fs)
  return out
}

export function KcKnowledgeTree({ fs, tree, selectedPath, ...handlers }: KcKnowledgeTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(fs))
  const entryMap = buildWikiEntryMap(tree)
  const toggle = (p: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(p)) next.delete(p); else next.add(p)
    return next
  })
  const dirs = allDirPaths(fs)
  const allOpen = dirs.every(d => expanded.has(d))
  const expandAll = () => setExpanded(new Set(dirs))
  const collapseAll = () => setExpanded(new Set())

  return (
    <nav aria-label="知识目录树" className="space-y-0.5">
      {/* 根行 = 开关（点行 展开↔收起全树）；右侧两小钮给显式一键动作（到界即灰） */}
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          data-testid="kc-tree-root-toggle"
          onClick={() => (allOpen ? collapseAll() : expandAll())}
          title={allOpen ? "收起全部目录" : "展开全部目录"}
          className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[10px] font-black uppercase tracking-wider text-pop-dim hover:bg-accent hover:text-pop-ink"
        >
          <span className="w-3 text-[9px]">{allOpen ? "▾" : "▸"}</span>
          📦 knowledge/
        </button>
        <button
          type="button"
          data-testid="kc-tree-expand-all"
          onClick={expandAll}
          title="一键展开全部目录"
          disabled={allOpen}
          className="rounded border-[1.5px] border-pop-bd px-1 py-0.5 text-[9px] font-black text-pop-dim enabled:hover:bg-accent enabled:hover:text-pop-ink disabled:opacity-35"
        >
          ⤓展开
        </button>
        <button
          type="button"
          data-testid="kc-tree-collapse-all"
          onClick={collapseAll}
          title="一键收起全部目录（只留根层）"
          disabled={expanded.size === 0}
          className="rounded border-[1.5px] border-pop-bd px-1 py-0.5 text-[9px] font-black text-pop-dim enabled:hover:bg-accent enabled:hover:text-pop-ink disabled:opacity-35"
        >
          ⤒收起
        </button>
      </div>
      {fs.map(node => (
        <FsRow key={node.path} node={node} depth={0} expanded={expanded} toggle={toggle} entryMap={entryMap} selectedPath={selectedPath} {...handlers} />
      ))}
    </nav>
  )
}
