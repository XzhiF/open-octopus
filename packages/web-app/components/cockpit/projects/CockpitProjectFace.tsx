'use client'

// 项目面（2026-11-23 用户 #1 · 二轮）：点项目只看三样 ——
//   分支信息（压成一行）/ 文件浏览器 / git 变更（两个页签）。
// 作战清单、工作树、远端、动作按钮、教学长文全部不显示。
//
// 真数据：
//   文件浏览器 = GET /api/cabins/:id/repos/:name/tree|file（ff-only 只读）；
//   git 变更   = GET /api/cabins/:id/repos/:name/worktree-changes（worktree vs HEAD
//                + 未跟踪）+ /patch（点开才拉）。
// 变更树与线上变更窗同一口径：目录分组 + 单链目录缩成一级（compactChangeDir），
// 右侧逐行 diff；只读，不提交、不暂存、不写任何文件。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  getRepoFile, getRepoWorktreeChangePatch, getRepoWorktreeChanges,
  setCabinRepoMainline,
  type CabinRepoEntry, type CabinWorktreeChanges,
} from '@/lib/cabin-api'
import { formatDateTime } from '@/lib/format'
import { patchRows } from '@/components/tasks/files-tab/diff-view'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinProjects } from './use-cabin-projects'
import { rosterRef } from './project-model'
import { buildTree, TreeRows } from '../face/CockpitJobFiles'
import { CockpitFaceHead } from '../face/CockpitFaceHead'
import { useTreeScan } from '../face/use-tree-scan'
import {
  buildChangeTree, collectChangeFiles, compactChangeDir,
  type ChangeEntry, type ChangeTreeNode,
} from '../face/changes-model'

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

type ProjectTab = 'files' | 'changes'

export interface CockpitProjectFaceProps {
  cabinId: string
  projectKey: string
  onClose: () => void
}

