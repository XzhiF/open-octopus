'use client'

// 目录树窗口（v21 六轮，原型 #twin / renderTwin）：
//   「项目」页签点一行 → 在本作战 dossier（z 201）之上再弹这个窗口（z 202）。
//   · 只列本作战自己的项目（scope.projects）：任务 = task.project_ids，会话 = project_keys；
//   · 头部直给分支 + 完整路径 + 只读；左树带筛选、独立滚动；右内容独立滚动；
//   · 真数据 = GET /api/cabins/:id/repos/:name/tree|file（ff-only 只读，dir 由服务端给绝对路径）；
//   · Esc（层栈 68，压过 dossier 65）/ ✕ / 关闭 dossier 都会收窗；标题栏可拖、双击全屏。
//
// v22 九轮（右栏「目录」）：scope.mode = 'cabin' —— 根 = 本舱 cwd（一目录一舱），
//   左树（筛选 + 全展/全收），右多标签查看器（代码 / Markdown / JSON / 图片），只读不编辑。
//   数据 = GET /api/cabins/:id/tree|file；图片走 /raw（<img src> 直出）。

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import {
  cabinRawUrl, getCabinFile, getCabinTree, getRepoFile, getRepoTree, type RepoTreeEntry,
} from '@/lib/cabin-api'
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

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

