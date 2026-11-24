'use client'

// 作战详情 → 归档（2026-11-24 用户二轮 · 复刻 classic 归档台，皮肤走 v22 舱系）。
//
// 信息架构与 classic ArchiveWindow 同源：
//   状态条（归档 → 素材 → Wiki → 落点）→ 页签 [概览 | 知识落点 | 明细]。
//   「明细」里知识素材包逐件可点，打开只读二级窗预览（.md 渲染 / .json 高亮）；
//   归档报告也走二级窗。舱系规范：二级窗关闭按钮一律在左上角。
//
// 本面板只读 —— 落 wiki / 跳过 / 重试 / 归档都回主对话说；数据走同一个
// GET /api/tasks/:id/archive 读模型，素材件正文走知识中心 getKcFsFile。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  getTaskArchive,
  type ArchiveCaseResultWire,
  type ArchiveKnowledgeItemWire,
  type ArchiveProjectReportWire,
  type ArchiveWikiResultWire,
  type ReflectionStoreWire,
  type TaskArchivePayload,
  type TaskView,
} from '@/lib/tasks-api'
import { formatBytes, formatDuration } from '@/lib/format'
import { getKcFsFile } from '@/lib/knowledge/knowledge-center-api'
import { MarkdownPreview, MARKDOWN_TUI_CLASS } from '@/components/resource/MarkdownPreview'
import {
  prettyJsonForPreview,
  tokenizeJson,
  type JsonTokenKind,
} from '@/components/tasks/run-console/artifacts-model'

interface ArchiveStateProject {
  status?: string
  commit?: string | null
  completedAt?: string
}

interface ArchiveStateShape {
  date?: string
  startedAt?: string
  projects?: Record<string, ArchiveStateProject>
}

type Phase = 'before' | 'pending' | 'running' | 'done'
type Tone = 'ok' | 'run' | 'bad' | 'idle'
type Tab = 'overview' | 'knowledge' | 'detail'

/** v22 原型 ARCH_STEPS；顺序按真实编排收口（清理在 done 之后）。 */
const STEPS = [
  { t: 'git 同步', d: '每仓一条归档 commit → push → PR 合入落点' },
  { t: '素材冻结', d: '结论 / ADR / 术语进 raw/archives' },
  { t: '知识编译', d: 'wiki 页落库 · 判例入档 · 冲突进 PR review' },
  { t: '产物清理', d: '构建产物 / 临时目录释放（done 后）' },
] as const

const COMPILE_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '编译中',
  committed: '已编译',
  failed: '编译失败',
}

/** done 后构建产物清理状态（running + 非 in_flight = 进程中断）。 */
const CLEANUP_LABEL: Record<string, string> = {
  running: '清理中',
  done: '已清理',
  partial: '部分失败',
  failed: '失败',
}

/** 素材包单件非焦点预算（与服务端 PACK_ITEM_PROMPT_CAP_BYTES 同值；旧服务端缺省时兜底）。 */
const DEFAULT_PACK_ITEM_CAP = 6_000

const DOMAIN_LABEL: Record<string, string> = {
  entity: 'entities',
  entities: 'entities',
  concept: 'concepts',
  concepts: 'concepts',
  topic: 'topics',
  topics: 'topics',
  source: 'sources',
  sources: 'sources',
  case: 'cases',
  cases: 'cases',
}

const JSON_TONE: Record<JsonTokenKind, string> = {
  key: 'var(--ck12-teal)',
  string: 'var(--ck12-green)',
  number: 'var(--ck12-amber)',
  boolean: 'var(--ck12-violet)',
  null: 'var(--ck12-red)',
  punct: 'var(--ck12-metal2)',
  plain: 'var(--ck12-ink)',
}

