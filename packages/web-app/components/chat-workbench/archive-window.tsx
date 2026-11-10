'use client'

// 归档台（2026-11-03 归档台 v2 精简方案）—— 只读明细面。
//
// 信息架构（tmp/archive-window-v2.html 定稿）：
//   顶部状态条（归档 → 素材 → Wiki → 落点）→ 页签 [概览 | 知识落点 | 明细]。
//   默认「概览」一屏给结论：归档成没成、wiki 落了什么、为什么等了。
//   明细（素材包 / project 表 / 清理 / 反思 / 增补）全部降级到页签，不再一条长卷；
//   归档报告走弹窗，窗口本身只有一个滚动层。
//
// 所有操作（落 wiki / 跳过 / 重试）都回主 Chat 用自然语言完成 —— 本窗口没有动作按钮，
// 页脚写死「只读明细 · 操作在对话里完成」。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  getTaskArchive,
  type ArchiveCaseResultWire,
  type ArchiveKnowledgeItemWire,
  type ArchiveProjectReportWire,
  type TaskArchivePayload,
  type TaskView,
} from '@/lib/tasks-api'
import { Spinner } from '@/components/ui/spinner'
import { formatDuration } from '@/lib/format'
import { ArchivePackDialog } from './archive-pack-dialog'

interface ProjectState {
  status?: string
  commit?: string | null
  completedAt?: string
}

interface ArchiveStateShape {
  date?: string
  startedAt?: string
  projects?: Record<string, ProjectState>
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
}

type Tab = 'overview' | 'knowledge' | 'detail'
type Tone = 'ok' | 'run' | 'bad' | 'idle'

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

const DOMAIN_COLOR: Record<string, string> = {
  entities: 'text-pop-purple',
  concepts: 'text-pop-cyan',
  topics: 'text-pop-amber',
  sources: 'text-pop-green',
  cases: 'text-pop-pink',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatClock(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function diffMs(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return b - a
}

function buildRows(archive: TaskArchivePayload): ProjectRow[] {
  const projects = (archive.state as ArchiveStateShape | null)?.projects ?? {}
  const reportByProject = new Map((archive.report?.projects ?? []).map((p) => [p.project, p]))
  const names = [...new Set([...archive.projects, ...Object.keys(projects), ...reportByProject.keys()])]
  return names.map((name) => {
    const p = reportByProject.get(name)
    const state = projects[name]
    return {
      project: name,
      ok: p ? p.ok : state?.status === 'done' ? true : null,
      adrMerged: p ? p.adrMerged : null,
      termsAppended: p ? p.termsAppended : null,
      conflicts: p ? p.termConflicts.length : null,
      commit: p?.commit ?? state?.commit ?? null,
      pushed: p ? p.pushed : state?.status === 'done' ? true : null,
      pr: p?.pr ?? null,
      error: p?.error,
      skippedByState: p?.skippedByState,
    }
  })
}

function ProjectCell({ value }: { value: string | number | null }) {
  return <span className="font-mono tabular-nums">{value == null ? '—' : value}</span>
}

function VerdictIcon({ tone }: { tone: Tone }) {
  const glyph = tone === 'ok' ? '✓' : tone === 'bad' ? '✕' : tone === 'run' ? '●' : '·'
  return (
    <span
      aria-hidden
      className={`grid size-[17px] shrink-0 place-items-center rounded-full border-[1.5px] font-mono text-[9px] font-black ${
        tone === 'ok'
          ? 'border-pop-green text-pop-green'
          : tone === 'bad'
            ? 'border-pop-red text-pop-red'
            : tone === 'run'
              ? 'border-pop-amber text-pop-amber'
              : 'border-pop-bd text-pop-dim'
      }`}
    >
      {glyph}
    </span>
  )
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'bg-pop-green-soft text-pop-green'
      : tone === 'bad'
        ? 'bg-pop-red-soft text-pop-red'
        : tone === 'run'
          ? 'bg-pop-amber-soft text-pop-amber'
          : 'bg-pop-idle text-pop-dim'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-transparent px-2 py-[2px] font-mono text-[9.5px] font-black ${cls}`}>
      <span className="size-[5px] rounded-full bg-current" />
      {children}
    </span>
  )
}

function Kpi({ value, label, tone }: { value: ReactNode; label: string; tone?: 'green' | 'cyan' | 'amber' | 'purple' | 'red' }) {
  const cls =
    tone === 'green'
      ? 'text-pop-green'
      : tone === 'cyan'
        ? 'text-pop-cyan'
        : tone === 'amber'
          ? 'text-pop-amber'
          : tone === 'purple'
            ? 'text-pop-purple'
            : tone === 'red'
              ? 'text-pop-red'
              : 'text-pop-ink'
  return (
    <div className="min-w-0 px-3 py-2">
      <b className={`block font-mono text-[16px] font-black leading-tight tabular-nums ${cls}`}>{value}</b>
      <span className="mt-0.5 block truncate text-[8.5px] text-pop-dim">{label}</span>
    </div>
  )
}

function LiveBox({
  title,
  detail,
  tone = 'run',
  children,
}: {
  title: string
  detail?: ReactNode
  tone?: 'run' | 'bad'
  children?: ReactNode
}) {
  const bad = tone === 'bad'
  return (
    <div
      data-testid={bad ? 'archive-wiki-failed' : 'archive-wiki-running'}
      className={`rounded-lg border-[1.5px] border-dashed px-3 py-2.5 ${
        bad ? 'border-pop-red/40 bg-pop-red/[0.045]' : 'border-pop-amber/40 bg-pop-amber/[0.035]'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`font-mono text-[10.5px] font-black ${bad ? 'text-pop-red' : 'text-pop-amber'}`}>{title}</span>
        {detail && <span className="ml-auto font-mono text-[9.5px] tabular-nums text-pop-dim">{detail}</span>}
      </div>
      {!bad && (
        <div className="my-2 h-1 overflow-hidden rounded-full bg-white/[0.07]">
          <span className="block h-full w-2/5 animate-pulse rounded-full bg-gradient-to-r from-pop-amber/0 via-pop-amber to-pop-amber/0" />
        </div>
      )}
      {children}
    </div>
  )
}

function CompileSteps({ failedAt }: { failedAt?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px] text-pop-dim">
      <span className="text-pop-green">✓ 读取素材包</span>
      <span className="text-pop-dim">→</span>
      {failedAt ? (
        <span className="text-pop-red">✕ 写页闸拒绝</span>
      ) : (
        <span className="font-black text-pop-amber">抽取断言 / 决定落点</span>
      )}
      <span className="text-pop-dim">→</span>
      <span>{failedAt ? '原子回滚 · 零半成品' : '写页 + INDEX / LOG'}</span>
      {!failedAt && (
        <>
          <span className="text-pop-dim">→</span>
          <span>git commit</span>
        </>
      )}
    </div>
  )
}

function PageRow({ page }: { page: { path: string; type: string; created: boolean } }) {
  const domain = DOMAIN_LABEL[page.type] ?? page.type
  const color = DOMAIN_COLOR[domain] ?? 'text-pop-dim'
  return (
    <div
      data-testid="archive-wiki-page"
      className="flex items-center gap-2 rounded-md border border-pop-bd/70 bg-white/[0.012] px-2 py-[5px]"
    >
      <span className={`w-[54px] shrink-0 font-mono text-[8px] font-black uppercase tracking-[.04em] ${color}`}>{domain}</span>
      <span className="min-w-0 flex-1 truncate text-[10px] text-pop-ink/80">{page.path}</span>
      <span
        className={`shrink-0 rounded-full border px-1.5 py-[1px] font-mono text-[8px] font-black ${
          page.created
            ? 'border-pop-green/30 bg-pop-green-soft text-pop-green'
            : 'border-pop-cyan/30 bg-pop-cyan-soft text-pop-cyan'
        }`}
      >
        {page.created ? '新建' : '更新'}
      </span>
    </div>
  )
}

