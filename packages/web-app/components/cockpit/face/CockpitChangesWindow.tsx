'use client'

// 本舱变更窗（v22 十三轮 · 2026-11-20 用户 #1）：右栏「变更」/ ⌥G 打开。
//
// 口径 = 本舱 cwd（cabin.path）这一个 git 仓库的工作区改动：
// `git diff HEAD` + 未跟踪新文件。只在 cwd 本身是独立 git 仓库时出现
// （右栏按钮 / ⌥G 都按 CabinDetail.cwd_git 判定）。
// 显示与编队「作战详情 → 变更」同构 —— 统计条 / 左树（目录 → 文件，状态 + ±行）/
// 右多标签 diff（点开才拉 patch）。只读：不提交、不暂存、不写任何文件。
//
// 窗口壳与「目录」窗同一套（ck12-treewin / CockpitFaceHead），几何各自独立：
// 两个窗可以同时开着，Esc 只收最上面一层（层栈 68）。

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import {
  getCabinWorktreeChangePatch, getCabinWorktreeChanges,
  type CabinWorktreeChangeRepo, type CabinWorktreeChanges,
} from '@/lib/cabin-api'
import { patchRows } from '@/components/tasks/files-tab/diff-view'
import { cn } from '@/lib/utils'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitFaceHead } from './CockpitFaceHead'
import { DossierWindowContext } from './dossier-window'
import {
  buildChangeTree, changeKey, changeTotals, collectChangeFiles, compactChangeDir, filterChanges,
  type ChangeEntry, type ChangeTreeNode,
} from './changes-model'

const CHANGES_LAYER_ID = 'cockpit-changes-win'
/** 与目录窗同层（68）：两者互不依赖，谁后开谁在上面由 DOM 顺序决定。 */
const CHANGES_LAYER_PRIORITY = 68

/** 状态徽标色：A 绿 / D 红 / R·C 青 / M·T 琥珀 / ? 灰。 */
const STATUS_CLASS: Record<string, string> = {
  A: 'is-a',
  D: 'is-d',
  R: 'is-r',
  C: 'is-r',
  M: 'is-m',
  T: 'is-m',
  '?': 'is-q',
}

function statusLabel(status: string): string {
  return status === '?' ? '?' : status
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(`已复制 · ${text}`)
  } catch {
    toast('复制失败 · 请手动选择路径')
  }
}

interface ChangesGeo {
  x: number
  y: number
  w: number
  h: number
}
/** 原型 twinGeo / twinMax：会话内保留，关掉再开仍回上次几何。 */
let savedGeo: ChangesGeo | null = null
let savedMax = false

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

