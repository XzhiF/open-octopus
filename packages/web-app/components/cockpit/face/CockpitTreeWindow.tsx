'use client'

// 目录树窗口（v21 六轮，原型 #twin / renderTwin）：
//   「项目」页签点一行 → 在本作战 dossier（z 201）之上再弹这个窗口（z 202）。
//   · 只列本作战自己的项目（scope.projects）：任务 = task.project_ids，会话 = project_keys；
//   · 头部直给分支 + 完整路径 + 只读；左树带筛选、独立滚动；右内容独立滚动；
//   · 真数据 = GET /api/cabins/:id/repos/:name/tree|file（ff-only 只读，dir 由服务端给绝对路径）；
//   · Esc（层栈 68，压过 dossier 65）/ ✕ / 关闭 dossier 都会收窗；标题栏可拖、双击全屏。

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { getRepoFile, getRepoTree, type RepoTreeEntry } from '@/lib/cabin-api'
import { cn } from '@/lib/utils'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinProjects } from '../projects/use-cabin-projects'
import { matchRepoEntry, projectNameFromKey } from '../projects/project-model'
import { ancestorsOf, buildTree, TreeRows } from './CockpitJobFiles'
import { CockpitFaceHead } from './CockpitFaceHead'
import { DossierWindowContext } from './dossier-window'
import type { CockpitTreeScope } from './tree-window'

const TREE_LAYER_ID = 'cockpit-tree-win'
/** 高于 dossier（65）：Esc 先收目录树，再收详情面；低于问答窗 75。 */
const TREE_LAYER_PRIORITY = 68

interface TreeGeo {
  x: number
  y: number
  w: number
  h: number
}
/** 原型 state.twinGeo / twinMax：会话内保留，关掉再开仍回上次几何。 */
let savedGeo: TreeGeo | null = null
let savedMax = false

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

export interface CockpitTreeWindowProps {
  scope: CockpitTreeScope
  onClose: () => void
}