function clockLabel(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 原型里的 `11-24 09:58`。 */
function stampLabel(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${date} ${clockLabel(iso)}`
}

function diffMs(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return b - a
}

function maxIso(values: Array<string | null | undefined>): string | null {
  let best: { iso: string; at: number } | null = null
  for (const value of values) {
    if (!value) continue
    const at = Date.parse(value)
    if (Number.isNaN(at)) continue
    if (!best || at > best.at) best = { iso: value, at }
  }
  return best?.iso ?? null
}

/** 冻结件正文带 front-matter 五件套；预览只看正文（头信息是冻结凭据）。 */
function stripFrontMatter(text: string): string {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  return text.slice(end + 4).replace(/^\s*\n/, '')
}

interface ProjectRow {
  project: string
  /** null = 报告还没有这个 project 的记录 */
  ok: boolean | null
  adrMerged: number | null
  termsAppended: number | null
  conflicts: number | null
  commit: string | null
  pushed: boolean | null
  pr: ArchiveProjectReportWire['pr']
  error?: string
  skippedByState?: boolean
  stateStatus?: string
  completedAt?: string | null
}

function buildRows(archive: TaskArchivePayload, extraProjects: string[]): ProjectRow[] {
  const projects = (archive.state as ArchiveStateShape | null)?.projects ?? {}
  const reportByProject = new Map((archive.report?.projects ?? []).map((p) => [p.project, p]))
  const names = [
    ...new Set([
      ...archive.projects,
      ...extraProjects,
      ...Object.keys(projects),
      ...reportByProject.keys(),
    ]),
  ]
  return names.map((name) => {
    const report = reportByProject.get(name)
    const state = projects[name]
    return {
      project: name,
      ok: report ? report.ok : state?.status === 'done' ? true : null,
      adrMerged: report ? report.adrMerged : null,
      termsAppended: report ? report.termsAppended : null,
      conflicts: report ? report.termConflicts.length : null,
      commit: report?.commit ?? state?.commit ?? null,
      pushed: report ? report.pushed : state?.status === 'done' ? true : null,
      pr: report?.pr ?? null,
      error: report?.error,
      skippedByState: report?.skippedByState,
      stateStatus: state?.status,
      completedAt: state?.completedAt ?? null,
    }
  })
}

function buildStepTones(
  phase: Phase,
  gitDone: boolean,
  gitFailed: boolean,
  packReady: boolean,
  liveCompile: boolean,
  compileCommitted: boolean,
  compileFailed: boolean,
  cleanupStatus: string | null | undefined,
): Tone[] {
  if (phase === 'before' || phase === 'pending') {
    return ['idle', 'idle', 'idle', 'idle']
  }
  const git: Tone = gitDone ? 'ok' : gitFailed ? 'bad' : 'run'
  const freeze: Tone = packReady ? 'ok' : git === 'ok' ? 'run' : 'idle'
  const compile: Tone = compileCommitted
    ? 'ok'
    : compileFailed
      ? 'bad'
      : liveCompile
        ? 'run'
        : 'idle'
  const cleanup: Tone =
    cleanupStatus === 'done'
      ? 'ok'
      : cleanupStatus === 'running'
        ? 'run'
        : cleanupStatus === 'partial' || cleanupStatus === 'failed'
          ? 'bad'
          : 'idle'
  return [git, freeze, compile, cleanup]
}

export interface CockpitArchivePanelProps {
  task: TaskView
  /** 「还没到归档」时去验收页签；不传则不渲染跳转按钮。 */
  onOpenAcceptance?: (() => void) | null
}

export function CockpitArchivePanel({ task, onOpenAcceptance }: CockpitArchivePanelProps) {
  const [archive, setArchive] = useState<TaskArchivePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const [tab, setTab] = useState<Tab>('overview')
  /** 点开的冻结素材件（null = 二级窗关闭）。 */
  const [viewingItem, setViewingItem] = useState<ArchiveKnowledgeItemWire | null>(null)
  const [reportOpen, setReportOpen] = useState(false)

  const load = useCallback(
    () =>
      getTaskArchive(task.id)
        .then((next) => {
          setArchive(next)
          setError(null)
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : '读取归档状态失败'),
        ),
    [task.id],
  )

  const compileState = archive?.knowledge?.compile_state ?? null
  const liveCompile = compileState === 'queued' || compileState === 'running'
  const fastPoll =
    !archive ||
    archive.in_flight ||
    task.status === 'archiving' ||
    archive.cleanup_in_flight ||
    liveCompile ||
    // 有未决矛盾时也快刷：人在别处「采纳修订」后，这里 4s 内就该变成已裁决。
    (archive.knowledge?.findings?.length ?? 0) > 0

  useEffect(() => {
    let alive = true
    void load()
    const timer = window.setInterval(() => {
      if (alive) void load()
    }, fastPoll ? 4_000 : 20_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [load, fastPoll])

  const phase: Phase = (() => {
    const raw = archive?.status ?? task.status
    if (raw === 'done') return 'done'
    if (raw === 'archiving' || archive?.in_flight) return 'running'
    if (raw === 'awaiting_archive') return 'pending'
    return 'before'
  })()

  // 归档中 / 编译中每秒走表（不额外请求）。
  useEffect(() => {
    if (phase !== 'running' && !liveCompile) return
    const timer = window.setInterval(() => setTick(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [phase, liveCompile])

  // Esc 先关素材件二级窗，再关报告二级窗。
  useEffect(() => {
    if (!viewingItem && !reportOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (viewingItem) setViewingItem(null)
      else setReportOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewingItem, reportOpen])

  // 换任务时回到概览，别把上一个任务的二级窗带过来。
  useEffect(() => {
    setTab('overview')
    setViewingItem(null)
    setReportOpen(false)
  }, [task.id])

  const state = archive?.state as ArchiveStateShape | null
  const rows = useMemo(
    () => (archive ? buildRows(archive, task.project_ids ?? []) : []),
    [archive, task.project_ids],
  )

  const specBranch = task.task_spec?.branch ?? null
  const specBase = task.task_spec?.base_branch ?? null
  const specTarget = task.task_spec?.target_branch ?? null
  const fallbackBase = specBase ?? 'main'
  const fallbackTarget = specTarget ?? 'main'

  const knowledge = archive?.knowledge ?? null
  const wikiResult: ArchiveWikiResultWire | null = knowledge?.wiki_result ?? null
  const touched = wikiResult?.touched ?? []
  const updatedPages = touched.filter((page) => !page.created)
  const createdPages = touched.filter((page) => page.created)
  const wikiPageCount = touched.length
  const sortedTouched = [...updatedPages, ...createdPages]

  const packItems = knowledge?.items ?? []
  const excludedPackItems = packItems.filter((item) => item.excluded).length
  const activePackItems = packItems.filter((item) => !item.excluded)
  const packItemCap = knowledge?.pack_item_cap ?? DEFAULT_PACK_ITEM_CAP
  const estimateLoaded = activePackItems.filter((item) => item.bytes <= packItemCap).length
  const estimatePointer = activePackItems.length - estimateLoaded

  const openFindings = knowledge?.findings ?? []
  const openFindingCount = openFindings.length
  const receiptFindingCount = wikiResult?.finding_ids?.length ?? 0
  const findingsResolved = !!knowledge?.findings && receiptFindingCount > 0 && openFindingCount === 0

  const caseResults = knowledge?.case_results ?? []
  const caseCreated = caseResults.filter((row) => row.action === 'created')
  const caseMerged = caseResults.filter((row) => row.action === 'merged')
  const caseFailed = caseResults.filter((row) => row.action === 'failed')
  const caseOk = caseCreated.length + caseMerged.length

  const compileFailed =
    !liveCompile && (compileState === 'failed' || (!compileState && wikiResult?.status === 'failed'))
  const compileCommitted =
    !liveCompile && !compileFailed && (wikiResult?.status === 'committed' || compileState === 'committed')
  const compileError = knowledge?.compile_error ?? wikiResult?.error ?? null
  const compileStartedAt = knowledge?.compile_started_at ?? wikiResult?.started_at ?? null
  const compileFinishedAt = knowledge?.compile_finished_at ?? wikiResult?.finished_at ?? null
  const compileDuration = diffMs(compileStartedAt, compileFinishedAt)
  const liveElapsed = liveCompile
    ? compileStartedAt
      ? tick - Date.parse(compileStartedAt)
      : knowledge?.compile_queued_at
        ? tick - Date.parse(knowledge.compile_queued_at)
        : null
    : null

  const cleanup = archive?.cleanup ?? null
  const cleanupRunning = cleanup?.status === 'running'
  const cleanupInterrupted = cleanupRunning && !archive?.cleanup_in_flight
  const cleanupLabel = cleanup
    ? cleanupInterrupted
      ? '中断'
      : (CLEANUP_LABEL[cleanup.status] ?? cleanup.status)
    : '未清理'

  const gitOkCount = rows.filter((row) => row.ok === true).length
  const conflicts = rows.reduce((sum, row) => sum + (row.conflicts ?? 0), 0)
  const projectTotal = rows.length || archive?.projects.length || 0
  const packReady = (knowledge?.pack_items ?? 0) > 0

  const stepTones = buildStepTones(
    phase,
    projectTotal > 0 && gitOkCount === projectTotal,
    rows.some((row) => row.ok === false),
    packReady,
    liveCompile,
    compileCommitted,
    compileFailed,
    cleanup?.status,
  )
  // 归档中：第一个未完成的步骤为「进行中」。
  const stepTonesLive: Tone[] =
    phase === 'running'
      ? stepTones.map((tone, i) => {
          if (tone !== 'idle') return tone
          return stepTones.slice(0, i).every((prev) => prev === 'ok') ? 'run' : tone
        })
      : stepTones
  const okStepCount = stepTones.filter((tone) => tone === 'ok').length

  const startedAt = state?.startedAt ?? null
  const projectCompletedAt = maxIso(Object.values(state?.projects ?? {}).map((row) => row.completedAt))
  const finishedAt = maxIso([
    ...Object.values(state?.projects ?? {}).map((row) => row.completedAt),
    wikiResult?.finished_at,
    cleanup?.finishedAt,
  ])
  const runningElapsed = startedAt ? tick - Date.parse(startedAt) : null
  const archiveDuration = diffMs(startedAt, projectCompletedAt)

  const knowledgeVerdict: { tone: Tone; title: string; detail: string } = (() => {
    if (compileFailed) {
      return {
        tone: 'bad',
        title: '知识编译失败',
        detail: `${compileError?.code ?? 'COMPILE_FAILED'} · 已原子回滚，素材完好可重试`,
      }
    }
    if (wikiResult?.status === 'committed') {
      const detail =
        (wikiResult.deduped
          ? `同包同焦点已编译过（快路径 no-op）· ${clockLabel(wikiResult.finished_at)}`
          : `${wikiPageCount} 页：更新 ${wikiResult.updated} · 新建 ${wikiResult.created}` +
            (openFindingCount > 0
              ? ` · ${openFindingCount} 条矛盾待裁决`
              : findingsResolved
                ? ' · 矛盾已全部裁决'
                : ' · 无矛盾')) +
        (caseOk > 0 ? ` · 判例入档 ${caseOk}` : '') +
        (caseFailed.length > 0 ? ` · 判例失败 ${caseFailed.length}` : '')
      return { tone: 'ok', title: '知识已落库', detail }
    }
    if (liveCompile) {
      return {
        tone: 'run',
        title: compileState === 'queued' ? '知识编译排队中' : '知识编译中',
        detail:
          `${compileState === 'queued' && knowledge?.compile_position != null ? `队列 #${knowledge.compile_position} · ` : ''}` +
          `已运行 ${formatDuration(liveElapsed)} · 归档与 wiki 编译是两条并行轨`,
      }
    }
    if (compileCommitted) {
      return {
        tone: 'ok',
        title: '知识编译已提交',
        detail: '旧版本编译未记录落点明细；知识中心 LOG.md 可查当次提交',
      }
    }
    if (packReady) {
      return {
        tone: 'idle',
        title: '素材已冻结',
        detail: `${knowledge?.pack_items ?? 0} 件已入 raw/archives · 等待知识中心串行队列编译`,
      }
    }
    return {
      tone: 'idle',
      title: '尚未投喂知识中心',
      detail: '知识中心不可用或投喂尚未开始；归档本身不受影响',
    }
  })()

  const archiveVerdict: { tone: Tone; title: string; detail: string } = (() => {
    if (phase === 'done') {
      const cleanupDetail =
        cleanup?.status === 'done'
          ? ' · 构建产物已清理'
          : cleanupRunning
            ? ' · 构建产物清理中'
            : cleanup?.status === 'partial' || cleanup?.status === 'failed'
              ? ' · 构建产物清理未完成'
              : ''
      return {
        tone: 'ok',
        title: '归档完成',
        detail:
          `${gitOkCount}/${projectTotal} project 同步成功 · ` +
          (conflicts > 0 ? `${conflicts} 处术语冲突等 PR review` : '无术语冲突') +
          cleanupDetail,
      }
    }
    if (phase === 'running') {
      return {
        tone: 'run',
        title: '归档编排中',
        detail: `${gitOkCount}/${projectTotal} project 已同步 · 步骤 ${Math.min(STEPS.length, okStepCount + 1)}/${STEPS.length}`,
      }
    }
    return {
      tone: 'idle',
      title: '归档未启动',
      detail: '末 phase 已验收，回主对话说「归档」后才执行同步与知识沉淀',
    }
  })()

  /** 编排事件 —— 全部取自读模型里的真实时间戳，不编造。 */
  const events = useMemo(() => {
    const list: Array<{ at: string; who: string; text: string }> = []
    const push = (at: string | null | undefined, who: string, text: string) => {
      if (!at || Number.isNaN(Date.parse(at))) return
      list.push({ at, who, text })
    }
    push(state?.startedAt, '汐音', `归档启动 · ${projectTotal} project`)
    for (const [name, row] of Object.entries(state?.projects ?? {})) {
      if (!row.completedAt) continue
      push(row.completedAt, name, row.commit ? `commit ${row.commit.slice(0, 7)} · push` : '同步完成')
    }
    push(
      knowledge?.compile_queued_at,
      '知识',
      compileState === 'queued' ? '知识编译排队' : '知识编译启动',
    )
    push(knowledge?.compile_started_at ?? wikiResult?.started_at, '知识', '知识编译启动')
    if (wikiResult?.finished_at) {
      push(
        wikiResult.finished_at,
        '知识',
        wikiResult.status === 'committed'
          ? `wiki 已提交 · ${wikiResult.touched?.length ?? 0} 页`
          : '编译失败 · 已原子回滚',
      )
    }
    push(cleanup?.startedAt, '清理', '构建产物清理启动')
    if (cleanup?.finishedAt) {
      push(
        cleanup.finishedAt,
        '清理',
        `清理${cleanup.status === 'done' ? '完成' : cleanup.status === 'partial' ? '部分完成' : '结束'} · ${formatBytes(cleanup.total_freed_bytes)}`,
      )
    }
    const seen = new Set<string>()
    return list
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .filter((row) => {
        const key = `${row.at}|${row.who}|${row.text}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }, [
    cleanup,
    compileState,
    knowledge?.compile_queued_at,
    knowledge?.compile_started_at,
    projectTotal,
    state?.projects,
    state?.startedAt,
    wikiResult,
  ])

  const timeline = useMemo(() => {
    const nodes: Array<{ at: string; title: string; sub: string; hot?: boolean }> = []
    if (state?.startedAt) {
      nodes.push({ at: state.startedAt, title: '编排开始', sub: `${projectTotal} project` })
    }
    if (projectCompletedAt) {
      nodes.push({
        at: projectCompletedAt,
        title: '编排完成',
        sub: archiveDuration != null ? `用时 ${formatDuration(archiveDuration)}` : '全绿',
      })
    }
    if (knowledge?.pack_created_at) {
      nodes.push({
        at: knowledge.pack_created_at,
        title: '素材冻结',
        sub: `${knowledge.pack_items} 件 · 入队`,
      })
    }
    if (compileCommitted && compileFinishedAt) {
      nodes.push({
        at: compileFinishedAt,
        title: 'wiki 提交',
        sub:
          wikiPageCount > 0
            ? `${wikiPageCount} 页${compileDuration != null ? ` · ${formatDuration(compileDuration)}` : ''}`
            : '已提交（无明细回执）',
        hot: true,
      })
    } else if (liveCompile) {
      nodes.push({
        at: compileStartedAt ?? knowledge?.compile_queued_at ?? new Date(tick).toISOString(),
        title: compileState === 'queued' ? '等待编译' : '编译中',
        sub:
          compileState === 'queued' && knowledge?.compile_position != null
            ? `队列 #${knowledge.compile_position}`
            : `已运行 ${formatDuration(liveElapsed)}`,
        hot: true,
      })
    }
    if (cleanup?.finishedAt) {
      nodes.push({
        at: cleanup.finishedAt,
        title: '产物清理',
        sub: `释放 ${formatBytes(cleanup.total_freed_bytes)}`,
      })
    }
    return nodes
  }, [
    archiveDuration,
    cleanup,
    compileCommitted,
    compileDuration,
    compileFinishedAt,
    compileStartedAt,
    compileState,
    knowledge?.compile_position,
    knowledge?.compile_queued_at,
    knowledge?.pack_created_at,
    knowledge?.pack_items,
    liveCompile,
    liveElapsed,
    projectCompletedAt,
    projectTotal,
    state?.startedAt,
    tick,
    wikiPageCount,
  ])

  if (error) {
    return (
      <div className="ck12-face-empty" data-testid="ck12-archive-error">
        {error}
      </div>
    )
  }
  if (!archive) {
    return (
      <div className="ck12-face-empty" data-testid="ck12-archive-loading">
        读取归档状态…
      </div>
    )
  }

  const renderSteps = () => (
    <div className="ck12-arcsteps">
      {STEPS.map((step, i) => {
        const tone = phase === 'pending' || phase === 'before' ? 'idle' : stepTonesLive[i]
        return (
          <div
            key={step.t}
            className={`ck12-arcstep${tone === 'run' ? ' is-on' : tone === 'ok' ? ' is-ok' : tone === 'bad' ? ' is-bad' : ''}`}
            data-testid={`ck12-archive-step-${i + 1}`}
          >
            <span className="n">{tone === 'ok' ? '✓' : tone === 'bad' ? '✕' : i + 1}</span>
            <b>{step.t}</b>
            <span>{step.d}</span>
          </div>
        )
      })}
    </div>
  )

  const projectTable = (plan: boolean) => (
    <>
      <div className="ck12-arctblwrap">
        <table className="ck12-arctbl" data-testid="ck12-archive-projects">
          <thead>
            <tr>
              {plan ? (
                <>
                  <th>项目</th>
                  <th>worktree 分支</th>
                  <th>落点</th>
                  <th>状态</th>
                </>
              ) : (
                <>
                  <th>项目</th>
                  <th>ADR</th>
                  <th>术语</th>
                  <th>冲突</th>
                  <th>commit</th>
                  <th>push</th>
                  <th>归档 PR</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={plan ? 4 : 7} className="is-wait">
                  还没有项目记录（任务未绑定项目）。
                </td>
              </tr>
            )}
            {rows.map((row) =>
              plan ? (
                <tr key={row.project} data-testid={`ck12-archive-project-${row.project}`}>
                  <td>
                    <b>{row.project}</b>
                  </td>
                  <td className="mono">{specBranch ?? '—'}</td>
                  <td className="mono">
                    ⎇ {specBase ?? fallbackBase} → 合入 {specTarget ?? fallbackTarget}
                  </td>
                  <td className={row.stateStatus === 'done' ? 'is-ok' : 'is-wait'}>
                    {row.stateStatus === 'done' ? '✓ 已同步' : '○ 待执行'}
                  </td>
                </tr>
              ) : (
                <tr key={row.project} data-testid={`ck12-archive-project-${row.project}`}>
                  <td>
                    <b>{row.project}</b>
                    {row.skippedByState && <span className="mono"> state-skip</span>}
                    {row.error && <div className="is-bad err">{row.error}</div>}
                  </td>
                  <td className="mono">{row.adrMerged ?? 0}</td>
                  <td className="mono">{row.termsAppended ?? 0}</td>
                  <td className={(row.conflicts ?? 0) > 0 ? 'is-wait' : 'mono'}>
                    {row.conflicts ?? 0}
                  </td>
                  <td className="mono">{row.commit ? row.commit.slice(0, 8) : '—'}</td>
                  <td className={row.pushed === null ? 'mono' : row.pushed ? 'is-ok' : 'is-bad'}>
                    {row.pushed === null ? '—' : row.pushed ? '✓' : '✗'}
                  </td>
                  <td>
                    {row.pr?.url ? (
                      <a className="is-pr" href={row.pr.url} target="_blank" rel="noreferrer">
                        {row.pr.action} ↗
                      </a>
                    ) : row.pr?.action ? (
                      <span className="is-pr">{row.pr.action}</span>
                    ) : row.pushed ? (
                      'push 即落点'
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      <div className="ck12-arcfoot">
        {plan
          ? `落点＝舱籍项目「落点 ⎇」（${specBase ?? fallbackBase} → 合入 ${specTarget ?? fallbackTarget}）；PR 目标分支取 config.repos[].target_branch。`
          : '全绿才 done；任一 project 失败停在 archiving，说「重试」由主对话按 project 幂等续跑。'}
      </div>
    </>
  )

  const verdictBlock = (items: Array<{ tone: Tone; title: string; detail: string }>) => (
    <div className="ck12-arcverdict" data-testid="ck12-archive-verdict">
      {items.map((row) => (
        <div key={row.title} className="ck12-arcv">
          <span className={`ic ${row.tone}`}>
            {row.tone === 'ok' ? '✓' : row.tone === 'run' ? '●' : row.tone === 'bad' ? '✕' : '·'}
          </span>
          <span className="tx">
            <b>{row.title}</b>
            <span>{row.detail}</span>
          </span>
        </div>
      ))}
    </div>
  )

  const pageGroup = (title: string, pages: typeof touched) => {
    if (pages.length === 0) return null
    return (
      <>
        <div className="ck12-sect">
          {title} · {pages.length}
        </div>
        <div className="ck12-arcpages" data-testid={`ck12-archive-pages-${title === '新建' ? 'created' : 'updated'}`}>
          {pages.map((page) => (
            <div key={page.path} className="ck12-arcpage" data-testid="ck12-archive-page">
              <span className="dom">{DOMAIN_LABEL[page.type] ?? page.type}</span>
              <span className="p" title={page.path}>
                {page.path}
              </span>
              <span className={`tag ${page.created ? 'new' : 'upd'}`}>
                {page.created ? '新建' : '更新'}
              </span>
            </div>
          ))}
        </div>
      </>
    )
  }

  const caseBlock = (results: ArchiveCaseResultWire[]) => {
    if (results.length === 0) return null
    return (
      <>
        <div className="ck12-sect">判例入档 · {results.length}</div>
        <div className="ck12-arcpack" data-testid="ck12-archive-cases">
          {results.map((result) => {
            const merged =
              result.action === 'merged' &&
              result.occurrences_before != null &&
              result.occurrences_after != null
            return (
              <div
                key={result.queue_task_id}
                className="ck12-arcpackrow"
                data-testid="ck12-archive-case"
              >
                <span
                  className={`kind ${result.action === 'created' ? 'is-ok' : result.action === 'merged' ? 'is-merged' : 'is-bad'}`}
                >
                  {result.action === 'created' ? '新建' : result.action === 'merged' ? '并档' : '失败'}
                </span>
                <span className="nm">{result.symptom}</span>
                {merged ? (
                  <span className="sz">
                    occurrence {result.occurrences_before} → {result.occurrences_after}
                  </span>
                ) : (
                  <span className="sz" title={result.case_path ?? undefined}>
                    {result.case_path ?? ''}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </>
    )
  }

  const packList = (() => {
    if (!knowledge) {
      return (
        <div className="ck12-arcpage" data-testid="ck12-archive-pack-empty">
          <span className="p">投喂尚未开始（或知识中心不可用）。</span>
        </div>
      )
    }
    return (
      <div className="ck12-arcpack" data-testid="ck12-archive-pack-items">
        {packItems.length === 0 ? (
          <div className="ck12-arcpage">
            <span className="p">素材包尚未冻结</span>
          </div>
        ) : (
          packItems.map((item) => {
            const pointer =
              !item.excluded && item.bytes > packItemCap && item.kind !== 'archive-summary'
            return (
              <button
                key={item.path}
                type="button"
                className={`ck12-arcpackrow${item.excluded ? ' is-out' : ''}`}
                title={item.path}
                data-testid="ck12-archive-pack-item"
                onClick={() => setViewingItem(item)}
              >
                <span className="kind">{item.kind}</span>
                <span className="nm">{item.name}</span>
                {item.excluded ? (
                  <span className="badge out">已剔除</span>
                ) : (
                  <span className={`badge${pointer ? ' ptr' : ''}`}>
                    {pointer ? '仅指针' : '载入'}
                  </span>
                )}
                <span className="sz">{formatBytes(item.bytes)}</span>
                <span className="go">▸</span>
              </button>
            )
          })
        )}
      </div>
    )
  })()

  const cleanupBlock = (() => {
    if (!cleanup) {
      return (
        <div className="ck12-arcpage">
          <span className="p">归档完成后自动清理各 project worktree 的构建产物</span>
        </div>
      )
    }
    return (
      <>
        {cleanup.error && <div className="ck12-arcpage err">{cleanup.error}</div>}
        {cleanup.projects.length === 0 ? (
          <div className="ck12-arcpage">
            <span className="p">没有可清理的 project。</span>
          </div>
        ) : (
          <div className="ck12-arcclean" data-testid="ck12-archive-cleanup">
            {cleanup.projects.map((p) => (
              <div key={p.project} className="ck12-arccleanrow">
                <b>{p.project}</b>
                <span className="g">
                  删除 {p.removed_count} 项 · {formatBytes(p.freed_bytes)}
                </span>
                {p.leftover_count > 0 && (
                  <span className="l">剩余 ignored {p.leftover_count} 项</span>
                )}
                {!p.ok && <span className="l">未完成</span>}
              </div>
            ))}
          </div>
        )}
        <p>
          只删 git 忽略且内部无跟踪文件的构建产物（node_modules / target / dist / classes / jar …）；
          白名单之外、仍被忽略的目录只列清单。
        </p>
      </>
    )
  })()

  const reflectionBlock = (() => {
    const reflection: ReflectionStoreWire | null = archive.reflection
    const entries = reflection?.entries ?? []
    const decided = reflection ? Object.keys(reflection.decisions).length : 0
    if (entries.length === 0) {
      return (
        <div className="ck12-arcpage">
          <span className="p">本次没有人工反思提案</span>
        </div>
      )
    }
    return (
      <div className="ck12-arcref" data-testid="ck12-archive-reflection">
        {entries.map((entry) => {
          const decision = reflection?.decisions[entry.id]
          return (
            <div key={entry.id} className="ck12-arcrefrow">
              <span className={`dec${decision?.action === 'skip' ? ' skip' : ''}`}>
                {!decision ? '未决' : decision.action === 'ingest' ? '已落 wiki' : '已跳过'}
              </span>
              <b>{entry.title}</b>
              {entry.target && <span>{entry.target}</span>}
              {decision?.raw_path && <div className="raw">{decision.raw_path}</div>}
            </div>
          )
        })}
        {decided < entries.length && <p>未决条目在主对话里说「落 / 跳过」即可。</p>}
      </div>
    )
  })()

  const preflight = archive.report?.preflight ?? null

  const head = (() => {
    if (phase === 'pending') {
      return (
        <>
          <span className="ck12-arcchip is-pending" data-testid="ck12-archive-chip">
            <i />
            待归档 · 未启动
          </span>
          <span className="ck12-arclbl">
            <b>{stampLabel(task.updated_at)}</b> 末 phase 已验收
          </span>
          <span className="ck12-arclbl">对话里说「归档」才启动</span>
        </>
      )
    }
    if (phase === 'running') {
      return (
        <>
          <span className="ck12-arcchip is-running" data-testid="ck12-archive-chip">
            <i />
            归档编排中
          </span>
          <span className="ck12-arclbl">
            <b>{clockLabel(startedAt)}</b> 开始 · 已运行 <b>{formatDuration(runningElapsed)}</b>
          </span>
          <span className="ck12-arclbl">
            步骤 {Math.min(STEPS.length, okStepCount + 1)}/{STEPS.length}
          </span>
        </>
      )
    }
    return (
      <>
        <span className="ck12-arcchip is-done" data-testid="ck12-archive-chip">
          <i />✓ 已归档
        </span>
        <span className="ck12-arclbl">
          <b>{stampLabel(finishedAt)}</b> 完成 · 用时 <b>{formatDuration(archiveDuration)}</b>
        </span>
        <span className="ck12-arclbl">done 之后不再开写</span>
      </>
    )
  })()

  if (phase === 'before') {
    return (
      <div className="ck12-arc" data-testid="ck12-archive-panel">
        <div className="ck12-arcgate is-wait">
          <b>还没到归档</b>
          <span>末 phase 验收通过后才进入待归档；先在「验收」页签把这轮拍板。</span>
        </div>
        {onOpenAcceptance && (
          <div>
            <button type="button" className="ck12-arcbtn" onClick={onOpenAcceptance}>
              去「验收」→
            </button>
          </div>
        )}
      </div>
    )
  }

  const statBar = (
    <div className="ck12-arcstat" data-testid="ck12-archive-statbar">
      <span className="it">
        <i className={`dot ${phase === 'done' ? 'ok' : phase === 'running' ? 'run' : 'idle'}`} />
        <span className="k">归档</span>
        <span className="v">
          {phase === 'done'
            ? `${clockLabel(finishedAt)} 全绿`
            : phase === 'running'
              ? '编排中'
              : '未启动'}
        </span>
      </span>
      <span className="ar">→</span>
      <span className="it">
        <i className={`dot ${packReady ? 'ok' : 'idle'}`} />
        <span className="k">素材</span>
        <span className="v">{packReady ? `${knowledge?.pack_items} 件` : '未投喂'}</span>
      </span>
      <span className="ar">→</span>
      <span className="it">
        <i
          className={`dot ${
            liveCompile ? 'run' : compileFailed ? 'bad' : compileCommitted ? 'ok' : 'idle'
          }`}
        />
        <span className="k">Wiki</span>
        <span className="v">
          {liveCompile
            ? compileState === 'queued'
              ? '排队中'
              : '编译中'
            : compileFailed
              ? '编译失败'
              : compileCommitted
                ? wikiPageCount > 0
                  ? `${wikiPageCount} 页`
                  : '已提交'
                : '—'}
        </span>
      </span>
      <span className="ar">→</span>
      <span className="it">
        <i className={`dot ${wikiResult || caseResults.length > 0 ? 'ok' : 'idle'}`} />
        <span className="k">落点</span>
        <span className="v">
          {wikiResult
            ? `新 ${wikiResult.created} / 更 ${wikiResult.updated}`
            : caseResults.length > 0
              ? `判例 ${caseOk}`
              : liveCompile
                ? '等待提交'
                : '—'}
        </span>
      </span>
    </div>
  )

  const tabs: Array<[Tab, string, string]> = [
    ['overview', '概览', ''],
    ['knowledge', '知识落点', wikiPageCount > 0 ? String(wikiPageCount) : ''],
    ['detail', '明细', ''],
  ]

  return (
    <div className="ck12-arc" data-testid="ck12-archive-panel">
      <div className="ck12-arcbar">{head}</div>
      {statBar}

      <div className="ck12-atabs" data-testid="ck12-archive-tabs">
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            className={`ck12-atab${tab === id ? ' on' : ''}`}
            data-testid={`ck12-archive-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {label}
            {count && <small>{count}</small>}
          </button>
        ))}
        <span className="hint">
          {tab === 'overview'
            ? '一屏结论 · 先看这里'
            : tab === 'knowledge'
              ? '更新优先 · 矛盾置顶'
              : '素材件点开只读预览'}
        </span>
      </div>

      {/* ═══════════ 概览 ═══════════ */}
      {tab === 'overview' && (
        <div data-testid="ck12-archive-overview">
          {preflight && (
            <div className="ck12-arcgate" data-testid="ck12-archive-preflight">
              <b>归档前拦截 · 有未提交改动</b>
              <span>{preflight.message}</span>
              <span>在主对话里说「纳入」或「排除」，由 Agent 执行；窗口只读。</span>
            </div>
          )}

          {phase === 'pending' && (
            <>
              <div className="ck12-arcgate">
                <b>验收 ≠ 归档 · 这是最后一道人工闸</b>
                <span>
                  末 phase 通过只代表停在待归档。你说「归档」才开始 git 同步 / 素材冻结 /
                  知识沉淀；说「暂不归档」保持现状；说「中止」结束任务。done 之后不再开写。
                </span>
              </div>
              <div className="ck12-sect">怎么说</div>
              <div className="ck12-arcsay">
                <span className="ck12-arcsay-k">主对话</span>
                <code>❯ 归档</code>
                <span>开始归档</span>
                <code>❯ 暂不归档</code>
                <span>保持待归档</span>
              </div>
              <div className="ck12-sect">归档会做什么</div>
              {renderSteps()}
              <div className="ck12-sect">项目同步计划</div>
              {projectTable(true)}
            </>
          )}

          {phase === 'running' && (
            <>
              {renderSteps()}
              {verdictBlock([archiveVerdict, knowledgeVerdict])}
              <div className="ck12-sect">项目同步</div>
              {projectTable(false)}
              <div className="ck12-sect">实时事件</div>
              <div className="ck12-arclog" data-testid="ck12-archive-events">
                {events.length > 0 ? (
                  events.map((event) => (
                    <div key={`${event.at}|${event.who}|${event.text}`}>
                      <b>{clockLabel(event.at)}</b> · {event.who} · {event.text}
                    </div>
                  ))
                ) : (
                  <div>等待编排事件…</div>
                )}
              </div>
            </>
          )}

          {phase === 'done' && (
            <>
              {verdictBlock([archiveVerdict, knowledgeVerdict])}
              <div className="ck12-kv" data-testid="ck12-archive-kpi">
                <div className="ck12-kvi">
                  <div className="k">WIKI 落点</div>
                  <div className="v is-gr">{wikiPageCount > 0 ? `${wikiPageCount} 页` : '—'}</div>
                </div>
                <div className="ck12-kvi">
                  <div className="k">PROJECT 同步</div>
                  <div className="v">
                    {gitOkCount}/{projectTotal}
                  </div>
                </div>
                <div className="ck12-kvi">
                  <div className="k">术语冲突</div>
                  <div className="v">{conflicts}</div>
                </div>
                <div className="ck12-kvi">
                  <div className="k">构建产物释放</div>
                  <div className="v is-a">
                    {cleanup ? formatBytes(cleanup.total_freed_bytes) : '—'}
                  </div>
                </div>
              </div>

              {sortedTouched.length > 0 && (
                <>
                  <div className="ck12-sect">知识落点 · 更新优先</div>
                  <div className="ck12-arcpages">
                    {sortedTouched.slice(0, 5).map((page) => (
                      <div key={page.path} className="ck12-arcpage">
                        <span className="dom">{DOMAIN_LABEL[page.type] ?? page.type}</span>
                        <span className="p" title={page.path}>
                          {page.path}
                        </span>
                        <span className={`tag ${page.created ? 'new' : 'upd'}`}>
                          {page.created ? '新建' : '更新'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {sortedTouched.length > 5 && (
                    <p className="ck12-arcfoot">…（其余 {sortedTouched.length - 5} 页见「知识落点」页签）</p>
                  )}
                </>
              )}

              {timeline.length > 0 && (
                <>
                  <div className="ck12-sect">时间线</div>
                  <div className="ck12-arctl" data-testid="ck12-archive-timeline">
                    {timeline.map((node) => (
                      <div key={`${node.at}|${node.title}`} className={`nd${node.hot ? ' hot' : ''}`}>
                        <span className="dt" />
                        <div className="t">{clockLabel(node.at)}</div>
                        <div className="n">{node.title}</div>
                        <div className="s">{node.sub}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="ck12-arcsay">
                <span className="ck12-arcsay-k">二级窗</span>
                <button type="button" className="ck12-arcbtn" onClick={() => setTab('detail')}>
                  素材包 {knowledge?.pack_items ?? 0} 件
                </button>
                <button type="button" className="ck12-arcbtn" onClick={() => setTab('knowledge')}>
                  知识落点 {wikiPageCount} 页
                </button>
                {archive.report_md && (
                  <button
                    type="button"
                    className="ck12-arcbtn"
                    data-testid="ck12-archive-report"
                    onClick={() => setReportOpen(true)}
                  >
                    归档报告 ↗
                  </button>
                )}
              </div>
            </>
          )}

          <div className="ck12-arcfoot">
            归档明细只读，操作在对话里完成；主对话状态卡归档角标 / chat 窗头部 📦 都跳到这里。
          </div>
        </div>
      )}

      {/* ═══════════ 知识落点 ═══════════ */}
      {tab === 'knowledge' && (
        <div data-testid="ck12-archive-knowledge">
          {phase === 'pending' && (
            <div className="ck12-arcpage" data-testid="ck12-archive-knowledge-empty">
              <span className="p">还没有知识落点 · 说「归档」启动后，素材冻结 → wiki 编译，这里出页级回执。</span>
            </div>
          )}

          {phase !== 'pending' && (liveCompile || compileFailed) && (
            <div className={`ck12-arcwarn${compileFailed ? ' is-bad' : ''}`} data-testid="ck12-archive-compile-live">
              <b>
                {compileFailed
                  ? `✕ ${compileError?.code ?? '编译失败'} · 原子回滚`
                  : compileState === 'queued'
                    ? `● 编译排队中 · 队列 #${knowledge?.compile_position ?? '?'}`
                    : '● 知识编译中'}
              </b>
              {compileFailed
                ? `${formatDuration(compileDuration)} · 未产生 commit；素材包与 raw 文件完好，回主对话说「重试归档沉淀」即可重新入队。`
                : `素材已冻结 ${knowledge?.pack_items ?? 0} 件，等待知识中心串行队列编译；已运行 ${formatDuration(liveElapsed)}。编译是一次原子提交，完成后本页自动出回执，不需要重开知识中心。`}
              {compileFailed && compileError?.message && (
                <div className="msg">{compileError.message}</div>
              )}
            </div>
          )}

          {phase !== 'pending' && !liveCompile && !compileFailed && (
            <>
              <div className="ck12-kv" data-testid="ck12-archive-knowledge-kpi">
                <div className="ck12-kvi">
                  <div className="k">新建页</div>
                  <div className="v is-gr">{wikiResult?.created ?? 0}</div>
                </div>
                <div className="ck12-kvi">
                  <div className="k">更新页</div>
                  <div className="v is-a">{wikiResult?.updated ?? 0}</div>
                </div>
                <div className="ck12-kvi">
                  <div className="k">矛盾待裁决</div>
                  <div className="v">{openFindingCount}</div>
                </div>
                <div className="ck12-kvi">
                  <div className="k">触及页</div>
                  <div className="v">{wikiPageCount}</div>
                </div>
                <div className="ck12-kvi">
                  <div className="k">编译用时</div>
                  <div className="v">{formatDuration(compileDuration)}</div>
                </div>
              </div>

              {wikiResult?.deduped && (
                <div className="ck12-arcnote">
                  同包同焦点已编译过 —— 本次走快路径 no-op（未调 LLM、零副作用）。
                </div>
              )}

              {openFindingCount > 0 ? (
                <div className="ck12-arcwarn" data-testid="ck12-archive-findings">
                  <b>! 矛盾待裁决 · {openFindingCount}</b>
                  {openFindings.map((finding) => (
                    <div key={finding.id}>
                      {finding.id} · {finding.title}
                    </div>
                  ))}
                  <div className="msg">
                    新素材与现库断言冲突，旧断言保留原位、未静默覆盖。回主对话对 Agent 说「采纳修订 / 忽略」即可裁决 —— 只影响知识库，不改变任务 done。
                  </div>
                </div>
              ) : findingsResolved ? (
                <div className="ck12-arcnote is-ok" data-testid="ck12-archive-findings-resolved">
                  ✓ 编译时发现的 {receiptFindingCount} 处矛盾已全部裁决（wiki LOG 可查；不影响任务 done）。
                </div>
              ) : receiptFindingCount > 0 ? (
                <div className="ck12-arcwarn" data-testid="ck12-archive-findings">
                  <b>! 矛盾待裁决 · {receiptFindingCount}</b>
                  <div>finding：{wikiResult?.finding_ids.join(' · ')}</div>
                  <div className="msg">旧服务端只回编译时快照；回主对话说「采纳修订 / 忽略」裁决。</div>
                </div>
              ) : null}

              {pageGroup('更新', updatedPages)}
              {pageGroup('新建', createdPages)}

              {wikiResult && wikiResult.warnings.length > 0 && (
                <div className="ck12-arcnote">
                  <b>编译告警</b>
                  {wikiResult.warnings.map((warning, i) => (
                    <div key={i}>{warning}</div>
                  ))}
                </div>
              )}

              {wikiResult?.status === 'committed' && (
                <div className="ck12-arcfoot">
                  commit <b>{wikiResult.commit ? wikiResult.commit.slice(0, 8) : '—'}</b> ·{' '}
                  {clockLabel(wikiResult.started_at)} → {clockLabel(wikiResult.finished_at)} · 持久回执：archive/wiki-result.json
                </div>
              )}

              {!wikiResult && (
                <p className="ck12-arcfoot">
                  {compileCommitted
                    ? '编译已提交，但旧版本未记录落点明细（知识中心 LOG.md 可查当次提交；重编译会补齐明细）。'
                    : packReady
                      ? '编译已入队，尚无落点回执。'
                      : '投喂尚未开始（或知识中心不可用）。'}
                </p>
              )}
            </>
          )}

          {/* 判例走独立队列：可能先于 wiki 编译完成，所以不藏在回执块里 */}
          {phase !== 'pending' && caseBlock(caseResults)}

          <div className="ck12-arcfoot">
            编译是一次原子提交；知识中心 INDEX / LOG 与这里同源。
          </div>
        </div>
      )}

      {/* ═══════════ 明细 ═══════════ */}
      {tab === 'detail' && (
        <div data-testid="ck12-archive-detail">
          <div className="ck12-arcgrid">
            <section className="ck12-arcblock">
              <h4>
                知识素材包
                <span>{knowledge?.pack_path ?? 'raw/archives/…'}</span>
              </h4>
              {knowledge && (
                <div className="ck12-arcnote slim">
                  已冻结素材件 <b>{knowledge.pack_items}</b>
                  {excludedPackItems > 0 ? `（另 ${excludedPackItems} 件已剔除）` : ''} · 按{' '}
                  {formatBytes(packItemCap)} 单件预算估算：{estimateLoaded} 载入 · {estimatePointer} 仅指针
                </div>
              )}
              {packList}
              <p>点任意件打开只读预览（.md 渲染 / .json 高亮）；关闭按钮在左上角。</p>
            </section>

            <section className="ck12-arcblock" data-testid="ck12-archive-reflection-block">
              <h4>反思 · 沉淀决策</h4>
              {reflectionBlock}
            </section>

            <section className="ck12-arcblock">
              <h4>
                构建产物清理
                <span>
                  {cleanup ? `释放 ${formatBytes(cleanup.total_freed_bytes)}` : '未清理'}
                  {cleanup ? ` · ${cleanupLabel}` : ''}
                </span>
              </h4>
              {cleanupBlock}
            </section>

            <section className="ck12-arcblock">
              <h4>
                归档报告
                <span>archive/report.md</span>
              </h4>
              {archive.report_md ? (
                <button
                  type="button"
                  className="ck12-arcbtn"
                  data-testid="ck12-archive-report"
                  onClick={() => setReportOpen(true)}
                >
                  打开归档报告 ↗
                </button>
              ) : (
                <div className="ck12-arcpage">
                  <span className="p">报告尚未生成</span>
                </div>
              )}
              <p>报告正文较长，放在二级窗里单独滚动，主窗不套第二层滚动条。</p>
            </section>
          </div>

          <div className="ck12-sect">PROJECT 同步结果</div>
          {projectTable(phase === 'pending')}
        </div>
      )}

      <div className="ck12-arcfoot">
        归档明细只读，操作在对话里完成；落 / 跳过 / 重试 / 归档都在主对话里说。
      </div>

      {viewingItem && (
        <ArcPackFileWindow
          item={viewingItem}
          packPath={knowledge?.pack_path ?? 'raw/archives/…'}
          onClose={() => setViewingItem(null)}
        />
      )}

      {reportOpen && archive.report_md && (
        <ArcReportWindow
          title="归档报告"
          meta={`archive/report.md${archive.report ? ` · ${archive.report.date}` : ''}`}
          body={archive.report_md}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  )
}

// ── 二级窗（舱系 .twin 外观；关闭按钮左上角）────────────────────────

type FileState =
  | { kind: 'loading' }
  | { kind: 'loaded'; content: string }
  | { kind: 'error'; message: string }

function ArcWindowShell({
  testId,
  label,
  title,
  meta,
  path,
  foot,
  onClose,
  children,
}: {
  testId: string
  label: string
  title: ReactNode
  meta: string
  path: string
  foot: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="ck12-arcwin-back"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="ck12-arcwin" role="dialog" aria-modal="true" aria-label={label} data-testid={testId}>
        <div className="ck12-arcwin-h">
          <button
            type="button"
            className="ck12-arcwin-x"
            aria-label="关闭"
            data-testid={`${testId}-close`}
            onClick={onClose}
          >
            ✕
          </button>
          <span className="pt">
            <b>{title}</b>
            <span>{meta}</span>
          </span>
          <span className="ro">只读 · Esc 关闭</span>
        </div>
        <div className="ck12-arcwin-path">{path}</div>
        <div className="ck12-arcwin-body">{children}</div>
        <div className="ck12-arcwin-foot">{foot}</div>
      </div>
    </div>
  )
}

function ArcPackFileWindow({
  item,
  packPath,
  onClose,
}: {
  item: ArchiveKnowledgeItemWire
  packPath: string
  onClose: () => void
}) {
  const [state, setState] = useState<FileState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    getKcFsFile(item.path)
      .then((res) => {
        if (!cancelled) setState({ kind: 'loaded', content: res.content })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : '读取素材件失败',
          })
      })
    return () => {
      cancelled = true
    }
  }, [item])

  const body = state.kind === 'loaded' ? stripFrontMatter(state.content) : ''
  const isMarkdown = /\.(md|markdown)$/i.test(item.path)
  const isJson = /\.json$/i.test(item.path)
  const formatted = useMemo(() => prettyJsonForPreview(body), [body])
  const tokens = useMemo(() => tokenizeJson(formatted.text), [formatted.text])
  const stats =
    state.kind === 'loaded'
      ? { lines: body.split('\n').length, chars: body.length }
      : null

  return (
    <ArcWindowShell
      testId="ck12-archive-file-win"
      label={`素材件 ${item.name}`}
      title={`📦 ${item.name}`}
      meta={`ARCHIVE PACK · ${item.kind} · ${formatBytes(item.bytes)}`}
      path={`${packPath}/${item.name}`}
      onClose={onClose}
      foot={
        <>
          <span>只读 · 取自知识库 raw 冻结件；front-matter 头信息已省略。</span>
          {stats && (
            <span className="ft-stat" data-testid="ck12-archive-file-stats">
              {stats.lines} 行 · {stats.chars} 字
            </span>
          )}
        </>
      }
    >
      {state.kind === 'loading' ? (
        <div className="ck12-arcwin-empty">读取素材件…</div>
      ) : state.kind === 'error' ? (
        <div className="ck12-arcwin-empty is-bad" data-testid="ck12-archive-file-error">
          {state.message}
        </div>
      ) : isMarkdown ? (
        <MarkdownPreview content={body} className={MARKDOWN_TUI_CLASS} />
      ) : isJson ? (
        <pre className="ck12-arcwin-pre" data-testid="ck12-archive-file-json">
          {tokens.map((token, i) => (
            <span key={i} style={{ color: JSON_TONE[token.kind] }}>
              {token.text}
            </span>
          ))}
        </pre>
      ) : (
        <pre className="ck12-arcwin-pre" data-testid="ck12-archive-file-text">
          {body}
        </pre>
      )}
    </ArcWindowShell>
  )
}

function ArcReportWindow({
  title,
  meta,
  body,
  onClose,
}: {
  title: string
  meta: string
  body: string
  onClose: () => void
}) {
  return (
    <ArcWindowShell
      testId="ck12-archive-report-win"
      label={title}
      title={`📄 ${title}`}
      meta={meta}
      path="archive/report.md"
      onClose={onClose}
      foot={<span>正文来自 archive/report.md，不在此处编辑。</span>}
    >
      <MarkdownPreview content={body} className={MARKDOWN_TUI_CLASS} />
    </ArcWindowShell>
  )
}