export function ArchiveWindow({
  task,
  onOpenKnowledge,
}: {
  task: TaskView
  onMutated?: () => void
  /** 桌面壳装配：打开知识中心窗口（不传入 = 不显示该入口，测试友好）。 */
  onOpenKnowledge?: () => void
}) {
  const [archive, setArchive] = useState<TaskArchivePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [reportOpen, setReportOpen] = useState(false)
  const [tick, setTick] = useState(() => Date.now())
  /** 点开的冻结素材件（null = 预览弹窗关闭）。 */
  const [viewingPackItem, setViewingPackItem] = useState<ArchiveKnowledgeItemWire | null>(null)

  const load = useCallback(() => {
    return getTaskArchive(task.id)
      .then((next) => {
        setArchive(next)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取归档状态失败'))
  }, [task.id])

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

  // 编译中每秒走表（不额外请求）。
  useEffect(() => {
    if (!liveCompile) return
    const timer = window.setInterval(() => setTick(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [liveCompile])

  useEffect(() => {
    if (!reportOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReportOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reportOpen])

  const rows = useMemo(() => (archive ? buildRows(archive) : []), [archive])

  if (error) {
    return <div className="p-4 text-[11.5px] text-pop-red" data-testid="archive-window-error">{error}</div>
  }
  if (!archive) {
    return (
      <div className="flex h-full items-center gap-2 p-6 text-[11px] text-pop-dim">
        <Spinner className="size-3.5" /> 读取归档状态…
      </div>
    )
  }

  const state = archive.state as ArchiveStateShape | null
  const reflection = archive.reflection
  const entries = reflection?.entries ?? []
  const decided = reflection ? Object.keys(reflection.decisions).length : 0
  const archiving = task.status === 'archiving'
  const done = task.status === 'done'
  const awaitingArchive = task.status === 'awaiting_archive'
  const conflicts = rows.reduce((n, row) => n + (row.conflicts ?? 0), 0)
  const okProjects = rows.filter((row) => row.ok === true).length

  const cleanup = archive.cleanup
  const cleanupRunning = cleanup?.status === 'running'
  // 进程重启后 cleanup.json 可能停在 running —— 只有本进程在跑才算「清理中」。
  const cleanupInterrupted = cleanupRunning && !archive.cleanup_in_flight
  const cleanupLabel = cleanup
    ? cleanupInterrupted
      ? '中断'
      : (CLEANUP_LABEL[cleanup.status] ?? cleanup.status)
    : '未清理'

  const knowledge = archive.knowledge
  const wikiResult = knowledge?.wiki_result ?? null
  const packItems = knowledge?.items ?? []
  const excludedPackItems = packItems.filter((item) => item.excluded).length
  const activePackItems = packItems.filter((item) => !item.excluded)
  const packItemCap = knowledge?.pack_item_cap ?? DEFAULT_PACK_ITEM_CAP
  const estimateLoaded = activePackItems.filter((item) => item.bytes <= packItemCap).length
  const estimatePointer = activePackItems.length - estimateLoaded

  const compileFailed =
    !liveCompile && (compileState === 'failed' || (!compileState && wikiResult?.status === 'failed'))
  const compileCommitted =
    !liveCompile && !compileFailed && (wikiResult?.status === 'committed' || compileState === 'committed')
  const compileLabel = liveCompile
    ? (COMPILE_LABEL[compileState!] ?? compileState) +
      (compileState === 'queued' && knowledge?.compile_position != null ? ` #${knowledge.compile_position}` : '')
    : compileFailed
      ? '编译失败'
      : compileCommitted
        ? '已编译'
        : knowledge && knowledge.pack_items > 0
          ? '已冻结'
          : '—'

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
  const compileError = knowledge?.compile_error ?? wikiResult?.error ?? null

  const touched = wikiResult?.touched ?? []
  const updatedPages = touched.filter((page) => !page.created)
  const createdPages = touched.filter((page) => page.created)
  const wikiPageCount = touched.length
  const sortedTouched = [...updatedPages, ...createdPages]

  // 待裁决 = 活列表（采纳/忽略后服务端立刻不再返回）；wiki_result.finding_ids
  // 是**编译时快照**，采纳之后不会变 —— 不能拿它当现状（2026-11-10 用户：
  // 「我采纳了之后，归档弹窗那里还是提示有矛盾」）。
  const openFindings = knowledge?.findings ?? []
  const openFindingCount = openFindings.length
  const receiptFindingCount = wikiResult?.finding_ids?.length ?? 0
  /** 编译当时有矛盾、现在全部裁决完（只对返回了 findings 活列表的新服务端成立）。 */
  const findingsResolved = !!knowledge?.findings && receiptFindingCount > 0 && openFindingCount === 0

  // 判例入档回执（case-archive 独立队列）：新建 / 并档 / 失败。
  const caseResults = knowledge?.case_results ?? []
  const caseCreated = caseResults.filter((r) => r.action === 'created')
  const caseMerged = caseResults.filter((r) => r.action === 'merged')
  const caseFailed = caseResults.filter((r) => r.action === 'failed')
  const caseOk = caseCreated.length + caseMerged.length
  const caseSummary = [
    caseMerged.length > 0 ? `并档 ${caseMerged.length}` : '',
    caseCreated.length > 0 ? `新建 ${caseCreated.length}` : '',
    caseFailed.length > 0 ? `失败 ${caseFailed.length}` : '',
  ].filter(Boolean).join(' · ')

  const compileTone: Tone = liveCompile
    ? 'run'
    : compileFailed
      ? 'bad'
      : compileCommitted
        ? 'ok'
        : 'idle'
  const archiveTone: Tone = done
    ? 'ok'
    : archiving || archive.in_flight
      ? 'run'
      : 'idle'

  // 编排完成时间 = 各 project completedAt 的最大值（state.json 单源）。
  const projectCompletedAts = Object.values(state?.projects ?? {})
    .map((p) => p.completedAt)
    .filter((v): v is string => typeof v === 'string' && v !== '')
  const completedTimes = projectCompletedAts.map((v) => Date.parse(v)).filter((v) => Number.isFinite(v))
  const archiveCompletedAt =
    completedTimes.length > 0 ? new Date(Math.max(...completedTimes)).toISOString() : null
  const archiveDuration = diffMs(state?.startedAt, archiveCompletedAt)
  const stateDate = state?.date

  const verdictRows: Array<{ tone: Tone; title: string; detail: string; action?: ReactNode }> = []
  verdictRows.push({
    tone: archiveTone,
    title: done
      ? '归档完成'
      : awaitingArchive
        ? '归档未启动'
        : archive.in_flight || archiving
          ? '归档编排中'
          : (archive.status || '归档状态未知'),
    detail: done || archiving || archive.in_flight
      ? `${okProjects}/${rows.length || archive.projects.length} project 同步成功` +
        (conflicts > 0 ? ` · ${conflicts} 处术语冲突等 PR review` : ' · 无术语冲突') +
        (archive.report?.preflight ? ' · 有归档前拦截' : '')
      : awaitingArchive
        ? '末 phase 已验收，回主 Chat 说「归档」后才执行同步与知识沉淀'
        : `当前状态：${archive.status}`,
    action: archive.report_md ? (
      <button
        type="button"
        data-testid="archive-open-report"
        onClick={() => setReportOpen(true)}
        className="shrink-0 rounded-md border-[1.5px] border-pop-bd px-1.5 py-[3px] font-mono text-[8.5px] text-pop-cyan hover:border-pop-cyan/45 hover:text-pop-ink"
      >
        报告 ↗
      </button>
    ) : undefined,
  })

  let knowledgeTitle: string
  let knowledgeDetail: string
  let knowledgeAction: ReactNode
  if (compileFailed) {
    knowledgeTitle = '知识编译失败'
    knowledgeDetail = `${compileError?.code ?? 'COMPILE_FAILED'} · 已原子回滚，素材完好可重试`
    knowledgeAction = (
      <button type="button" onClick={() => setTab('knowledge')} className="shrink-0 rounded-md border-[1.5px] border-pop-bd px-1.5 py-[3px] font-mono text-[8.5px] text-pop-cyan hover:border-pop-cyan/45 hover:text-pop-ink">
        看原因 →
      </button>
    )
  } else if (wikiResult?.status === 'committed') {
    knowledgeTitle = '知识已落库'
    knowledgeDetail =
      (wikiResult.deduped
        ? `同包同焦点已编译过（快路径 no-op）· ${formatClock(wikiResult.finished_at)}`
        : `${wikiPageCount} 页：更新 ${wikiResult.updated} · 新建 ${wikiResult.created}` +
          (openFindingCount > 0
            ? ` · ${openFindingCount} 条矛盾待裁决`
            : findingsResolved
              ? ' · 矛盾已全部裁决'
              : ' · 无矛盾')) +
      (caseOk > 0 ? ` · 判例入档 ${caseOk}` : '') +
      (caseFailed.length > 0 ? ` · 判例失败 ${caseFailed.length}` : '')
    knowledgeAction = (
      <button type="button" data-testid="archive-open-knowledge-tab" onClick={() => setTab('knowledge')} className="shrink-0 rounded-md border-[1.5px] border-pop-bd px-1.5 py-[3px] font-mono text-[8.5px] text-pop-cyan hover:border-pop-cyan/45 hover:text-pop-ink">
        全部 ↗
      </button>
    )
  } else if (liveCompile) {
    knowledgeTitle = compileState === 'queued' ? '知识编译排队中' : '知识编译中'
    knowledgeDetail =
      `${compileState === 'queued' && knowledge?.compile_position != null ? `队列 #${knowledge.compile_position} · ` : ''}已运行 ${formatDuration(liveElapsed)}` +
      ' · 完成后本窗口自动出现回执，不用重开知识中心'
    knowledgeAction = (
      <button type="button" onClick={() => setTab('knowledge')} className="shrink-0 rounded-md border-[1.5px] border-pop-bd px-1.5 py-[3px] font-mono text-[8.5px] text-pop-cyan hover:border-pop-cyan/45 hover:text-pop-ink">
        看进度 →
      </button>
    )
  } else if (compileCommitted) {
    // 旧版本编译只留队列终态、没有落点回执 —— 如实说「已提交但无明细」。
    knowledgeTitle = '知识编译已提交'
    knowledgeDetail = '旧版本编译未记录落点明细；知识中心的 LOG.md 可查当次提交'
    knowledgeAction = (
      <button type="button" onClick={() => setTab('detail')} className="shrink-0 rounded-md border-[1.5px] border-pop-bd px-1.5 py-[3px] font-mono text-[8.5px] text-pop-cyan hover:border-pop-cyan/45 hover:text-pop-ink">
        看素材 →
      </button>
    )
  } else if (knowledge && knowledge.pack_items > 0) {
    knowledgeTitle = '素材已冻结'
    knowledgeDetail = `${knowledge.pack_items} 件已入 raw/archives · 等待知识中心串行队列编译`
    knowledgeAction = (
      <button type="button" onClick={() => setTab('detail')} className="shrink-0 rounded-md border-[1.5px] border-pop-bd px-1.5 py-[3px] font-mono text-[8.5px] text-pop-cyan hover:border-pop-cyan/45 hover:text-pop-ink">
        看素材 →
      </button>
    )
  } else {
    knowledgeTitle = '尚未投喂知识中心'
    knowledgeDetail = '知识中心不可用或投喂尚未开始；归档本身不受影响'
    knowledgeAction = undefined
  }
  verdictRows.push({ tone: compileTone, title: knowledgeTitle, detail: knowledgeDetail, action: knowledgeAction })

  const timeline: Array<{ at: string; title: string; sub: string; hot?: boolean }> = []
  if (state?.startedAt) timeline.push({ at: state.startedAt, title: '编排开始', sub: `${rows.length || archive.projects.length} project` })
  if (archiveCompletedAt) {
    timeline.push({
      at: archiveCompletedAt,
      title: '编排完成',
      sub: archiveDuration != null ? `用时 ${formatDuration(archiveDuration)}` : '全绿',
    })
  }
  if (knowledge?.pack_created_at) {
    timeline.push({ at: knowledge.pack_created_at, title: '素材冻结', sub: `${knowledge.pack_items} 件 · 入队` })
  }
  if (compileCommitted && compileFinishedAt) {
    timeline.push({
      at: compileFinishedAt,
      title: 'wiki 提交',
      sub: wikiPageCount > 0
        ? `${wikiPageCount} 页${compileDuration != null ? ` · ${formatDuration(compileDuration)}` : ''}`
        : '已提交（无明细回执）',
      hot: true,
    })
  } else if (liveCompile) {
    timeline.push({
      at: compileStartedAt ?? knowledge?.compile_queued_at ?? new Date(tick).toISOString(),
      title: compileState === 'queued' ? '等待编译' : '编译中',
      sub: composeRunningSub(),
      hot: true,
    })
  }

  function composeRunningSub(): string {
    if (compileState === 'queued' && knowledge?.compile_position != null) return `队列 #${knowledge.compile_position}`
    return `已运行 ${formatDuration(liveElapsed)}`
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="archive-window">
      {/* ── 头部：身份 / 状态 / 只读声明 ── */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-paper px-3 py-[7px]">
        <span className="font-mono text-[9px] font-black tracking-[.12em] text-pop-dim">ARCHIVE · 归档</span>
        <Chip tone={archiveTone}>
          {done
            ? '已完成'
            : archive.in_flight
              ? '编排中'
              : archiving
                ? '停在 archiving'
                : awaitingArchive
                  ? '待归档 · 未启动'
                  : archive.status}
        </Chip>
        <Chip tone={compileTone}>{`知识沉淀 · ${compileLabel}`}</Chip>
        <span className="font-mono text-[9px] text-pop-dim">
          {stateDate ? `date ${stateDate}` : '尚无 state.json'}
          {rows.length > 0 ? ` · ${rows.length} project` : ''}
        </span>
        <span className="ml-auto font-mono text-[9px] text-pop-dim/70" data-testid="archive-readonly-note">
          只读明细 · 操作在对话里完成
        </span>
      </div>

      {/* ── 状态条（替代大进度块）── */}
      <div className="flex flex-none items-center gap-0 overflow-x-auto border-b-[1.5px] border-pop-bd px-3 py-[7px]">
        <StatusItem
          tone={archiveTone}
          label="归档"
          value={done ? `${formatClock(archiveCompletedAt ?? undefined)} 全绿` : archiving || archive.in_flight ? '编排中' : awaitingArchive ? '未启动' : '—'}
        />
        <StatusArrow />
        <StatusItem
          tone={knowledge ? 'ok' : 'idle'}
          label="素材"
          value={knowledge ? `${knowledge.pack_items} 件${knowledge.pack_created_at ? ` · ${formatClock(knowledge.pack_created_at)}` : ''}` : '未投喂'}
        />
        <StatusArrow />
        <StatusItem
          tone={compileTone}
          label="Wiki"
          value={
            liveCompile
              ? `${compileState === 'queued' ? '排队中' : '编译中'} · ${formatDuration(liveElapsed)}`
              : compileCommitted
                ? wikiPageCount > 0
                  ? `${wikiPageCount} 页 · ${formatDuration(compileDuration)}`
                  : `已提交${compileDuration != null ? ` · ${formatDuration(compileDuration)}` : ''}`
                : compileFailed
                  ? '编译失败 · 已回滚'
                  : '—'
          }
        />
        <StatusArrow />
        <StatusItem
          tone={wikiResult || caseResults.length > 0 ? 'ok' : 'idle'}
          label="落点"
          value={
            wikiResult
              ? `新 ${wikiResult.created} / 更 ${wikiResult.updated}${caseOk > 0 ? ` · 判例 ${caseOk}` : ''}`
              : caseResults.length > 0
                ? `判例 ${caseOk}${caseFailed.length > 0 ? ` · 失败 ${caseFailed.length}` : ''}`
                : liveCompile
                  ? '等待提交'
                  : '—'
          }
        />
      </div>

      {/* ── 窗口内页签 ── */}
      <div className="flex flex-none items-center gap-0.5 border-b-[1.5px] border-pop-bd bg-pop-paper px-2" data-testid="archive-tabs">
        {(
          [
            ['overview', '概览', ''],
            ['knowledge', '知识落点', wikiPageCount > 0 ? String(wikiPageCount) : ''],
            ['detail', '明细', ''],
          ] as Array<[Tab, string, string]>
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            data-testid={`archive-tab-${id}`}
            onClick={() => setTab(id)}
            className={`-mb-[1.5px] border-b-2 px-2.5 pb-[7px] pt-2 font-mono text-[10px] font-bold transition-colors ${
              tab === id ? 'border-pop-pink text-pop-ink' : 'border-transparent text-pop-dim hover:text-pop-ink/80'
            }`}
          >
            {label}
            {count && <span className="ml-1 font-mono text-[8.5px] text-pop-dim">{count}</span>}
          </button>
        ))}
        <span className="ml-auto pr-1 font-mono text-[8.5px] text-pop-dim/70">
          {tab === 'overview' ? '一屏结论 · 先看这里' : tab === 'knowledge' ? '更新优先 · 矛盾置顶' : '按需展开 · 不堆在首屏'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* ═══════════ 概览 ═══════════ */}
        {tab === 'overview' && (
          <div data-testid="archive-panel-overview">
            {archive.report?.preflight && (
              <section
                data-testid="archive-preflight"
                className="mb-2.5 rounded-xl border-[1.5px] border-pop-red/35 bg-pop-red/[0.04] p-3"
              >
                <h3 className="mb-1.5 font-mono text-[9px] font-black tracking-[.08em] text-pop-red">归档前拦截 · 有未提交改动</h3>
                <p className="text-[10.5px] leading-relaxed text-pop-ink/85">{archive.report.preflight.message}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {archive.report.preflight.dirty_projects.map((p) => (
                    <span key={p} className="rounded-full border border-pop-red/30 bg-pop-red/10 px-1.5 py-[1px] font-mono text-[9px] text-pop-red">
                      {p}
                    </span>
                  ))}
                </div>
                <p className="mt-1.5 text-[9.5px] text-pop-dim">在主 Chat 里说「纳入」或「排除」，由 Agent 执行；窗口只读。</p>
              </section>
            )}
            {awaitingArchive && (
              <div
                data-testid="archive-not-started"
                className="mb-2.5 rounded-xl border-[1.5px] border-pop-pink/35 bg-pop-pink/[0.04] px-3 py-2 text-[10.5px] text-pop-ink/85"
              >
                末 phase 已验收，但归档尚未启动 —— 回主 Chat 说「归档」后才执行 git 同步 / ADR·术语合并 / 知识沉淀。
              </div>
            )}

            <div className="mb-3 overflow-hidden rounded-[10px] border-[1.5px] border-pop-bd bg-pop-paper" data-testid="archive-verdict">
              {verdictRows.map((row, i) => (
                <div key={i} className={`flex items-center gap-2.5 px-3 py-2.5 ${i > 0 ? 'border-t border-pop-bd/70' : ''}`}>
                  <VerdictIcon tone={row.tone} />
                  <div className="min-w-0 flex-1">
                    <b className="block text-[11px] font-black text-pop-ink">{row.title}</b>
                    <small className="mt-0.5 block truncate text-[9.5px] text-pop-dim">{row.detail}</small>
                  </div>
                  {row.action}
                </div>
              ))}
            </div>

            <div className="mb-3 grid grid-cols-2 overflow-hidden rounded-lg border-[1.5px] border-pop-bd bg-white/[0.015] sm:grid-cols-4">
              <div className="border-l border-pop-bd/70 first:border-l-0">
                <Kpi value={wikiPageCount > 0 ? wikiPageCount : '—'} label="wiki 页落点" tone="green" />
              </div>
              <div className="border-l border-pop-bd/70">
                <Kpi value={`${okProjects}/${rows.length || archive.projects.length}`} label="project 同步" />
              </div>
              <div className="border-t border-pop-bd/70 sm:border-t-0 sm:border-l">
                <Kpi value={conflicts} label="术语冲突" tone={conflicts > 0 ? 'amber' : undefined} />
              </div>
              <div className="border-t border-pop-bd/70 sm:border-t-0 sm:border-l">
                <Kpi value={cleanup ? formatBytes(cleanup.total_freed_bytes) : '—'} label="构建产物释放" tone="cyan" />
              </div>
            </div>

            {(liveCompile || compileFailed || (wikiResult && sortedTouched.length > 0) || caseResults.length > 0) && (
              <section className="mb-3 overflow-hidden rounded-lg border-[1.5px] border-pop-bd bg-pop-paper">
                <div className="flex items-center gap-2 border-b border-pop-bd/70 px-3 py-[7px] font-mono text-[9px] font-black uppercase tracking-[.06em] text-pop-dim">
                  {liveCompile ? '知识落点 · 编译中' : compileFailed ? '知识落点 · 编译失败' : '知识落点 · 更新优先'}
                  {sortedTouched.length > 0 && (
                    <button type="button" onClick={() => setTab('knowledge')} className="ml-auto font-mono text-[9px] font-bold normal-case tracking-normal text-pop-cyan underline decoration-dotted">
                      查看全部 {wikiPageCount} 页 →
                    </button>
                  )}
                </div>
                <div className="px-3 py-2">
                  {liveCompile ? (
                    <LiveBox
                      title={compileState === 'queued' ? `● 队列 #${knowledge?.compile_position ?? '?'} · 等待开跑` : '● 正在编译'}
                      detail={`已运行 ${formatDuration(liveElapsed)} · 预计 1–3 分钟`}
                    >
                      <CompileSteps />
                    </LiveBox>
                  ) : compileFailed ? (
                    <LiveBox title={`✕ ${compileError?.code ?? '编译失败'}`} detail={`${formatDuration(compileDuration)} · 未产生 commit`} tone="bad">
                      <div className="mt-1.5">
                        <CompileSteps failedAt />
                      </div>
                      {compileError?.message && (
                        <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[9px] text-pop-red/90">{compileError.message}</p>
                      )}
                    </LiveBox>
                  ) : (
                    <div>
                      {sortedTouched.slice(0, 5).map((page) => (
                        <div key={page.path} className="flex items-center gap-2 border-t border-pop-bd/45 py-1 text-[9.5px] first:border-t-0">
                          <span className={`w-[50px] shrink-0 font-mono text-[8px] font-black uppercase tracking-[.04em] ${DOMAIN_COLOR[DOMAIN_LABEL[page.type] ?? page.type] ?? 'text-pop-dim'}`}>
                            {DOMAIN_LABEL[page.type] ?? page.type}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-pop-ink/80">{page.path}</span>
                          <span className={`shrink-0 rounded-full border px-1 py-0 font-mono text-[7.5px] font-black ${page.created ? 'border-pop-green/30 bg-pop-green-soft text-pop-green' : 'border-pop-cyan/30 bg-pop-cyan-soft text-pop-cyan'}`}>
                            {page.created ? '新建' : '更新'}
                          </span>
                        </div>
                      ))}
                      {sortedTouched.length > 5 && (
                        <p className="pt-1 font-mono text-[8.5px] text-pop-dim/60">…（其余 {sortedTouched.length - 5} 页见「知识落点」页签）</p>
                      )}
                    </div>
                  )}
                  {caseResults.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-pop-bd/45 pt-1.5 font-mono text-[8.5px] text-pop-dim">
                      <span>判例入档 · {caseResults.length}</span>
                      {caseMerged.length > 0 && <span className="text-pop-purple">并档 {caseMerged.length}</span>}
                      {caseCreated.length > 0 && <span className="text-pop-green">新建 {caseCreated.length}</span>}
                      {caseFailed.length > 0 && <span className="text-pop-red">失败 {caseFailed.length}</span>}
                      <button type="button" onClick={() => setTab('knowledge')} className="ml-auto font-mono text-[8.5px] font-bold text-pop-cyan underline decoration-dotted">
                        看判例 →
                      </button>
                    </div>
                  )}
                </div>
              </section>
            )}

            {timeline.length > 0 && (
              <section className="mb-3 overflow-hidden rounded-lg border-[1.5px] border-pop-bd bg-pop-paper">
                <div className="flex items-center gap-2 border-b border-pop-bd/70 px-3 py-[7px] font-mono text-[9px] font-black uppercase tracking-[.06em] text-pop-dim">
                  时间线
                  <span className="ml-auto font-mono text-[8.5px] font-normal normal-case tracking-normal text-pop-dim/70">
                    {compileDuration != null ? `归档与 wiki 编译是两条并行轨 · 编译 ${formatDuration(compileDuration)}` : '为什么知识落点晚到'}
                  </span>
                </div>
                <div className="px-3 py-2.5">
                  <div className="flex items-start">
                    {timeline.map((node, i) => (
                      <div key={i} className="relative min-w-0 flex-1 pr-2.5">
                        {i < timeline.length - 1 && <span className="absolute left-[9px] right-0 top-[3px] h-px bg-pop-bd" />}
                        <span className={`relative z-[1] mb-1 block size-[7px] rounded-full ${node.hot ? 'bg-pop-amber' : 'bg-pop-green'}`} />
                        <div className="font-mono text-[9px] tabular-nums text-pop-cyan">{formatClock(node.at)}</div>
                        <div className="mt-0.5 truncate text-[9px] text-pop-ink/80">{node.title}</div>
                        <div className="truncate font-mono text-[8px] text-pop-dim/70">{node.sub}</div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[8.5px] leading-relaxed text-pop-dim/70">
                    归档 done 与 wiki 编译是<b className="text-pop-ink/75">两条并行轨</b>：编排完成不代表知识已落库；
                    本窗口在编译期间每 4 秒自动刷新，提交后回执原地出现。
                  </p>
                </div>
              </section>
            )}

            <div className="flex flex-wrap gap-1.5">
              {archive.report_md && (
                <button type="button" data-testid="archive-open-report-entry" onClick={() => setReportOpen(true)} className="rounded-md border-[1.5px] border-pop-bd bg-white/[0.015] px-2 py-1 font-mono text-[9px] text-pop-ink/80 hover:border-pop-bd hover:text-pop-ink">
                  归档报告 <span className="ml-1 text-pop-dim/70">弹窗</span>
                </button>
              )}
              <button type="button" onClick={() => setTab('detail')} className="rounded-md border-[1.5px] border-pop-bd bg-white/[0.015] px-2 py-1 font-mono text-[9px] text-pop-ink/80 hover:border-pop-bd hover:text-pop-ink">
                素材包 <span className="ml-1 text-pop-dim/70">{knowledge ? `${knowledge.pack_items} 件` : '—'}</span>
              </button>
              <button type="button" onClick={() => setTab('knowledge')} className="rounded-md border-[1.5px] border-pop-bd bg-white/[0.015] px-2 py-1 font-mono text-[9px] text-pop-ink/80 hover:border-pop-bd hover:text-pop-ink">
                知识落点 <span className="ml-1 text-pop-dim/70">{wikiPageCount > 0 ? `${wikiPageCount} 页` : '—'}</span>
              </button>
              {onOpenKnowledge && (
                <button type="button" data-testid="archive-open-knowledge" onClick={onOpenKnowledge} className="rounded-md border-[1.5px] border-pop-bd bg-white/[0.015] px-2 py-1 font-mono text-[9px] text-pop-ink/80 hover:border-pop-bd hover:text-pop-ink">
                  知识中心 <span className="ml-1 text-pop-dim/70">↗</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* ═══════════ 知识落点 ═══════════ */}
        {tab === 'knowledge' && (
          <div data-testid="archive-panel-knowledge">
            {liveCompile && (
              <>
                <LiveBox
                  title={compileState === 'queued' ? `● 编译排队中 · 队列 #${knowledge?.compile_position ?? '?'}` : '● 编译中'}
                  detail={`已运行 ${formatDuration(liveElapsed)} · 预计 1–3 分钟`}
                >
                  <CompileSteps />
                </LiveBox>
                <p className="mt-2 rounded-md border border-pop-cyan/15 bg-pop-cyan/[0.05] px-2.5 py-2 text-[9.5px] leading-relaxed text-pop-dim">
                  <b className="text-pop-ink/80">为什么知识中心现在还是旧内容：</b>
                  编译是一次原子提交 —— 写页、重建 INDEX、追加 LOG、git commit 在同一个事务里，提交前不落任何半页。
                  本页每 4 秒自动刷新，提交后原地变成回执，<b className="text-pop-ink/80">不需要重开知识中心</b>。
                </p>
              </>
            )}

            {compileFailed && (
              <>
                <LiveBox title={`✕ ${compileError?.code ?? '编译失败'} · 原子回滚`} detail={`${formatDuration(compileDuration)} · 未产生 commit`} tone="bad">
                  <div className="mt-1.5">
                    <CompileSteps failedAt />
                  </div>
                  {compileError?.message && (
                    <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[9px] text-pop-red/90">{compileError.message}</p>
                  )}
                </LiveBox>
                <p className="mt-2 rounded-md border border-pop-red/20 bg-pop-red/[0.04] px-2.5 py-2 text-[9.5px] leading-relaxed text-pop-dim">
                  素材包与 raw 文件完好，可重编译。回主 Chat 说「重试归档沉淀」，由服务端重新入队；若反复失败，错误码与原文在知识中心的编译队列里可查。
                </p>
              </>
            )}

            {!liveCompile && !compileFailed && wikiResult?.status === 'committed' && (
              <div data-testid="archive-wiki-result">
                <div className={`mb-2.5 grid grid-cols-2 overflow-hidden rounded-lg border-[1.5px] border-pop-bd bg-white/[0.015] ${caseResults.length > 0 ? 'sm:grid-cols-6' : 'sm:grid-cols-5'}`}>
                  <div className="border-l border-pop-bd/70 first:border-l-0">
                    <Kpi value={wikiResult.created} label="新建页" tone="green" />
                  </div>
                  <div className="border-l border-pop-bd/70">
                    <Kpi value={wikiResult.updated} label="更新页" tone="cyan" />
                  </div>
                  <div className="border-t border-pop-bd/70 sm:border-t-0 sm:border-l">
                    <Kpi value={openFindingCount} label="矛盾 · 待裁决" tone={openFindingCount > 0 ? 'amber' : undefined} />
                  </div>
                  <div className="border-t border-pop-bd/70 sm:border-t-0 sm:border-l">
                    <Kpi value={wikiPageCount} label="触及页" />
                  </div>
                  {caseResults.length > 0 && (
                    <div className="border-t border-pop-bd/70 sm:border-t-0 sm:border-l">
                      <Kpi
                        value={caseOk > 0 ? caseOk : caseFailed.length}
                        label={caseOk > 0 ? '判例入档' : '判例失败'}
                        tone={caseOk > 0 ? 'purple' : 'red'}
                      />
                    </div>
                  )}
                  <div className="border-t border-pop-bd/70 sm:border-t-0 sm:border-l">
                    <Kpi value={formatDuration(diffMs(wikiResult.started_at, wikiResult.finished_at))} label="编译用时" />
                  </div>
                </div>

                {wikiResult.deduped && (
                  <p className="mb-2 rounded-md border border-pop-cyan/15 bg-pop-cyan/[0.05] px-2.5 py-2 text-[9.5px] leading-relaxed text-pop-dim">
                    同包同焦点已编译过 —— 本次走快路径 no-op（未调 LLM、零副作用）。
                  </p>
                )}
                {!wikiResult.changed && !wikiResult.deduped && (
                  <p className="mb-2 rounded-md border border-pop-bd/60 bg-white/[0.015] px-2.5 py-2 text-[9.5px] leading-relaxed text-pop-dim">
                    本次编译产物与在盘逐字节相同（changed=false）：没有需要提交的变更。
                  </p>
                )}

                {openFindingCount > 0 ? (
                  <div
                    data-testid="archive-wiki-findings"
                    className="mb-2.5 rounded-lg border-[1.5px] border-pop-amber/35 bg-pop-amber/[0.04] px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="font-mono text-[10px] text-pop-amber">矛盾待裁决 · {openFindingCount}</b>
                      <span className="ml-auto font-mono text-[8.5px] font-black text-pop-amber">OPEN</span>
                    </div>
                    <p className="mt-1 text-[9.5px] leading-relaxed text-pop-dim">
                      新素材与现库断言冲突，旧断言保留原位、未静默覆盖。回主对话对 Agent 说「采纳修订 / 忽略」即可裁决 ——
                      只影响知识库，不改变任务 done。
                    </p>
                    <ul className="mt-1 space-y-1">
                      {openFindings.map((f) => (
                        <li
                          key={f.id}
                          data-testid="archive-wiki-finding-row"
                          className="flex items-baseline gap-1.5"
                        >
                          <span className="shrink-0 rounded-full border border-pop-amber/30 bg-pop-amber/10 px-1.5 py-[1px] font-mono text-[8px] text-pop-amber">
                            {f.kind}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[9.5px] text-pop-ink/80" title={f.title}>
                            {f.title}
                          </span>
                          <span className="shrink-0 font-mono text-[8.5px] text-pop-dim/70">{f.id}</span>
                        </li>
                      ))}
                    </ul>
                    {onOpenKnowledge && (
                      <button type="button" onClick={onOpenKnowledge} className="mt-1 font-mono text-[9px] text-pop-cyan underline decoration-dotted">
                        去知识中心裁决 ↗
                      </button>
                    )}
                  </div>
                ) : findingsResolved ? (
                  <div
                    data-testid="archive-wiki-findings-resolved"
                    className="mb-2.5 rounded-lg border-[1.5px] border-pop-green/25 bg-pop-green/[0.03] px-2.5 py-2 text-[9.5px] leading-relaxed text-pop-dim"
                  >
                    ✓ 编译时发现的 {receiptFindingCount} 处矛盾已全部裁决（wiki LOG 可查；不影响任务 done）。
                  </div>
                ) : receiptFindingCount > 0 ? (
                  // 旧服务端不返回 findings 活列表 —— 如实退回编译回执（快照），
                  // 不谎称「已裁决」。
                  <div
                    data-testid="archive-wiki-findings"
                    className="mb-2.5 rounded-lg border-[1.5px] border-pop-amber/35 bg-pop-amber/[0.04] px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="font-mono text-[10px] text-pop-amber">矛盾待裁决 · {receiptFindingCount}</b>
                      <span className="ml-auto font-mono text-[8.5px] font-black text-pop-amber">OPEN</span>
                    </div>
                    <p className="mt-1 text-[9.5px] leading-relaxed text-pop-dim">
                      新素材与现库断言冲突，旧断言保留原位、未静默覆盖。finding：
                      <span className="font-mono text-pop-ink/75">{wikiResult.finding_ids.join(' · ')}</span>
                    </p>
                  </div>
                ) : null}

                <PageGroup title="更新" pages={updatedPages} />
                <PageGroup title="新建" pages={createdPages} />

                {wikiResult.warnings.length > 0 && (
                  <div className="mt-2.5 rounded-lg border border-pop-bd/60 bg-white/[0.015] px-2.5 py-2">
                    <div className="font-mono text-[8.5px] font-black uppercase tracking-[.06em] text-pop-dim/70">编译告警</div>
                    <ul className="mt-1 space-y-0.5">
                      {wikiResult.warnings.map((w, i) => (
                        <li key={i} className="whitespace-pre-wrap break-words font-mono text-[9px] text-pop-dim">{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-pop-dim/70">
                  <span>commit <b className="text-pop-cyan">{wikiResult.commit ? wikiResult.commit.slice(0, 8) : '—'}</b></span>
                  <span>·</span>
                  <span>{formatClock(wikiResult.started_at)} → {formatClock(wikiResult.finished_at)}</span>
                  <span>·</span>
                  <span>持久回执：archive/wiki-result.json</span>
                </div>
              </div>
            )}

            {/* 判例走独立 case-archive 队列：可能先于 wiki 编译完成，所以不藏在回执块里 */}
            <CaseGroup results={caseResults} onOpenKnowledge={onOpenKnowledge} />

            {!liveCompile && !compileFailed && !wikiResult && (
              <p className="py-6 text-center text-[11px] text-pop-dim">
                {compileCommitted
                  ? '编译已提交，但旧版本未记录落点明细（知识中心 LOG.md 可查当次提交；重编译会补齐明细）。'
                  : knowledge && knowledge.pack_items > 0
                    ? '编译已入队，尚无落点回执。'
                    : '投喂尚未开始（或知识中心不可用）。'}
              </p>
            )}
          </div>
        )}

        {/* ═══════════ 明细 ═══════════ */}
        {tab === 'detail' && (
          <div data-testid="archive-panel-detail">
            <div className="grid gap-3 lg:grid-cols-2">
              <section className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
                <h3 className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
                  知识素材包
                  <span className="font-mono text-[8.5px] font-normal normal-case tracking-normal text-pop-dim/60">
                    {knowledge?.pack_path ?? 'raw/archives/…'}
                  </span>
                </h3>
                {!knowledge ? (
                  <p className="py-3 text-center text-[11px] text-pop-dim">投喂尚未开始（或知识中心不可用）。</p>
                ) : (
                  <div className="space-y-1.5 text-[10.5px]">
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-pop-bd/50 bg-black/10 px-2 py-1.5">
                      <span className="text-pop-dim">
                        已冻结素材件 <b className="ml-1 font-mono text-pop-ink">{knowledge.pack_items}</b>
                        {excludedPackItems > 0 && (
                          <span className="ml-1 font-mono text-[8.5px] text-pop-dim/60">（另 {excludedPackItems} 件已剔除）</span>
                        )}
                      </span>
                      <span className="ml-auto font-mono text-[8.5px] text-pop-dim/70">
                        按 {formatBytes(packItemCap)} 单件预算估算：{estimateLoaded} 载入 · {estimatePointer} 仅指针
                      </span>
                    </div>
                    {packItems.length > 0 && (
                      <ul data-testid="archive-pack-items" className="space-y-0.5 rounded-lg border border-pop-bd/50 bg-black/10 px-1.5 py-1">
                        {packItems.map((item) => {
                          const estimatedPointer = !item.excluded && item.bytes > packItemCap && item.kind !== 'archive-summary'
                          return (
                            <li key={item.path}>
                              <button
                                type="button"
                                title={item.path}
                                data-testid="archive-pack-item"
                                onClick={() => setViewingPackItem(item)}
                                className={[
                                  'flex w-full items-center gap-2 px-0.5 py-[1px] text-left transition-colors hover:bg-white/[0.06]',
                                  item.excluded ? 'opacity-50' : '',
                                ].join(' ')}
                              >
                                <span className={`shrink-0 font-mono text-[8.5px] ${item.excluded ? 'text-pop-dim line-through' : 'text-pop-cyan'}`}>{item.kind}</span>
                                <span className={`min-w-0 flex-1 truncate ${item.excluded ? 'text-pop-dim line-through' : 'text-pop-ink/85'}`}>{item.name}</span>
                                {item.excluded ? (
                                  <span className="shrink-0 rounded-full border border-pop-amber/30 bg-pop-amber-soft px-1 py-0 font-mono text-[7.5px] font-black text-pop-amber">已剔除</span>
                                ) : (
                                  <span className={`shrink-0 rounded-full border px-1 py-0 font-mono text-[7.5px] font-black ${estimatedPointer ? 'border-pop-amber/30 bg-pop-amber-soft text-pop-amber' : 'border-pop-green/30 bg-pop-green-soft text-pop-green'}`}>
                                    {estimatedPointer ? '仅指针' : '载入'}
                                  </span>
                                )}
                                <span className="shrink-0 font-mono text-[8.5px] tabular-nums text-pop-dim/70">{formatBytes(item.bytes)}</span>
                                <span className="shrink-0 font-mono text-[8.5px] text-pop-dim/40">▸</span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    {packItems.length > 0 && (
                      <p className="px-0.5 text-[8.5px] leading-relaxed text-pop-dim/60">
                        点任意件打开只读预览（.md 渲染 / .json 高亮）。「载入 / 仅指针」按 6 KB 单件预算估算；
                        焦点重编译会把命中件放宽到 20 KB。
                      </p>
                    )}
                    <div className="flex items-center justify-between rounded-lg border border-pop-bd/50 bg-black/10 px-2 py-1.5">
                      <span className="text-pop-dim">编译</span>
                      <span className={`font-mono font-black ${compileFailed ? 'text-pop-red' : compileCommitted ? 'text-pop-green' : liveCompile ? 'text-pop-amber' : 'text-pop-dim'}`}>
                        {compileLabel}
                      </span>
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
                <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
                  反思 · 沉淀决策 <span className="text-pop-dim/60">({decided}/{entries.length})</span>
                </h3>
                {entries.length === 0 ? (
                  <p className="py-3 text-center text-[11px] text-pop-dim">本次没有人工反思提案。</p>
                ) : (
                  <div className="space-y-1.5">
                    {entries.map((entry) => {
                      const decision = reflection?.decisions[entry.id]
                      return (
                        <div key={entry.id} data-testid="archive-reflection-entry" className="rounded-lg border border-pop-purple/25 bg-pop-purple-soft/20 px-2 py-1.5">
                          <div className="flex items-start gap-2">
                            <span className="min-w-0 flex-1 text-[10.5px] font-bold text-pop-ink">{entry.title}</span>
                            <span className={`shrink-0 font-mono text-[9px] font-black ${!decision ? 'text-pop-dim' : decision.action === 'ingest' ? 'text-pop-green' : 'text-pop-dim/80'}`}>
                              {!decision ? '未决' : decision.action === 'ingest' ? '已落 wiki' : '已跳过'}
                            </span>
                          </div>
                          {entry.target && <div className="font-mono text-[9px] text-pop-purple">{entry.target}</div>}
                          {decision?.raw_path && <div className="mt-0.5 font-mono text-[8.5px] text-pop-dim/70">{decision.raw_path}</div>}
                        </div>
                      )
                    })}
                  </div>
                )}
                {entries.length > 0 && decided < entries.length && (
                  <p className="mt-2 text-[9.5px] text-pop-dim/80">未决条目在主 Chat 里说「落 / 跳过」即可。</p>
                )}
                {entries.length === 0 && (
                  <p className="mt-2 rounded-md border border-pop-cyan/15 bg-pop-cyan/[0.05] px-2.5 py-2 text-[9.5px] leading-relaxed text-pop-dim">
                    归档编排在数秒内跑完时，模型可能还没来得及产出 <b className="text-pop-ink/80">propose_wiki_entries</b>；
                    自动素材编译不受影响，照常落库。
                  </p>
                )}
              </section>

              {(cleanup || done) && (
                <section data-testid="archive-cleanup" className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
                  <h3 className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
                    构建产物清理
                    <span
                      data-testid="archive-cleanup-status"
                      className={`rounded-full px-1.5 py-[1px] font-mono text-[8.5px] font-black ${
                        !cleanup
                          ? 'bg-pop-amber-soft text-pop-amber'
                          : cleanupInterrupted || cleanup.status === 'failed'
                            ? 'bg-pop-red-soft text-pop-red'
                            : cleanup.status === 'partial' || cleanupRunning
                              ? 'bg-pop-amber-soft text-pop-amber'
                              : 'bg-pop-green-soft text-pop-green'
                      }`}
                    >
                      {cleanupLabel}
                    </span>
                    {cleanup && (
                      <span className="ml-auto font-mono text-[9px] font-normal text-pop-dim">释放 {formatBytes(cleanup.total_freed_bytes)}</span>
                    )}
                  </h3>
                  {!cleanup ? (
                    <p className="py-2 text-[10.5px] text-pop-dim">
                      还没有清理记录（旧任务或服务端尚未开始）。归档完成后会自动清理各 project worktree 的构建产物。
                    </p>
                  ) : (
                    <>
                      {cleanup.error && <p className="mb-1.5 whitespace-pre-wrap break-words font-mono text-[9px] text-pop-red">{cleanup.error}</p>}
                      {cleanup.projects.length === 0 ? (
                        <p className="py-2 text-[10.5px] text-pop-dim">没有可清理的 project。</p>
                      ) : (
                        <div className="space-y-1.5">
                          {cleanup.projects.map((p) => (
                            <div key={p.project} data-testid="archive-cleanup-row" className="rounded-lg border border-pop-bd/50 bg-black/10 px-2 py-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[10.5px] font-bold text-pop-ink">{p.project}</span>
                                <span className="font-mono text-[9px] text-pop-dim">
                                  删除 {p.removed_count} 项 · 释放 {formatBytes(p.freed_bytes)}
                                </span>
                                {p.leftover_count > 0 && (
                                  <span className={`font-mono text-[9px] ${cleanupRunning ? 'text-pop-dim' : 'text-pop-amber'}`}>
                                    剩余 ignored {p.leftover_count} 项
                                  </span>
                                )}
                                {!p.ok && <span className="ml-auto font-mono text-[8.5px] font-black text-pop-red">未完成</span>}
                              </div>
                              {p.error && <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[9px] text-pop-red">{p.error}</div>}
                              {(p.failed?.length ?? 0) > 0 && (
                                <ul className="mt-1 space-y-0.5">
                                  {p.failed!.slice(0, 3).map((f) => (
                                    <li key={f.path} className="truncate font-mono text-[9px] text-pop-red/90">删除失败 · {f.path} — {f.message}</li>
                                  ))}
                                </ul>
                              )}
                              {(p.leftovers?.length ?? 0) > 0 && (
                                <ul className="mt-1 space-y-0.5">
                                  {p.leftovers!.slice(0, 4).map((l) => (
                                    <li key={l.path} className="truncate font-mono text-[9px] text-pop-dim">
                                      {l.path}
                                      {l.bytes != null ? ` · ${formatBytes(l.bytes)}` : ''}
                                    </li>
                                  ))}
                                  {(p.leftover_count ?? 0) > 4 && (
                                    <li className="font-mono text-[8.5px] text-pop-dim/60">…（其余 {p.leftover_count - 4} 项见主 Chat 的 get_archive_state）</li>
                                  )}
                                </ul>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="mt-2 text-[9.5px] leading-relaxed text-pop-dim/80">
                        只删 git 忽略且内部无跟踪文件的构建产物（node_modules / target / dist / classes / jar …）；
                        白名单之外、仍被忽略的目录只列清单。要清剩余 → 回主 Chat 说「清理剩余」，由 Agent 核对后逐条删除。
                      </p>
                    </>
                  )}
                </section>
              )}

              <section className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
                <h3 className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
                  归档报告 <span className="font-mono text-[8.5px] font-normal normal-case tracking-normal text-pop-dim/60">archive/report.md</span>
                  <span className="ml-auto font-mono text-[9px] font-normal normal-case tracking-normal text-pop-dim/60">
                    {archive.report ? (conflicts > 0 ? `${conflicts} 处术语冲突等 PR review` : '无术语冲突') : '报告尚未生成'}
                  </span>
                </h3>
                {archive.report_md ? (
                  <button type="button" data-testid="archive-open-report" onClick={() => setReportOpen(true)} className="rounded-md border-[1.5px] border-pop-bd bg-white/[0.015] px-2 py-1 font-mono text-[9px] text-pop-ink/80 hover:border-pop-bd hover:text-pop-ink">
                    打开归档报告 <span className="ml-1 text-pop-dim/70">弹窗</span>
                  </button>
                ) : (
                  <p className="text-[10.5px] text-pop-dim">报告尚未生成。</p>
                )}
                <p className="mt-2 text-[9.5px] leading-relaxed text-pop-dim/80">
                  报告正文较长，放在弹窗里单独滚动，窗口本身不套第二层滚动条。
                </p>
              </section>
            </div>

            <section className="mt-3 rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
              <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">PROJECT 同步结果</h3>
              {rows.length === 0 ? (
                <p className="py-4 text-center text-[11px] text-pop-dim">还没有可展示的 project。</p>
              ) : (
                <table className="w-full text-[10.5px]">
                  <thead>
                    <tr className="text-left font-mono text-[8.5px] uppercase tracking-[.06em] text-pop-dim">
                      <th className="pb-1">project</th>
                      <th className="pb-1">ADR</th>
                      <th className="pb-1">术语</th>
                      <th className="pb-1">冲突</th>
                      <th className="pb-1">commit</th>
                      <th className="pb-1">push</th>
                      <th className="pb-1">归档 PR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.project} data-testid="archive-project-row" className="border-t border-pop-bd/50 align-top">
                        <td className="py-1.5 font-bold text-pop-ink">
                          {row.project}
                          {row.skippedByState && <span className="ml-1 font-mono text-[8.5px] text-pop-dim">state-skip</span>}
                          {row.error && (
                            <div className="mt-0.5 max-w-[280px] whitespace-pre-wrap break-words font-mono text-[9px] font-normal text-pop-red">{row.error}</div>
                          )}
                        </td>
                        <td className="py-1.5 text-pop-ink/75"><ProjectCell value={row.adrMerged} /></td>
                        <td className="py-1.5 text-pop-ink/75"><ProjectCell value={row.termsAppended} /></td>
                        <td className={`py-1.5 ${(row.conflicts ?? 0) > 0 ? 'text-pop-amber' : 'text-pop-dim'}`}>
                          <ProjectCell value={row.conflicts} />
                        </td>
                        <td className="py-1.5 font-mono text-pop-cyan">{row.commit ? row.commit.slice(0, 8) : '—'}</td>
                        <td className={`py-1.5 ${row.pushed === null ? 'text-pop-dim' : row.pushed ? 'text-pop-green' : 'text-pop-red'}`}>
                          {row.pushed === null ? '—' : row.pushed ? '✓' : '✗'}
                        </td>
                        <td className="py-1.5 text-[9.5px] text-pop-dim">
                          {row.pr
                            ? row.pr.url
                              ? <a className="text-pop-cyan underline decoration-pop-cyan/30" href={row.pr.url} target="_blank" rel="noreferrer">{row.pr.action}</a>
                              : row.pr.action
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-2 text-[9.5px] leading-relaxed text-pop-dim/80">
                全绿才 done；任一 project 失败会停在 archiving，说「重试」由主 Chat 按 project 幂等续跑。
              </p>
            </section>

            {(archive.report?.delta?.length ?? 0) > 0 && (
              <section data-testid="archive-delta" className="mt-3 rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
                <h3 className="mb-2 flex items-center gap-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
                  放行后现场
                  <span className="font-normal text-pop-dim/60">
                    {archive.report?.delta_decision
                      ? `决策：${archive.report.delta_decision === 'include' ? '纳入归档' : '排除并记录'}`
                      : '无未提交改动'}
                  </span>
                </h3>
                <div className="space-y-1.5">
                  {(archive.report?.delta ?? []).map((d) => (
                    <div key={d.project} data-testid="archive-delta-row" className="rounded-lg border border-pop-bd/50 bg-black/10 px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10.5px] font-bold text-pop-ink">{d.project}</span>
                        <span className="font-mono text-[9px] text-pop-dim">{d.commits} 个末轮后提交</span>
                        <span className={`font-mono text-[9px] ${d.dirty_files.length > 0 ? 'text-pop-amber' : 'text-pop-green'}`}>
                          {d.dirty_files.length > 0 ? `${d.dirty_files.length} 个未提交` : '工作区干净'}
                        </span>
                        {d.from && (
                          <span className="ml-auto font-mono text-[8.5px] text-pop-dim/60">
                            {d.from.slice(0, 8)}..{(d.head ?? '?').slice(0, 8)}
                          </span>
                        )}
                      </div>
                      {d.subjects.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {d.subjects.slice(0, 6).map((s, i) => (
                            <li key={`${d.project}-${i}`} className="truncate font-mono text-[9px] text-pop-dim">{s}</li>
                          ))}
                        </ul>
                      )}
                      {d.dirty_files.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {d.dirty_files.slice(0, 6).map((f) => (
                            <li key={f} className="truncate font-mono text-[9px] text-pop-amber/90">未提交 · {f}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(archive.amendments?.length ?? 0) > 0 && (
              <section data-testid="archive-amendments" className="mt-3 rounded-xl border-[1.5px] border-pop-purple/25 bg-pop-purple-soft/15 p-3">
                <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-purple">
                  归档增补 <span className="font-normal text-pop-dim/60">({archive.amendments.length}) · 只增不改</span>
                </h3>
                <div className="space-y-1.5">
                  {archive.amendments.map((a) => (
                    <div key={a.id} data-testid="archive-amendment-entry" className="rounded-lg border border-pop-purple/20 bg-black/10 px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10.5px] font-bold text-pop-ink">{a.reason}</span>
                        {a.target && <span className="font-mono text-[9px] text-pop-purple">{a.target}</span>}
                        {a.ingest && <span className="font-mono text-[8.5px] text-pop-green">已送知识中心</span>}
                        <span className="ml-auto font-mono text-[8.5px] text-pop-dim/60">{a.at.replace('T', ' ').slice(0, 16)}</span>
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-[10px] leading-relaxed text-pop-dim">{a.content}</p>
                      {a.ingest?.raw_path && <div className="mt-0.5 font-mono text-[8.5px] text-pop-dim/70">{a.ingest.raw_path}</div>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* ── 页脚 ── */}
      <div className="flex flex-none items-center gap-2 border-t-[1.5px] border-pop-bd bg-pop-bg/95 px-3 py-[7px] font-mono text-[9px] text-pop-dim/70">
        <span><b className="text-pop-ink/75">只读明细</b> · 落 / 跳过 / 重试都在主 Chat 里说</span>
        <span className="ml-auto">
          {liveCompile ? '编译中 · 每 4s 自动刷新' : compileFailed ? '编译失败 · 可安全重试' : wikiResult ? '知识中心 ↗ · LOG.md 同源' : ''}
        </span>
      </div>

      <ArchivePackDialog item={viewingPackItem} onOpenChange={(open) => { if (!open) setViewingPackItem(null) }} />

      {reportOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" data-testid="archive-report-modal">
          <button
            type="button"
            aria-label="关闭归档报告"
            className="absolute inset-0 cursor-default bg-black/65 backdrop-blur-sm"
            onClick={() => setReportOpen(false)}
          />
          <div role="dialog" aria-modal="true" aria-label="归档报告" className="relative flex max-h-[min(78vh,740px)] w-full max-w-[780px] flex-col overflow-hidden rounded-xl border-[1.5px] border-pop-bd bg-pop-paper shadow-2xl">
            <div className="flex flex-none items-center gap-2 border-b-[1.5px] border-pop-bd bg-white/[0.02] px-3 py-2">
              <span className="text-[10px] font-black text-pop-ink/80">归档报告 · archive/report.md</span>
              <span className="font-mono text-[8.5px] text-pop-dim/60">{stateDate ? `${stateDate} · 只读` : '只读'}</span>
              <button type="button" onClick={() => setReportOpen(false)} aria-label="关闭" className="ml-auto px-0.5 text-[12px] text-pop-dim hover:text-pop-ink">✕</button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-pop-inset px-4 py-3.5">
              <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-[1.85] text-pop-ink/75">{archive.report_md}</pre>
            </div>
            <div className="flex flex-none items-center gap-2 border-t-[1.5px] border-pop-bd px-3 py-2 font-mono text-[8.5px] text-pop-dim/70">
              <span>Esc 关闭 · 点遮罩关闭</span>
              <span className="ml-auto">正文来自 archive/report.md，不在此处编辑</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusItem({ tone, label, value }: { tone: Tone; label: string; value: string }) {
  const dot =
    tone === 'ok'
      ? 'bg-pop-green'
      : tone === 'bad'
        ? 'bg-pop-red'
        : tone === 'run'
          ? 'bg-pop-amber'
          : 'bg-pop-dim/50'
  return (
    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="font-mono text-[9px] font-black uppercase tracking-[.05em] text-pop-dim/70">{label}</span>
      <span className="truncate text-[9.5px] text-pop-ink/75">{value}</span>
    </div>
  )
}

function StatusArrow() {
  return <span className="mx-2 shrink-0 font-mono text-[9px] text-pop-dim/50">→</span>
}

function PageGroup({ title, pages }: { title: string; pages: Array<{ path: string; type: string; created: boolean }> }) {
  if (pages.length === 0) return null
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-2 font-mono text-[8.5px] font-black uppercase tracking-[.06em] text-pop-dim/70">
        {title} · {pages.length}
        <span className="h-px flex-1 bg-pop-bd/70" />
      </div>
      <div className="space-y-[3px]">
        {pages.map((page) => (
          <PageRow key={page.path} page={page} />
        ))}
      </div>
    </div>
  )
}

const CASE_ACTION: Record<ArchiveCaseResultWire['action'], { label: string; cls: string }> = {
  created: { label: '新建', cls: 'border-pop-green/30 bg-pop-green-soft text-pop-green' },
  merged: { label: '并档', cls: 'border-pop-purple/30 bg-pop-purple-soft text-pop-purple' },
  failed: { label: '失败', cls: 'border-pop-red/30 bg-pop-red-soft text-pop-red' },
}

function CaseGroup({
  results,
  onOpenKnowledge,
}: {
  results: ArchiveCaseResultWire[]
  onOpenKnowledge?: () => void
}) {
  if (results.length === 0) return null
  return (
    <div className="mt-2" data-testid="archive-case-results">
      <div className="mb-1 flex items-center gap-2 font-mono text-[8.5px] font-black uppercase tracking-[.06em] text-pop-dim/70">
        判例入档 · {results.length}
        <span className="h-px flex-1 bg-pop-bd/70" />
        {onOpenKnowledge && (
          <button type="button" onClick={onOpenKnowledge} className="font-mono text-[8.5px] font-bold normal-case tracking-normal text-pop-cyan underline decoration-dotted">
            知识中心 ↗
          </button>
        )}
      </div>
      <div className="space-y-[3px]">
        {results.map((result) => {
          const action = CASE_ACTION[result.action]
          const merged = result.action === 'merged' &&
            result.occurrences_before != null && result.occurrences_after != null
          return (
            <div
              key={result.queue_task_id}
              data-testid="archive-case-result"
              className="rounded-md border border-pop-bd/70 bg-white/[0.012] px-2 py-1"
            >
              <div className="flex items-center gap-2">
                <span className={`shrink-0 rounded-full border px-1.5 py-[1px] font-mono text-[8px] font-black ${action.cls}`}>
                  {action.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-pop-ink/80">{result.symptom}</span>
                {merged && (
                  <span className="shrink-0 font-mono text-[8.5px] tabular-nums text-pop-dim">
                    occurrence {result.occurrences_before} → {result.occurrences_after}
                  </span>
                )}
              </div>
              {result.case_path && (
                <div className="mt-0.5 truncate font-mono text-[8.5px] text-pop-dim/70">{result.case_path}</div>
              )}
              {result.error && (
                <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[9px] text-pop-red/90">
                  {result.error.code}: {result.error.message}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