function glyphOf(name: string): string {
  const ext = extOf(name)
  return ext === 'md' ? '📜' : IMAGE_EXT.has(ext) ? '🖼' : '📄'
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** 绝对路径 = tree 接口的 dir + 相对路径；分隔符跟随 dir（Windows 反斜杠 / POSIX 正斜杠）。 */
function joinAbs(dir: string, rel: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${rel.replace(/\//g, sep)}`
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(`已复制 · ${text}`)
  } catch {
    toast('复制失败 · 请手动选择路径')
  }
}

/** 桌面壳提供；浏览器里只给提示（不伪装成功）。 */
function revealInExplorer(target: string | null): void {
  if (!target) return
  const desktop = (window as unknown as {
    octopusDesktop?: { revealPath?: (path: string) => unknown }
  }).octopusDesktop
  if (desktop?.revealPath) void desktop.revealPath(target)
  else toast('在资源管理器打开 · 仅桌面端可用')
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <b key={i}>{part.slice(2, -2)}</b>
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
          return <code key={i}>{part.slice(1, -1)}</code>
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

/** Markdown 只做查看用的一小撮语法（标题 / 列表 / 引用 / 行内 code / 代码块）。 */
function MarkdownView({ src }: { src: string }) {
  const blocks: ReactNode[] = []
  let list: string[] = []
  let fence: string[] | null = null
  let key = 0
  const flushList = () => {
    if (!list.length) return
    const items = list
    blocks.push(
      <ul key={`ul${key++}`}>
        {items.map((item, i) => <li key={i}><InlineText text={item} /></li>)}
      </ul>,
    )
    list = []
  }
  const flushFence = () => {
    if (!fence) return
    blocks.push(<pre key={`pre${key++}`} className="ck12-ckt-fence"><code>{fence.join('\n')}</code></pre>)
    fence = null
  }
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fence) flushFence()
      else { flushList(); fence = [] }
      continue
    }
    if (fence) { fence.push(line); continue }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      const level = heading[1].length
      const inner = <InlineText text={heading[2]} />
      blocks.push(
        level === 1
          ? <h1 key={key++}>{inner}</h1>
          : level === 2
            ? <h2 key={key++}>{inner}</h2>
            : <h3 key={key++}>{inner}</h3>,
      )
      continue
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item) { list.push(item[1]); continue }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushList()
      blocks.push(<blockquote key={key++}><InlineText text={quote[1]} /></blockquote>)
      continue
    }
    flushList()
    if (!line.trim()) continue
    blocks.push(<p key={key++}><InlineText text={line} /></p>)
  }
  flushFence()
  flushList()
  return <>{blocks}</>
}

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
  const isCabin = scope.mode === 'cabin'
  const { projects: repos } = useCabinProjects(isCabin ? null : scope.cabinId)
  const cabinCtx = useCabinOptional()

  const [active, setActive] = useState(scope.active)
  const repo = matchRepoEntry(repos, active)
  const repoName = repo?.name ?? null
  const cabinName = cabinCtx?.cabin?.name ?? '本舱'
  const label = isCabin ? cabinName : repo?.name ?? projectNameFromKey(active)

  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null)
  const [dir, setDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentErr, setContentErr] = useState<string | null>(null)
  const [q, setQ] = useState('')

  // 本舱目录：多标签 + 每个标签的内容（成功结果缓存，切回来不重读）。
  const [tabs, setTabs] = useState<string[]>([])
  const [tab, setTab] = useState<string | null>(null)
  const [fileState, setFileState] = useState<{ path: string; content: string | null; err: string | null } | null>(null)
  const contentCache = useRef(new Map<string, string>())

  const load = useCallback(() => {
    if (!isCabin && !repoName) return
    setLoading(true)
    const request = isCabin
      ? getCabinTree(scope.cabinId)
      : getRepoTree(scope.cabinId, repoName as string)
    request
      .then((res) => {
        setEntries(res.entries)
        setDir(res.dir)
        const dirs = res.entries.filter((e) => e.type === 'dir').map((e) => e.path.replace(/\/$/, ''))
        if (isCabin) {
          // 本舱默认只展开顶层目录；文件按 cabin.md → 首个 md → 首个文件 的顺序开一个标签。
          setOpen(new Set(dirs.filter((p) => !p.includes('/'))))
          const files = res.entries.filter((e) => e.type === 'file').map((e) => e.path)
          const initial = files.find((p) => p === 'cabin.md')
            ?? files.find((p) => /\.md$/i.test(p))
            ?? files[0]
            ?? null
          setTabs(initial ? [initial] : [])
          setTab(initial)
        } else {
          // 与舱文件面板同口径：工作树默认全展开。
          setOpen(new Set(dirs))
        }
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取目录失败'))
      .finally(() => setLoading(false))
  }, [scope.cabinId, repoName, isCabin])

  useEffect(() => {
    setEntries(null)
    setSel(null)
    setContent(null)
    setContentErr(null)
    setQ('')
    setTabs([])
    setTab(null)
    setFileState(null)
    contentCache.current.clear()
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

  const openCabinTab = useCallback((path: string) => {
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setTab(path)
  }, [])

  const closeCabinTab = useCallback((path: string) => {
    const index = tabs.indexOf(path)
    if (index < 0) return
    const next = tabs.filter((p) => p !== path)
    setTabs(next)
    if (tab === path) setTab(next[Math.max(0, index - 1)] ?? null)
  }, [tabs, tab])

  const expandAll = useCallback(() => {
    setOpen(new Set((entries ?? []).filter((e) => e.type === 'dir').map((e) => e.path.replace(/\/$/, ''))))
  }, [entries])
  const collapseAll = useCallback(() => setOpen(new Set()), [])

  // 文本标签：按 path 拉内容（成功的进缓存；失败不缓存，切回来可重试）。
  useEffect(() => {
    if (!isCabin || !tab) return
    if (IMAGE_EXT.has(extOf(tab))) return
    const cached = contentCache.current.get(tab)
    if (cached !== undefined) {
      setFileState({ path: tab, content: cached, err: null })
      return
    }
    let alive = true
    setFileState({ path: tab, content: null, err: null })
    getCabinFile(scope.cabinId, tab)
      .then((res) => {
        if (!alive) return
        contentCache.current.set(tab, res.content)
        setFileState({ path: tab, content: res.content, err: null })
      })
      .catch((err: unknown) => {
        if (!alive) return
        setFileState({ path: tab, content: null, err: err instanceof Error ? err.message : '读取失败' })
      })
    return () => { alive = false }
  }, [isCabin, tab, scope.cabinId])

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
  const path = dir || (isCabin ? null : (repo?.worktree_path ?? repo?.main_path ?? null))
  const branchName = repo?.git?.branch ?? repo?.branch ?? null
  const sub = isCabin
    ? [path, '只读'].filter(Boolean).join(' · ')
    : [branchName ? `⎇ ${branchName}` : null, path, 'worktree · 只读'].filter(Boolean).join(' · ')
  const headerTitle = isCabin ? `本舱目录 · ${label}` : `目录树 · ${label}`

  const fileCount = useMemo(
    () => (entries ?? []).filter((e) => e.type === 'file').length,
    [entries],
  )

  const renderCabinPreview = (): ReactNode => {
    if (!tab) {
      return (
        <div className="ck12-ckt-empty">
          左边点一个文件，在这里按标签页打开 · 只读
          <span>代码 / Markdown / JSON 直接看，图片出预览；不做编辑</span>
        </div>
      )
    }
    const abs = path ? joinAbs(path, tab) : tab
    const ext = extOf(tab)
    const head = (
      <div className="ck12-ckt-meta">
        <span className="ck12-ckt-path" title={abs}>{abs}</span>
        <button type="button" className="ck12-ckt-ib" onClick={() => void copyToClipboard(abs)}>⧉ 复制路径</button>
        <span className="ck12-ckt-ro">本舱 · 只读</span>
      </div>
    )
    if (IMAGE_EXT.has(ext)) {
      return (
        <div className="ck12-ckt-view">
          {head}
          <div className="ck12-ckt-imgwrap">
            <img className="ck12-ckt-img" src={cabinRawUrl(scope.cabinId, tab)} alt={tab} />
          </div>
        </div>
      )
    }
    const state = fileState && fileState.path === tab ? fileState : null
    if (!state || (state.content == null && !state.err)) {
      return <div className="ck12-ckt-view">{head}<div className="ck12-ckt-empty">读文件…</div></div>
    }
    if (state.err) {
      return <div className="ck12-ckt-view">{head}<div className="ck12-ckt-empty is-err">{state.err}</div></div>
    }
    if (ext === 'md') {
      return (
        <div className="ck12-ckt-view">
          {head}
          <div className="ck12-ckt-doc"><MarkdownView src={state.content ?? ''} /></div>
        </div>
      )
    }
    const text = ext === 'json' ? prettyJson(state.content ?? '') : state.content ?? ''
    return <div className="ck12-ckt-view">{head}<pre className="ck12-ckt-code">{text}</pre></div>
  }

  const treeOpenToggle = (pathKey: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(pathKey)) next.delete(pathKey)
    else next.add(pathKey)
    return next
  })

  return (
    <div
      ref={winRef}
      className={cn('ck12-treewin', (maxed || geo) && 'is-geo')}
      style={panelStyle}
      data-testid="cockpit-treewin"
      data-mode={isCabin ? 'cabin' : 'repo'}
      data-maximized={maxed ? '1' : undefined}
      onPointerDownCapture={startDrag}
      onDoubleClick={onHeaderDoubleClick}
    >
      <DossierWindowContext.Provider value={winApi}>
        <CockpitFaceHead
          testId="cockpit-treewin-head"
          closeTestId="cockpit-treewin-close"
          glyph="⌗"
          title={headerTitle}
          sub={sub}
          onClose={onClose}
          closeLabel={isCabin ? '关闭本舱目录' : '关闭目录树'}
        />
      </DossierWindowContext.Provider>

      {isCabin ? (
        <div className="ck12-treewin-b">
          <div className="ck12-ckt-cwd" data-testid="cockpit-cabin-cwd">
            <span className="ck12-ckt-cwd-k">⌂ 本舱 cwd</span>
            <span className="ck12-ckt-cwd-p" title={path ?? undefined}>{path ?? '—'}</span>
            <span className="ck12-ckt-ro">只读</span>
            <button
              type="button"
              className="ck12-ckt-ib"
              disabled={!path}
              title="复制本舱 cwd 绝对路径"
              onClick={() => path && void copyToClipboard(path)}
            >
              ⧉ 复制路径
            </button>
            <button
              type="button"
              className="ck12-ckt-ib"
              disabled={!path}
              title="桌面壳：在资源管理器里打开本舱目录"
              onClick={() => revealInExplorer(path)}
            >
              ▦ 资源管理器
            </button>
          </div>

          <div className="ck12-ckt-body">
            <div className="ck12-ckt-side">
              <div className="ck12-ckt-search">
                <input
                  className="ck12-ckt-input"
                  value={q}
                  placeholder="筛文件…"
                  aria-label="筛选本舱文件"
                  onChange={(event) => setQ(event.target.value)}
                />
                <button type="button" className="ck12-ckt-ib" title="全部展开" aria-label="全部展开" onClick={expandAll}>⊞</button>
                <button type="button" className="ck12-ckt-ib" title="全部收起" aria-label="全部收起" onClick={collapseAll}>⊟</button>
              </div>
              <div className="ck12-ckt-scope">本舱 · {fileCount} 文件</div>
              <div className="ck12-ckt-scroll" role="tree" aria-label="本舱目录树">
                {loading && <div className="ck12-files-empty">扫磁盘…</div>}
                {error && <div className="ck12-files-empty is-err">{error}</div>}
                {!loading && !error && entries && entries.length === 0 && (
                  <div className="ck12-files-empty">本舱目录空着</div>
                )}
                {!loading && !error && keep && keep.size === 0 && (
                  <div className="ck12-files-empty">没有匹配「{q}」的文件</div>
                )}
                {!loading && !error && (
                  <TreeRows
                    nodes={tree}
                    depth={0}
                    open={open}
                    onToggle={treeOpenToggle}
                    sel={tab}
                    onSelect={openCabinTab}
                    keep={keep}
                  />
                )}
              </div>
            </div>

            <div className="ck12-ckt-main">
              <div className="ck12-ckt-tabs" role="tablist" aria-label="打开的文件">
                {tabs.map((p) => {
                  const name = p.split('/').pop() ?? p
                  return (
                    <span
                      key={p}
                      className={`ck12-ckt-tab${tab === p ? ' is-on' : ''}`}
                      role="tab"
                      aria-selected={tab === p}
                      title={p}
                      data-testid={`cockpit-cabin-tab-${p}`}
                      onClick={() => setTab(p)}
                    >
                      <span aria-hidden="true">{glyphOf(name)}</span>
                      <span className="ck12-ckt-tab-n">{name}</span>
                      <span
                        className="ck12-ckt-tab-x"
                        role="button"
                        tabIndex={-1}
                        aria-label={`关闭 ${name}`}
                        onClick={(event) => { event.stopPropagation(); closeCabinTab(p) }}
                      >
                        ✕
                      </span>
                    </span>
                  )
                })}
                {tabs.length === 0 && <span className="ck12-ckt-tabs-empty">没有打开的标签 · 点左边文件</span>}
              </div>
              {renderCabinPreview()}
            </div>
          </div>
        </div>
      ) : (
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
                  onToggle={treeOpenToggle}
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
      )}
    </div>
  )
}
