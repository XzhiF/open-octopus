'use client'

// v20（design 29 §6 detail 文件页签）：task home 目录树查阅（只读）。
// 真数据 = GET /api/tasks/:id/home-tree（磁盘直扫）+ home-content（任意常规
// 文件，服务端守卫不出 home / 512KB 上限）。默认展开 .scratch 链 + issues；
// 筛选自动展开匹配链；选中 mono 预览。不写任何文件。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getHomeContent, getHomeTree, type HomeTreeEntry } from '@/lib/tasks-api'

interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  bytes: number
  children: TreeNode[]
}

export type { TreeNode }

export function buildTree(entries: readonly { path: string; type: 'dir' | 'file'; bytes: number }[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', bytes: 0, children: [] }
  const dirs = new Map<string, TreeNode>([['', root]])
  const ensureDir = (path: string): TreeNode => {
    const hit = dirs.get(path)
    if (hit) return hit
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const parent = ensureDir(parentPath)
    const node: TreeNode = {
      name: path.slice(parentPath ? parentPath.length + 1 : 0),
      path,
      type: 'dir',
      bytes: 0,
      children: [],
    }
    dirs.set(path, node)
    parent.children.push(node)
    return node
  }
  for (const entry of entries) {
    if (entry.type === 'dir') {
      ensureDir(entry.path.replace(/\/$/, ''))
      continue
    }
    const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    const parent = ensureDir(parentPath)
    parent.children.push({
      name: entry.path.slice(parentPath ? parentPath.length + 1 : 0),
      path: entry.path,
      type: 'file',
      bytes: entry.bytes,
      children: [],
    })
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    for (const node of nodes) sort(node.children)
  }
  sort(root.children)
  return root.children
}

/** 默认展开：.scratch 链 + issues 链的祖先目录（design 29 §6）。 */
function defaultOpen(entries: readonly HomeTreeEntry[]): Set<string> {
  const open = new Set<string>()
  for (const entry of entries) {
    if (!/(^|\/)(\.scratch|issues)(\/|$)/.test(entry.path)) continue
    const parts = entry.path.replace(/\/$/, '').split('/')
    for (let i = 1; i < parts.length; i += 1) open.add(parts.slice(0, i).join('/'))
  }
  return open
}

export function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'))
  return out
}