export function CockpitProjectFace({ cabinId, projectKey, onClose }: CockpitProjectFaceProps) {
  const { select } = useCockpitState()
  const { projects, loading, error, refetch } = useCabinProjects(cabinId)
  const project = projects.find((p) => p.key === projectKey)

  if (!project) {
    return (
      <>
        <CockpitFaceHead
          glyph="⧉"
          title={projectKey}
          sub="项目"
          onClose={onClose}
          closeLabel="收起项目面"
        />
        <div className="ck12-face-body" data-testid="cockpit-project-face">
          <div className="ck12-face-empty" data-testid="cockpit-project-missing">
            {loading
              ? '载入项目…'
              : error
                ? `项目数据加载失败 · ${error}`
                : '这个项目不在当前舱的关联里（可能刚解绑）。'}
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <CockpitFaceHead
        glyph="⧉"
        title={`项目 · ${project.name}`}
        sub={`${sourceLabel(project)} · 主仓只读`}
        onClose={onClose}
        closeLabel="收起项目面"
        actions={(
          <button
            type="button"
            className="ck12-pjback"
            data-testid="project-back-roster"
            onClick={() => select(rosterRef(cabinId))}
          >
            ← 舱籍总览
          </button>
        )}
      />
      <ProjectFaceBody cabinId={cabinId} project={project} onProjectsChanged={refetch} />
    </>
  )
}

function sourceLabel(project: CabinRepoEntry): string {
  if (project.source === 'org') {
    return ['ORG', project.org, project.group && project.group !== project.org ? project.group : null]
      .filter(Boolean).join(' · ')
  }
  return project.external ? '外部目录' : '本地目录'
}

function ProjectFaceBody({
  cabinId, project, onProjectsChanged,
}: { cabinId: string; project: CabinRepoEntry; onProjectsChanged: () => void }) {
  const [tab, setTab] = useState<ProjectTab>('files')

  // ── 文件浏览器 ──
  // 2026-11-24 目录窗优化：与目录树窗口共用 useTreeScan（异步扫描 + 缓存 +
  // chokidar 增量刷新）；静默刷新不动展开 / 选中。
  const scan = useTreeScan({ cabinId, repoName: project.name })
  const entries = scan.entries
  const treeDir = scan.dir
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [file, setFile] = useState<{ path: string; content: string | null; err: string | null } | null>(null)
  const treeNodes = useMemo(() => buildTree(entries ?? []), [entries])

  // ── git 变更 ──
  const [changes, setChanges] = useState<CabinWorktreeChanges | null>(null)
  const [chgLoading, setChgLoading] = useState(true)
  const [chgErr, setChgErr] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [chgSel, setChgSel] = useState<string | null>(null)
  const [patches, setPatches] = useState<Record<string, { text: string; truncated: boolean }>>({})
  const [patchErrors, setPatchErrors] = useState<Record<string, string>>({})
  const [patchLoading, setPatchLoading] = useState<Record<string, boolean>>({})
  const requested = useRef(new Set<string>())

  const repoName = project.name

  // 文件树：换项目 / 首次载入才回文件页签、重置展开与选中；静默刷新不动。
  const initGenRef = useRef(0)
  useEffect(() => {
    if (scan.generation === 0 || !scan.entries) return
    if (initGenRef.current === scan.generation) return
    initGenRef.current = scan.generation
    setTab('files')
    setCollapsed(new Set())
    // 2026-11-24：默认只展开顶层目录（大仓不再一次铺满）；深层文件靠筛选/手动展开。
    const dirs = scan.entries.filter((e) => e.type === 'dir').map((e) => e.path.replace(/\/$/, ''))
    setOpen(new Set(dirs.filter((p) => !p.includes('/'))))
    // 选中根层第一个文件（深层文件不在默认展开里）。
    setSel(scan.entries.find((e) => e.type === 'file' && !e.path.includes('/'))?.path ?? null)
    setFile(null)
  }, [scan.generation, scan.entries])

  // 选中文件 → 拉内容（成功不缓存切换成本很低，保持简单）。
  useEffect(() => {
    if (!sel) {
      setFile(null)
      return
    }
    let alive = true
    setFile({ path: sel, content: null, err: null })
    getRepoFile(cabinId, repoName, sel)
      .then((res) => { if (alive) setFile({ path: sel, content: res.content, err: null }) })
      .catch((err: unknown) => {
        if (alive) setFile({ path: sel, content: null, err: err instanceof Error ? err.message : '读取失败' })
      })
    return () => { alive = false }
  }, [cabinId, repoName, sel])

  // 工作区改动：与页签无关，先拉（两个页签的数字都要用）。
  useEffect(() => {
    let alive = true
    setChgLoading(true)
    setChgErr(null)
    setChanges(null)
    setChgSel(null)
    setPatches({})
    setPatchErrors({})
    setPatchLoading({})
    requested.current.clear()
    getRepoWorktreeChanges(cabinId, repoName)
      .then((res) => {
        if (!alive) return
        setChanges(res)
        setChgSel(res.repos.find((r) => r.files.length)?.files[0]?.path ?? null)
      })
      .catch((err: unknown) => {
        if (alive) setChgErr(err instanceof Error ? err.message : '读取工作区改动失败')
      })
      .finally(() => {
        if (alive) setChgLoading(false)
      })
    return () => { alive = false }
  }, [cabinId, repoName])

  const dirEntries = useMemo(() => entries ?? [], [entries])
  const fileCount = useMemo(
    () => dirEntries.filter((e) => e.type === 'file').length,
    [dirEntries],
  )
  const changeEntries = useMemo(() => collectChangeFiles(changes?.repos ?? []), [changes])
  const changeTotalsFiles = changeEntries.length
  const dirty = changes
    ? changes.repos.some((r) => r.files.length > 0)
    : (project.git?.dirty ?? false)

  const loadPatch = useCallback((entry: ChangeEntry) => {
    if (entry.file.binary) return
    const key = entry.key
    if (requested.current.has(key)) return
    requested.current.add(key)
    setPatchErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setPatchLoading((prev) => ({ ...prev, [key]: true }))
    getRepoWorktreeChangePatch(cabinId, entry.repo, entry.file.path, !!entry.file.untracked)
      .then((r) => setPatches((prev) => ({ ...prev, [key]: { text: r.patch, truncated: r.truncated } })))
      .catch((err: unknown) => {
        requested.current.delete(key)
        setPatchErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : '拉取 patch 失败' }))
      })
      .finally(() => setPatchLoading((prev) => ({ ...prev, [key]: false })))
  }, [cabinId])

  const selectedChange = changeEntries.find((e) => e.file.path === chgSel) ?? null
  useEffect(() => {
    if (selectedChange) loadPatch(selectedChange)
  }, [selectedChange, loadPatch])

  const toggleDir = useCallback((path: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleChgDir = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const renderChgDir = (node: ChangeTreeNode, depth: number): ReactNode => {
    const dirRows = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b)).map((name) => {
      const { label, target } = compactChangeDir(node.dirs.get(name)!)
      const foldKey = target.path // 单仓：目录相对路径就是折叠键
      const isOpen = !collapsed.has(foldKey)
      return (
        <div key={foldKey}>
          <button
            type="button"
            className="ck12-tree-row is-dir"
            style={{ paddingLeft: 8 + depth * 12 }}
            title={label}
            onClick={() => toggleChgDir(foldKey)}
          >
            <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            <span className="ck12-tree-name">{label}/</span>
          </button>
          {isOpen && renderChgDir(target, depth + 1)}
        </div>
      )
    })
    const fileRows = [...node.files]
      .sort((a, b) => a.file.path.localeCompare(b.file.path))
      .map((entry) => {
        const on = chgSel === entry.file.path
        const name = entry.file.path.split('/').pop() ?? entry.file.path
        return (
          <button
            key={entry.key}
            type="button"
            className={`ck12-tree-row ck12-chg-file${on ? ' is-on' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 + 12 }}
            title={`${entry.file.path} · +${entry.file.adds} −${entry.file.dels}`}
            data-testid={`project-chg-file-${entry.file.path}`}
            onClick={() => setChgSel(entry.file.path)}
          >
            <span className={`ck12-chg-st ${STATUS_CLASS[entry.file.status] ?? 'is-m'}`}>
              {entry.file.status}
            </span>
            <span className="ck12-tree-name">{name}</span>
            <span className="ck12-chg-add">+{entry.file.adds}</span>
            <span className="ck12-chg-del">−{entry.file.dels}</span>
          </button>
        )
      })
    return <>{dirRows}{fileRows}</>
  }

  const renderChangesPane = (): ReactNode => {
    if (chgLoading && !changes) return <div className="ck12-ckt-empty">读工作区…</div>
    if (chgErr && !changes) return <div className="ck12-ckt-empty is-err">{chgErr}</div>
    const repo = changes?.repos[0] ?? null
    if (repo?.error) return <div className="ck12-ckt-empty is-err">⚠ {repo.error}</div>
    if (changeEntries.length === 0) {
      return (
        <div className="ck12-ckt-empty">
          工作区干净 —— 这个项目没有未提交的改动
          <span>口径 = worktree vs HEAD + 未跟踪文件 · 只读</span>
        </div>
      )
    }
    const selected = selectedChange
    const patch = selected ? patches[selected.key] : undefined
    const patchErr = selected ? patchErrors[selected.key] : undefined
    const busy = selected ? patchLoading[selected.key] : false
    return (
      <>
        <div className="ck12-ckt-side">
          <div className="ck12-ckt-scope">
            {changeTotalsFiles} 文件{repo?.truncated ? ' · 已截断' : ''}
          </div>
          <div className="ck12-ckt-scroll" role="tree" aria-label="项目 git 变更">
            {renderChgDir(buildChangeTree(changeEntries), 0)}
          </div>
        </div>
        <div className="ck12-ckt-main">
          {!selected ? (
            <div className="ck12-ckt-empty">左边点一个文件，看逐行 diff</div>
          ) : (
            <div className="ck12-ckt-view">
              <div className="ck12-ckt-meta">
                <span className={`ck12-chg-st ${STATUS_CLASS[selected.file.status] ?? 'is-m'}`}>
                  {selected.file.status}
                </span>
                <span className="ck12-ckt-path" title={selected.file.path}>{selected.file.path}</span>
                <span className="ck12-chg-add">+{selected.file.adds}</span>
                <span className="ck12-chg-del">−{selected.file.dels}</span>
                <span className="ck12-ckt-ro">
                  {selected.file.untracked
                    ? '新文件 · 未跟踪'
                    : `worktree vs HEAD${repo?.head ? ` · ${repo.head}` : ''}`}
                </span>
              </div>
              {selected.file.binary ? (
                <div className="ck12-chg-note">二进制文件 — 不出 patch（存在性即证据）。</div>
              ) : patchErr ? (
                <div className="ck12-chg-note is-err">
                  {patchErr}
                  <button
                    type="button"
                    className="ck12-ckt-ib"
                    onClick={() => {
                      requested.current.delete(selected.key)
                      loadPatch(selected)
                    }}
                  >
                    重试
                  </button>
                </div>
              ) : busy || !patch ? (
                <div className="ck12-chg-note">拉取 patch…</div>
              ) : (
                <div className="ck12-chg-diff">
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
          )}
        </div>
      </>
    )
  }

  const renderFilesPane = (): ReactNode => {
    if (!entries) {
      if (scan.error) return <div className="ck12-ckt-empty is-err">{scan.error}</div>
      return <div className="ck12-ckt-empty">扫仓储目录…</div>
    }
    const abs = sel && treeDir ? `${treeDir.replace(/[\\/]+$/, '')}/${sel}` : sel
    return (
      <>
        <div className="ck12-ckt-side">
          <div className="ck12-ckt-scope">
            <span>
              {fileCount} 文件 · 只读
              {scan.truncated && (
                <span className="ck12-files-trunc">
                  {' · 已截断'}
                  {scan.truncReason === 'depth' ? `（只到 ${scan.maxDepth ?? 14} 层）` : '（文件过多）'}
                </span>
              )}
            </span>
            <button
              type="button"
              className="ck12-ckt-ib"
              title="重扫磁盘"
              aria-label="重扫项目目录"
              data-testid="project-tree-rescan"
              onClick={() => scan.reload({ fresh: true })}
            >
              ↻
            </button>
          </div>
          <div className="ck12-ckt-scroll" role="tree" aria-label="项目文件树">
            {dirEntries.length === 0 ? (
              <div className="ck12-ckt-empty">仓储目录空着</div>
            ) : (
              <TreeRows
                nodes={treeNodes}
                depth={0}
                open={open}
                onToggle={toggleDir}
                sel={sel}
                onSelect={setSel}
                keep={null}
              />
            )}
          </div>
        </div>
        <div className="ck12-ckt-main">
          {!sel ? (
            <div className="ck12-ckt-empty">左边点一个文件查阅 · 只读</div>
          ) : (
            <div className="ck12-ckt-view">
              <div className="ck12-ckt-meta">
                <span className="ck12-ckt-path" title={abs ?? undefined}>{abs ?? sel}</span>
                <span className="ck12-ckt-ro">只读</span>
              </div>
              {file && file.path === sel && file.err ? (
                <div className="ck12-ckt-empty is-err">{file.err}</div>
              ) : !file || file.path !== sel || file.content == null ? (
                <div className="ck12-ckt-empty">读文件…</div>
              ) : (
                <pre className="ck12-ckt-code">{file.content}</pre>
              )}
            </div>
          )}
        </div>
      </>
    )
  }

  const git = project.git
  return (
    <div className="ck12-face-body ck12-pj-face-body" data-testid="cockpit-project-face">
      <div className="ck12-pjf">
        <div className="ck12-pjf-branch">
          <b title={git?.branch ?? project.branch ?? undefined}>
            ⎇ {git?.branch ?? project.branch ?? '未检出'}
          </b>
          {git && <span className="head">HEAD {git.commit}</span>}
          <span className={`dirty ${dirty ? 'is-dirty' : 'is-clean'}`}>
            {dirty ? 'dirty' : 'clean'}
          </span>
          <MainlineChip cabinId={cabinId} project={project} onSaved={onProjectsChanged} />
          {git?.msg && <span className="msg" title={git.msg}>{git.msg}</span>}
          <span className="at">{formatDateTime(git?.at)}</span>
        </div>

        <div className="ck12-dtabs ck12-pjf-tabs" role="tablist" aria-label="项目视图">
          <button
            type="button"
            className={`ck12-dtab${tab === 'files' ? ' on' : ''}`}
            role="tab"
            aria-selected={tab === 'files'}
            data-testid="project-tab-files"
            onClick={() => setTab('files')}
          >
            文件浏览器 <span className="n">{fileCount}</span>
          </button>
          <button
            type="button"
            className={`ck12-dtab${tab === 'changes' ? ' on' : ''}`}
            role="tab"
            aria-selected={tab === 'changes'}
            data-testid="project-tab-changes"
            onClick={() => setTab('changes')}
          >
            git 变更 <span className="n">{changeTotalsFiles}</span>
          </button>
          <span className="ck12-pjf-hint">
            {tab === 'files' ? '点目录展开 · 点文件预览' : '按目录折叠 · 点文件看 diff'}
          </span>
        </div>

        <div className={`ck12-pjf-pane${tab === 'changes' ? ' is-chg' : ''}`}>
          {tab === 'files' ? renderFilesPane() : renderChangesPane()}
        </div>
      </div>
    </div>
  )
}

/** 落点分支（mainline_branch）芯片：任务分支从它 fork，MR 默认也合回它。
 *  只影响此后新建的工作树 —— 已建工作树的分支计划固化在各自工作空间里。 */
function MainlineChip({
  cabinId, project, onSaved,
}: { cabinId: string; project: CabinRepoEntry; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.mainline_branch ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 外部改了（另一个窗口 / 汐音）→ 不编辑时跟随最新真值。
  useEffect(() => {
    if (!editing) setDraft(project.mainline_branch ?? '')
  }, [project.mainline_branch, project.key, editing])

  const save = useCallback(() => {
    const value = draft.trim()
    setSaving(true)
    setErr(null)
    setCabinRepoMainline(cabinId, project.name, value === '' ? null : value)
      .then(() => {
        setEditing(false)
        onSaved()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : '保存失败'))
      .finally(() => setSaving(false))
  }, [cabinId, project.name, draft, onSaved])

  if (!editing) {
    return (
      <span
        className="ck12-pjf-ml"
        data-testid="project-mainline"
        title="任务分支从这条分支 fork，MR 默认也合回这条（只影响此后新建的工作树）"
      >
        落点 ⎇ <b>{project.mainline_branch ?? '默认分支'}</b>
        <button
          type="button"
          className="ck12-pjf-mlbtn"
          data-testid="project-mainline-edit"
          aria-label="改落点分支"
          title="改落点分支"
          onClick={() => {
            setDraft(project.mainline_branch ?? '')
            setErr(null)
            setEditing(true)
          }}
        >
          ✎
        </button>
      </span>
    )
  }

  return (
    <span className="ck12-pjf-mledit" data-testid="project-mainline-editor">
      <span className="k">落点 ⎇</span>
      <input
        value={draft}
        placeholder="留空 = 仓库默认分支"
        aria-label="落点分支"
        data-testid="project-mainline-input"
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save() }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setErr(null) }
        }}
      />
      <button type="button" className="ok" disabled={saving} onClick={save} data-testid="project-mainline-save">
        {saving ? '…' : '保存'}
      </button>
      <button
        type="button"
        onClick={() => { setEditing(false); setErr(null) }}
        data-testid="project-mainline-cancel"
      >
        取消
      </button>
      {err && <em className="err" data-testid="project-mainline-err">{err}</em>}
    </span>
  )
}