export function CockpitChangesWindow({ cabinId, onClose }: { cabinId: string; onClose: () => void }) {
  const { layer } = useCockpitState()
  const cabinCtx = useCabinOptional()
  const cabinName = cabinCtx?.cabin?.name ?? '本舱'

  const [data, setData] = useState<CabinWorktreeChanges | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)

  const [patches, setPatches] = useState<Record<string, { text: string; truncated: boolean }>>({})
  const [patchErrors, setPatchErrors] = useState<Record<string, string>>({})
  const [patchLoading, setPatchLoading] = useState<Record<string, boolean>>({})
  const requested = useRef(new Set<string>())

  // ── 数据 ────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    setLoading(true)
    getCabinWorktreeChanges(cabinId)
      .then((res) => {
        if (!alive) return
        setData(res)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : '读取本舱变更失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [cabinId, reload])

  const entries = useMemo(() => collectChangeFiles(data?.repos ?? []), [data])
  const entryByKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries])
  const totals = useMemo(() => changeTotals(data?.repos ?? []), [data])
  /** 单元素：本舱 cwd 这一个仓库。 */
  const cwdRepo = data?.repos[0] ?? null
  const filtered = useMemo(() => filterChanges(entries, q), [entries, q])
  const visibleKeys = useMemo(() => new Set(filtered.files.map((e) => e.key)), [filtered])

  // 数据刷新后：已关/已消失的 tab 自动收起；一个都没开时默认开第一个改动文件。
  useEffect(() => {
    if (!data) return
    const alive = new Set(entries.map((e) => e.key))
    setTabs((prev) => {
      const next = prev.filter((k) => alive.has(k))
      if (next.length === 0 && entries[0]) next.push(entries[0].key)
      return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next
    })
    setActive((prev) => (prev && alive.has(prev) ? prev : entries[0]?.key ?? null))
  }, [data, entries])

  // 活动 tab 被关掉 → 落到最后一个仍打开的 tab。
  useEffect(() => {
    if (active && tabs.includes(active)) return
    setActive(tabs[tabs.length - 1] ?? null)
  }, [active, tabs])

  const loadPatch = useCallback((entry: ChangeEntry, force = false) => {
    if (entry.file.binary) return
    const key = entry.key
    if (!force && requested.current.has(key)) return
    requested.current.add(key)
    setPatchErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setPatchLoading((prev) => ({ ...prev, [key]: true }))
    getCabinWorktreeChangePatch(cabinId, entry.repo, entry.file.path, !!entry.file.untracked)
      .then((r) => setPatches((prev) => ({ ...prev, [key]: { text: r.patch, truncated: r.truncated } })))
      .catch((err: unknown) => {
        requested.current.delete(key)
        setPatchErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : '拉取 patch 失败' }))
      })
      .finally(() => setPatchLoading((prev) => ({ ...prev, [key]: false })))
  }, [cabinId])

  const selected = active ? entryByKey.get(active) ?? null : null
  useEffect(() => {
    if (selected) loadPatch(selected)
  }, [selected, loadPatch])

  const openFile = useCallback((entry: ChangeEntry) => {
    setTabs((prev) => (prev.includes(entry.key) ? prev : [...prev, entry.key]))
    setActive(entry.key)
  }, [])

  const closeTab = useCallback((key: string) => {
    const index = tabs.indexOf(key)
    if (index < 0) return
    const next = tabs.filter((k) => k !== key)
    setTabs(next)
    if (active === key) setActive(next[Math.max(0, index - 1)] ?? null)
  }, [tabs, active])

  const refresh = useCallback(() => {
    requested.current.clear()
    setPatches({})
    setPatchErrors({})
    setPatchLoading({})
    setReload((v) => v + 1)
  }, [])

  // ── 树键 / 展开收起 ────────────────────────────────────────────────
  const treeKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const repo of data?.repos ?? []) {
      if (!repo.files.length) continue
      keys.add(`${repo.name}:`)
      for (const file of repo.files) {
        const parts = file.path.split('/').filter(Boolean)
        let p = ''
        for (const part of parts.slice(0, -1)) {
          p = p ? `${p}/${part}` : part
          keys.add(changeKey(repo.name, p))
        }
      }
    }
    return [...keys]
  }, [data])

  const allCollapsed = treeKeys.length > 0 && treeKeys.every((k) => collapsed.has(k))
  const toggleAllDirs = useCallback(() => {
    setCollapsed(allCollapsed ? new Set() : new Set(treeKeys))
  }, [allCollapsed, treeKeys])

  const toggleDir = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // ── 窗口化：拖标题栏 / 双击或 ⛶ 全屏（与目录窗同一套 clamp）──────────
  const winRef = useRef<HTMLDivElement | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const [geo, setGeo] = useState<ChangesGeo | null>(savedGeo)
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
      const next: ChangesGeo = {
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

  // Esc：层栈 68 —— 只收变更窗（目录窗 / 详情面保持不动）。
  useEffect(
    () => layer.register(CHANGES_LAYER_ID, CHANGES_LAYER_PRIORITY, onClose),
    [layer, onClose],
  )

  // ── 左树 ────────────────────────────────────────────────────────────
  const byRepo = useMemo(() => {
    const map = new Map<string, ChangeEntry[]>()
    for (const entry of filtered.files) {
      const list = map.get(entry.repo) ?? []
      list.push(entry)
      map.set(entry.repo, list)
    }
    return map
  }, [filtered.files])

  const filtering = q.trim().length > 0

  const renderDir = (node: ChangeTreeNode, repo: string, depth: number): ReactNode => {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))
    const dirRows = dirNames.map((name) => {
      const { label, target } = compactChangeDir(node.dirs.get(name)!)
      const foldKey = changeKey(repo, target.path)
      const open = filtering || !collapsed.has(foldKey)
      return (
        <div key={foldKey}>
          <button
            type="button"
            className="ck12-tree-row is-dir"
            style={{ paddingLeft: 8 + depth * 12 }}
            title={label}
            onClick={() => toggleDir(foldKey)}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            <span className="ck12-tree-name">{label}/</span>
          </button>
          {open && renderDir(target, repo, depth + 1)}
        </div>
      )
    })
    const fileRows = [...node.files]
      .sort((a, b) => a.file.path.localeCompare(b.file.path))
      .map((entry) => {
        if (!visibleKeys.has(entry.key)) return null
        const on = active === entry.key
        return (
          <button
            key={entry.key}
            type="button"
            className={`ck12-tree-row ck12-chg-file${on ? ' is-on' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 + 12 }}
            title={`${entry.repo}/${entry.file.path} · +${entry.file.adds} −${entry.file.dels}`}
            data-testid={`cockpit-chg-file-${entry.key}`}
            onClick={() => openFile(entry)}
          >
            <span className={`ck12-chg-st ${STATUS_CLASS[entry.file.status] ?? 'is-m'}`}>{statusLabel(entry.file.status)}</span>
            <span className="ck12-tree-name">{entry.file.path.split('/').pop()}</span>
            <span className="ck12-chg-add">+{entry.file.adds}</span>
            <span className="ck12-chg-del">−{entry.file.dels}</span>
          </button>
        )
      })
    return <>{dirRows}{fileRows}</>
  }

  const renderTree = () => {
    if (loading && !data) return <div className="ck12-ckt-empty">读本舱 cwd 工作区…</div>
    if (error && !data) return <div className="ck12-ckt-empty is-err">{error}</div>
    if (!data) return null
    if (filtering && filtered.files.length === 0) {
      return <div className="ck12-ckt-empty">没有匹配「{q.trim()}」的文件</div>
    }
    if (data.repos.length === 0) {
      return <div className="ck12-ckt-empty">本舱 cwd 不是 git 仓库<span>变更入口只在 cwd 本身是独立 git 仓库时出现</span></div>
    }
    const cleanNames = data.repos.filter((r) => !r.files.length && !r.error).map((r) => r.name)
    const dirty = data.repos.filter((r) => r.files.length || r.error)
    return (
      <>
        {dirty.map((repo) => {
          const repoFiles = byRepo.get(repo.name) ?? []
          const foldKey = `${repo.name}:`
          const open = filtering || !collapsed.has(foldKey)
          return (
            <div key={repo.name} className="ck12-chg-repo" data-testid={`cockpit-chg-repo-${repo.name}`}>
              <button
                type="button"
                className="ck12-tree-row is-dir ck12-chg-repohead"
                onClick={() => toggleDir(foldKey)}
              >
                <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                <span className="ck12-tree-name">{repo.name}</span>
                {repo.branch && <i className="ck12-tree-tag">⎇ {repo.branch}</i>}
                <span className="ck12-tree-bytes">
                  {repo.files.length} · <b className="ck12-chg-add">+{sumOf(repo, 'adds')}</b>{' '}
                  <b className="ck12-chg-del">−{sumOf(repo, 'dels')}</b>
                </span>
              </button>
              {open && repo.error && (
                <div className="ck12-chg-repoerr" data-testid={`cockpit-chg-error-${repo.name}`}>⚠ {repo.error}</div>
              )}
              {open && repoFiles.length > 0 && renderDir(buildChangeTree(repoFiles), repo.name, 1)}
            </div>
          )
        })}
        {cleanNames.length > 0 && (
          <div className="ck12-chg-clean" data-testid="cockpit-chg-clean">
            干净 · <b>{cleanNames.join(' / ')}</b>
          </div>
        )}
      </>
    )
  }

  // ── 右栏 ────────────────────────────────────────────────────────────
  const renderPane = () => {
    if (!selected) {
      return (
        <div className="ck12-ckt-empty">
          左边点一个文件，看逐行 diff
          <span>口径 = 本舱 cwd 的工作区改动 · 只读</span>
        </div>
      )
    }
    const { repo, file } = selected
    const repoView = data?.repos.find((r) => r.name === repo)
    const patch = patches[selected.key]
    const patchErr = patchErrors[selected.key]
    const busy = patchLoading[selected.key]
    return (
      <div className="ck12-ckt-view">
        <div className="ck12-ckt-meta">
          <span className={`ck12-chg-st ${STATUS_CLASS[file.status] ?? 'is-m'}`}>{statusLabel(file.status)}</span>
          <span className="ck12-ckt-path" title={`${repo}/${file.path}`}>{repo}/{file.path}</span>
          <span className="ck12-chg-add">+{file.adds}</span>
          <span className="ck12-chg-del">−{file.dels}</span>
          <span className="ck12-ckt-ro">
            {file.untracked ? '新文件 · 未跟踪' : `worktree vs HEAD${repoView?.head ? ` · ${repoView.head}` : ''}`}
          </span>
        </div>
        {file.binary ? (
          <div className="ck12-chg-note">二进制文件 — 不出 patch（存在性即证据）。</div>
        ) : patchErr ? (
          <div className="ck12-chg-note is-err">
            {patchErr}
            <button type="button" className="ck12-ckt-ib" onClick={() => loadPatch(selected, true)}>重试</button>
          </div>
        ) : busy || !patch ? (
          <div className="ck12-chg-note">拉取 patch…</div>
        ) : (
          <div className="ck12-chg-diff" data-testid="cockpit-chg-diff">
            {patchRows(patch.text).map((row, index) => (
              <div key={index} className={`ck12-chg-ln is-${row.k}`} data-diff-line={row.k}>
                <span className="ck12-chg-no">{row.oldNo}</span>
                <span className="ck12-chg-no">{row.newNo}</span>
                <span className="ck12-chg-tx">{row.text || ' '}</span>
              </div>
            ))}
            {patch.truncated && (
              <div className="ck12-chg-ln is-trunc">[…patch 超 512K 已截断 — 完整内容请在仓库侧查看]</div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={winRef}
      className={cn('ck12-treewin ck12-chgwin', (maxed || geo) && 'is-geo')}
      style={panelStyle}
      data-testid="cockpit-chgwin"
      data-maximized={maxed ? '1' : undefined}
      onPointerDownCapture={startDrag}
      onDoubleClick={onHeaderDoubleClick}
    >
      <DossierWindowContext.Provider value={winApi}>
        <CockpitFaceHead
          testId="cockpit-chgwin-head"
          closeTestId="cockpit-chgwin-close"
          glyph="±"
          title={`本舱变更 · ${cabinName}`}
          sub={cwdRepo?.branch ? `cwd · ⎇ ${cwdRepo.branch} · 只读` : '本舱 cwd 工作区改动 · 只读'}
          onClose={onClose}
          closeLabel="关闭本舱变更"
        />
      </DossierWindowContext.Provider>

      <div className="ck12-treewin-b">
        <div className="ck12-ckt-cwd" data-testid="cockpit-chg-cwd">
          <span className="ck12-ckt-cwd-k">⌂ 本舱 cwd</span>
          <span className="ck12-ckt-cwd-p" title={data?.dir}>{data?.dir ?? '—'}</span>
          <span className="ck12-ckt-ro">
            {totals.files > 0 ? `${totals.files} 文件有改动` : '工作区干净'}
          </span>
          <button
            type="button"
            className="ck12-ckt-ib"
            title="重新读 cwd 工作区"
            data-testid="cockpit-chg-refresh"
            onClick={refresh}
          >
            ⟳ 刷新
          </button>
          <button
            type="button"
            className="ck12-ckt-ib"
            disabled={!data?.dir}
            title="复制本舱 cwd 绝对路径"
            onClick={() => data?.dir && void copyToClipboard(data.dir)}
          >
            ⧉ 复制路径
          </button>
        </div>

        <div className="ck12-chg-stats" data-testid="cockpit-chg-stats">
          <span className="is-c"><b>{totals.dirs}</b> 目录有改动</span>
          <span><b>{totals.files}</b> 文件</span>
          <span className="ck12-chg-add">+{totals.adds}</span>
          <span className="ck12-chg-del">−{totals.dels}</span>
          <span><b>{totals.untracked}</b> 未跟踪</span>
          <span className="ck12-chg-stats-sp" />
          {error && data && <span className="is-err">⚠ 刷新失败：{error} —— 下方沿上一帧</span>}
          <span className="ck12-chg-live"><i />工作区实时</span>
        </div>

        <div className="ck12-ckt-body">
          <div className="ck12-ckt-side">
            <div className="ck12-ckt-search">
              <input
                className="ck12-ckt-input"
                value={q}
                placeholder="筛文件…"
                aria-label="筛选变更文件"
                data-testid="cockpit-chg-filter"
                onChange={(event) => setQ(event.target.value)}
              />
              <button
                type="button"
                className="ck12-ckt-ib"
                title={allCollapsed ? '全部展开' : '全部收起'}
                aria-label={allCollapsed ? '全部展开' : '全部收起'}
                disabled={filtering || treeKeys.length === 0}
                onClick={toggleAllDirs}
              >
                {allCollapsed ? '⊞' : '⊟'}
              </button>
            </div>
            <div className="ck12-ckt-scope">
              本舱 cwd · {filtered.files.length} 文件{totals.files === 0 ? ' · 工作区干净' : ''}
            </div>
            <div className="ck12-ckt-scroll" role="tree" aria-label="本舱变更文件树">
              {renderTree()}
            </div>
          </div>

          <div className="ck12-ckt-main">
            <div className="ck12-ckt-tabs" role="tablist" aria-label="打开的变更文件">
              {tabs.map((key) => {
                const entry = entryByKey.get(key)
                if (!entry) return null
                const name = entry.file.path.split('/').pop() ?? entry.file.path
                return (
                  <span
                    key={key}
                    className={`ck12-ckt-tab${active === key ? ' is-on' : ''}`}
                    role="tab"
                    aria-selected={active === key}
                    title={`${entry.repo}/${entry.file.path}`}
                    data-testid={`cockpit-chg-tab-${key}`}
                    onClick={() => setActive(key)}
                  >
                    <span className={`ck12-chg-st ${STATUS_CLASS[entry.file.status] ?? 'is-m'}`}>
                      {statusLabel(entry.file.status)}
                    </span>
                    <span className="ck12-ckt-tab-n">{name}</span>
                    <span
                      className="ck12-ckt-tab-x"
                      role="button"
                      tabIndex={-1}
                      aria-label={`关闭 ${name}`}
                      onClick={(event) => { event.stopPropagation(); closeTab(key) }}
                    >
                      ✕
                    </span>
                  </span>
                )
              })}
              {tabs.length === 0 && <span className="ck12-ckt-tabs-empty">没有打开的标签 · 点左边文件</span>}
            </div>
            {renderPane()}
          </div>
        </div>
      </div>
    </div>
  )
}

function sumOf(repo: CabinWorktreeChangeRepo, field: 'adds' | 'dels'): number {
  let total = 0
  for (const file of repo.files) total += file[field]
  return total
}