export function TreeRows({
  nodes,
  depth,
  open,
  onToggle,
  sel,
  onSelect,
  keep,
  badges,
}: {
  nodes: TreeNode[]
  depth: number
  open: ReadonlySet<string>
  onToggle(path: string): void
  sel: string | null
  onSelect(path: string): void
  keep: ReadonlySet<string> | null
  /** path → 徽标文案（ws 面板：被改文件 = 作战 short）。 */
  badges?: ReadonlyMap<string, string>
}) {
  return (
    <>
      {nodes.map((node) => {
        if (keep && !keep.has(node.path)) return null
        const isOpen = open.has(node.path) || !!keep
        if (node.type === 'dir') {
          return (
            <div key={node.path}>
              <button
                type="button"
                className="ck12-tree-row is-dir"
                style={{ paddingLeft: 8 + depth * 12 }}
                aria-expanded={isOpen}
                onClick={() => onToggle(node.path)}
              >
                <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                <span className="ck12-tree-name">{node.name}/</span>
              </button>
              {isOpen && (
                <TreeRows
                  nodes={node.children}
                  depth={depth + 1}
                  open={open}
                  onToggle={onToggle}
                  sel={sel}
                  onSelect={onSelect}
                  keep={keep}
                  badges={badges}
                />
              )}
            </div>
          )
        }
        const tag = badges?.get(node.path)
          ?? (node.name === 'spec.md' ? 'spec' : /(^|\/)issues\/\d+/.test(node.path) ? '票' : null)
        return (
          <button
            key={node.path}
            type="button"
            className={`ck12-tree-row${sel === node.path ? ' is-on' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 + 12 }}
            data-testid={`cockpit-tree-file-${node.path}`}
            onClick={() => onSelect(node.path)}
          >
            <span className="ck12-tree-name">{node.name}</span>
            {tag && <i className="ck12-tree-tag">{tag}</i>}
            {/* 目录扫描默认不取每文件字节（2026-11-24）；0 = 未取，不显示 0b 噪音。 */}
            {node.bytes > 0 && (
              <span className="ck12-tree-bytes">{node.bytes > 1024 ? `${Math.round(node.bytes / 1024)}k` : `${node.bytes}b`}</span>
            )}
          </button>
        )
      })}
    </>
  )
}

export function CockpitJobFiles({ taskId }: { taskId: string | null }) {
  const [entries, setEntries] = useState<HomeTreeEntry[] | null>(null)
  const [dir, setDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentErr, setContentErr] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const load = useCallback(() => {
    if (!taskId) return
    setLoading(true)
    getHomeTree(taskId)
      .then((res) => {
        setEntries(res.entries)
        setDir(res.dir)
        setOpen(defaultOpen(res.entries))
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取 task home 失败'))
      .finally(() => setLoading(false))
  }, [taskId])

  useEffect(() => {
    setEntries(null)
    setSel(null)
    setContent(null)
    setContentErr(null)
    setQ('')
    load()
  }, [load])

  const tree = useMemo(() => buildTree(entries ?? []), [entries])

  const keep = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query || !entries) return null
    const set = new Set<string>()
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.path.toLowerCase().includes(query)) continue
      set.add(entry.path)
      for (const ancestor of ancestorsOf(entry.path)) set.add(ancestor)
    }
    return set
  }, [q, entries])

  const select = useCallback((path: string) => {
    if (!taskId) return
    setSel(path)
    setContent(null)
    setContentErr(null)
    getHomeContent(taskId, path)
      .then((res) => setContent(res.content))
      .catch((err: unknown) => setContentErr(err instanceof Error ? err.message : '读取失败'))
  }, [taskId])

  if (!taskId) {
    return <div className="ck12-files-empty">只有任务类作业有 task home 目录树</div>
  }

  return (
    <div className="ck12-files" data-testid="cockpit-job-files-tree">
      <div className="ck12-files-h">
        <span className="ck12-files-dir" title={dir}>{dir || 'task home'}</span>
        <input
          className="ck12-files-q"
          value={q}
          placeholder="筛文件（自动展开匹配链）"
          aria-label="筛选 task home 文件"
          onChange={(event) => setQ(event.target.value)}
        />
        <button type="button" className="ck12-files-re" title="重扫磁盘" onClick={load}>↻</button>
      </div>
      <div className="ck12-files-b">
        <div className="ck12-files-tree" role="tree" aria-label="task home 目录树">
          {loading && <div className="ck12-files-empty">扫磁盘…</div>}
          {error && <div className="ck12-files-empty is-err">{error}</div>}
          {!loading && !error && entries && entries.length === 0 && (
            <div className="ck12-files-empty">home 还空着 · 作者落盘后这里会出现</div>
          )}
          {!loading && !error && keep && keep.size === 0 && (
            <div className="ck12-files-empty">没有匹配「{q}」的文件</div>
          )}
          {!loading && !error && (
            <TreeRows
              nodes={tree}
              depth={0}
              open={open}
              onToggle={(path) => setOpen((prev) => {
                const next = new Set(prev)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })}
              sel={sel}
              onSelect={select}
              keep={keep}
            />
          )}
        </div>
        <div className="ck12-files-preview">
          {sel ? (
            <>
              <div className="ck12-files-ph">
                <b>{sel}</b>
                <span>只读 · home-content</span>
              </div>
              {contentErr && <div className="ck12-files-empty is-err">{contentErr}</div>}
              {!contentErr && content == null && <div className="ck12-files-empty">读文件…</div>}
              {!contentErr && content != null && <pre className="ck12-files-pre">{content}</pre>}
            </>
          ) : (
            <div className="ck12-files-empty">点一个文件看内容（spec / issues / round-report…）</div>
          )}
        </div>
      </div>
    </div>
  )
}