export function CockpitTreeWindow({ scope, onClose }: CockpitTreeWindowProps) {
  const { layer } = useCockpitState()
  const { projects: repos } = useCabinProjects(scope.cabinId)

  const [active, setActive] = useState(scope.active)
  const repo = matchRepoEntry(repos, active)
  const repoName = repo?.name ?? null
  const label = repo?.name ?? projectNameFromKey(active)

  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null)
  const [dir, setDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentErr, setContentErr] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const load = useCallback(() => {
    if (!repoName) return
    setLoading(true)
    getRepoTree(scope.cabinId, repoName)
      .then((res) => {
        setEntries(res.entries)
        setDir(res.dir)
        // 与舱文件面板同口径：工作树默认全展开。
        setOpen(new Set(res.entries.filter((e) => e.type === 'dir').map((e) => e.path.replace(/\/$/, ''))))
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取工作树失败'))
      .finally(() => setLoading(false))
  }, [scope.cabinId, repoName])

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

  const selectFile = useCallback((path: string) => {
    if (!repoName) return
    setSel(path)
    setContent(null)
    setContentErr(null)
    getRepoFile(scope.cabinId, repoName, path)
      .then((res) => setContent(res.content))
      .catch((err: unknown) => setContentErr(err instanceof Error ? err.message : '读取失败'))
  }, [scope.cabinId, repoName])

  // ── 窗口化：拖标题栏 / 双击或 ⛶ 全屏（与 dossier 同一套 clamp）──────────
  const winRef = useRef<HTMLDivElement | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const [geo, setGeo] = useState<TreeGeo | null>(savedGeo)
  const [maxed, setMaxed] = useState(savedMax)
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1600 : window.innerWidth,
    h: typeof window === 'undefined' ? 900 : window.innerHeight,
  }))

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  const toggleMax = useCallback(() => {
    if (!maxed) {
      const el = winRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const snapshot = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        }
        savedGeo = snapshot
        setGeo(snapshot)
      }
      savedMax = true
      setMaxed(true)
    } else {
      savedMax = false
      setMaxed(false)
    }
  }, [maxed])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (maxed) return
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input, select, a, [data-no-drag]')) return
    if (!target.closest('.ck12-dh')) return
    const el = winRef.current
    if (!el) return
    event.preventDefault()
    const r = el.getBoundingClientRect()
    const start = { x: r.left, y: r.top, w: r.width, h: r.height }
    const sx = event.clientX
    const sy = event.clientY
    const move = (ev: PointerEvent) => {
      const next: TreeGeo = {
        x: clamp(start.x + ev.clientX - sx, 4, Math.max(4, window.innerWidth - start.w - 4)),
        y: clamp(start.y + ev.clientY - sy, 52, Math.max(52, window.innerHeight - start.h - 4)),
        w: start.w,
        h: start.h,
      }
      savedGeo = next
      setGeo(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragCleanupRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    dragCleanupRef.current = up
  }, [maxed])

  const onHeaderDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input, select, a')) return
    if (!target.closest('.ck12-dh')) return
    toggleMax()
  }, [toggleMax])

  const winApi = useMemo(() => ({ maximized: maxed, toggleMax }), [maxed, toggleMax])

  const panelStyle: CSSProperties | undefined = maxed
    ? {
      left: 5,
      top: 52,
      width: Math.max(420, viewport.w - 10),
      height: Math.max(300, viewport.h - 58),
      transform: 'none',
    }
    : geo
      ? { left: geo.x, top: geo.y, width: geo.w, height: geo.h, transform: 'none' }
      : undefined

  // Esc：层栈 68 —— 先收树窗，dossier 保持不动。
  useEffect(
    () => layer.register(TREE_LAYER_ID, TREE_LAYER_PRIORITY, onClose),
    [layer, onClose],
  )

  // 完整路径：服务端 tree 接口给的绝对路径为准；未加载时退回舱籍读数。
  const path = dir || repo?.worktree_path || repo?.main_path || null
  const branchName = repo?.git?.branch ?? repo?.branch ?? null
  const sub = [branchName ? `⎇ ${branchName}` : null, path, 'worktree · 只读'].filter(Boolean).join(' · ')

  return (
    <div
      ref={winRef}
      className={cn('ck12-treewin', (maxed || geo) && 'is-geo')}
      style={panelStyle}
      data-testid="cockpit-treewin"
      data-maximized={maxed ? '1' : undefined}
      onPointerDownCapture={startDrag}
      onDoubleClick={onHeaderDoubleClick}
    >
      <DossierWindowContext.Provider value={winApi}>
        <CockpitFaceHead
          testId="cockpit-treewin-head"
          closeTestId="cockpit-treewin-close"
          glyph="⌗"
          title={`目录树 · ${label}`}
          sub={sub}
          onClose={onClose}
          closeLabel="关闭目录树"
        />
      </DossierWindowContext.Provider>

      <div className="ck12-treewin-b">
        <div className="ck12-ws-chips" data-testid="cockpit-treewin-chips">
          {scope.projects.map((key) => {
            const name = matchRepoEntry(repos, key)?.name ?? projectNameFromKey(key)
            return (
              <button
                key={key}
                type="button"
                className={`ck12-ws-chip${key === active ? ' is-on' : ''}`}
                data-testid={`cockpit-treewin-chip-${name}`}
                onClick={() => setActive(key)}
              >
                {name}
              </button>
            )
          })}
        </div>

        <div className="ck12-files-h">
          <span className="ck12-files-dir" data-testid="cockpit-treewin-dir" title={path ?? undefined}>
            {path ?? 'worktree'}
          </span>
          <input
            className="ck12-files-q"
            value={q}
            placeholder="筛文件（自动展开匹配链）"
            aria-label="筛选工作树文件"
            onChange={(event) => setQ(event.target.value)}
          />
          <button type="button" className="ck12-files-re" title="重扫磁盘" onClick={load}>↻</button>
        </div>

        <div className="ck12-files-b">
          <div className="ck12-files-tree" role="tree" aria-label="工作树目录树">
            {!repoName && <div className="ck12-files-empty">这个项目不在当前舱的关联里</div>}
            {repoName && loading && <div className="ck12-files-empty">扫磁盘…</div>}
            {repoName && error && <div className="ck12-files-empty is-err">{error}</div>}
            {repoName && !loading && !error && entries && entries.length === 0 && (
              <div className="ck12-files-empty">工作树空着</div>
            )}
            {repoName && !loading && !error && keep && keep.size === 0 && (
              <div className="ck12-files-empty">没有匹配「{q}」的文件</div>
            )}
            {repoName && !loading && !error && (
              <TreeRows
                nodes={tree}
                depth={0}
                open={open}
                onToggle={(pathKey) => setOpen((prev) => {
                  const next = new Set(prev)
                  if (next.has(pathKey)) next.delete(pathKey)
                  else next.add(pathKey)
                  return next
                })}
                sel={sel}
                onSelect={selectFile}
                keep={keep}
              />
            )}
          </div>

          <div className="ck12-files-preview">
            {sel ? (
              <>
                <div className="ck12-files-ph">
                  <b>{sel}</b>
                  <span>只读 · worktree file</span>
                </div>
                {contentErr && <div className="ck12-files-empty is-err">{contentErr}</div>}
                {!contentErr && content == null && <div className="ck12-files-empty">读文件…</div>}
                {!contentErr && content != null && <pre className="ck12-files-pre">{content}</pre>}
              </>
            ) : (
              <div className="ck12-files-empty">点一个文件看内容（只读，不改工作树）</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
