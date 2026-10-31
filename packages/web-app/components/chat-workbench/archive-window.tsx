'use client'

// 归档台（2026-10-31 AI-native 归档 · v2 定稿）—— 只读明细面。
//
// 这里只展示事实：project 同步结果、术语冲突、反思决策、知识包 / 编译状态、
// 归档报告。所有操作（落 wiki / 跳过 / 重试）都回主 Chat 用自然语言完成，
// 所以本窗口没有任何按钮 —— 页脚写死「只读明细 · 操作在对话里完成」。

import { useCallback, useEffect, useState } from 'react'
import {
  getTaskArchive,
  type ArchiveProjectReportWire,
  type TaskArchivePayload,
  type TaskView,
} from '@/lib/tasks-api'
import { Spinner } from '@/components/ui/spinner'

interface ProjectState {
  status?: string
  commit?: string | null
  completedAt?: string
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

const COMPILE_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '编译中',
  committed: '已编译',
  failed: '编译失败',
}

function buildRows(archive: TaskArchivePayload): ProjectRow[] {
  const projects = (archive.state as { projects?: Record<string, ProjectState> } | null)?.projects ?? {}
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

export function ArchiveWindow({ task }: { task: TaskView; onMutated?: () => void }) {
  const [archive, setArchive] = useState<TaskArchivePayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    return getTaskArchive(task.id)
      .then((next) => { setArchive(next); setError(null) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取归档状态失败'))
  }, [task.id])

  useEffect(() => {
    let alive = true
    void load()
    const timer = window.setInterval(() => {
      if (alive) void load()
    }, archive?.in_flight || task.status === 'archiving' ? 4_000 : 20_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [load, archive?.in_flight, task.status])

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

  const rows = buildRows(archive)
  const reflection = archive.reflection
  const decided = reflection ? Object.keys(reflection.decisions).length : 0
  const entries = reflection?.entries ?? []
  const conflicts = rows.reduce((n, row) => n + (row.conflicts ?? 0), 0)
  const archiving = task.status === 'archiving'
  const done = task.status === 'done'
  const stateDate = (archive.state as { date?: string } | null)?.date
  const compile = archive.knowledge?.compile_state
  const compileLabel = compile
    ? (COMPILE_LABEL[compile] ?? compile)
    : archive.knowledge && archive.knowledge.pack_items > 0
      ? '已冻结'
      : '—'

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="archive-window">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9.5px] font-black tracking-[.08em] text-pop-dim">ARCHIVE · 归档</span>
        <span className={`rounded-full px-2 py-[3px] font-mono text-[9.5px] font-black ${
          done
            ? 'bg-pop-green-soft text-pop-green'
            : archiving
              ? 'bg-pop-amber-soft text-pop-amber'
              : 'bg-pop-green-soft text-pop-green'
        }`}>
          {done ? '已完成' : archive.in_flight ? '编排中' : archiving ? '停在 archiving' : archive.status}
        </span>
        <span className="font-mono text-[9px] text-pop-dim">
          {stateDate ? `date ${stateDate}` : '尚无 state.json'}
          {rows.length > 0 ? ` · ${rows.length} project` : ''}
        </span>
        <span className="ml-auto font-mono text-[9px] text-pop-dim/70" data-testid="archive-readonly-note">
          只读明细 · 操作在对话里完成
        </span>
      </div>

      {archive.report?.preflight && (
        <section
          data-testid="archive-preflight"
          className="mb-3 rounded-xl border-[1.5px] border-pop-red/35 bg-pop-red/[0.04] p-3"
        >
          <h3 className="mb-1.5 font-mono text-[9px] font-black tracking-[.08em] text-pop-red">
            归档前拦截 · 有未提交改动
          </h3>
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

      <section className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
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
                      <div className="mt-0.5 max-w-[280px] whitespace-pre-wrap break-words font-mono text-[9px] font-normal text-pop-red">
                        {row.error}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 text-pop-ink/75"><ProjectCell value={row.adrMerged} /></td>
                  <td className="py-1.5 text-pop-ink/75"><ProjectCell value={row.termsAppended} /></td>
                  <td className={`py-1.5 ${ (row.conflicts ?? 0) > 0 ? 'text-pop-amber' : 'text-pop-dim'}`}>
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
        <section
          data-testid="archive-delta"
          className="mt-3 rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3"
        >
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
              <div
                key={d.project}
                data-testid="archive-delta-row"
                className="rounded-lg border border-pop-bd/50 bg-black/10 px-2 py-1.5"
              >
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

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <section className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
          <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
            反思 · 沉淀决策 <span className="text-pop-dim/60">({decided}/{entries.length})</span>
          </h3>
          {entries.length === 0 ? (
            <p className="py-3 text-center text-[11px] text-pop-dim">还没有反思建议。主 Chat 会在归档开始时逐条问。</p>
          ) : (
            <div className="space-y-1.5">
              {entries.map((entry) => {
                const decision = reflection?.decisions[entry.id]
                return (
                  <div key={entry.id} data-testid="archive-reflection-entry" className="rounded-lg border border-pop-purple/25 bg-pop-purple-soft/20 px-2 py-1.5">
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 text-[10.5px] font-bold text-pop-ink">{entry.title}</span>
                      <span className={`shrink-0 font-mono text-[9px] font-black ${
                        !decision ? 'text-pop-dim' : decision.action === 'ingest' ? 'text-pop-green' : 'text-pop-dim/80'
                      }`}>
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
        </section>

        <section className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
          <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">知识素材包</h3>
          {!archive.knowledge ? (
            <p className="py-3 text-center text-[11px] text-pop-dim">投喂尚未开始（或知识中心不可用）。</p>
          ) : (
            <div className="space-y-1.5 text-[10.5px]">
              <div className="flex items-center justify-between rounded-lg border border-pop-bd/50 bg-black/10 px-2 py-1.5">
                <span className="text-pop-dim">已冻结素材件</span>
                <span className="font-mono font-black text-pop-ink">{archive.knowledge.pack_items}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-pop-bd/50 bg-black/10 px-2 py-1.5">
                <span className="text-pop-dim">编译</span>
                <span className={`font-mono font-black ${
                  compile === 'failed' ? 'text-pop-red' : compile === 'committed' ? 'text-pop-green' : 'text-pop-amber'
                }`}>
                  {compileLabel}
                  {compile === 'queued' && archive.knowledge.compile_position != null
                    ? ` #${archive.knowledge.compile_position}`
                    : ''}
                </span>
              </div>
            </div>
          )}
          <p className="mt-2 text-[9.5px] leading-relaxed text-pop-dim/80">
            素材包包含台账 / 打回 / 执行摘录 / diff / 产物 / ADR+notes / 总结共七件，编译进 wiki 由知识中心串行队列执行。
          </p>
        </section>
      </div>

      <section className="mt-3 rounded-xl border-[1.5px] border-pop-bd bg-pop-bg p-3">
        <h3 className="mb-2 flex items-center gap-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
          归档报告 · archive/report.md
          <span className="text-[9px] font-normal text-pop-dim/60">
            {archive.report
              ? conflicts > 0
                ? `${conflicts} 处术语冲突等 PR review`
                : '无冲突'
              : '报告尚未生成'}
          </span>
        </h3>
        {archive.report_md ? (
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-pop-dim">{archive.report_md}</pre>
        ) : (
          <p className="text-[10.5px] text-pop-dim">报告尚未生成。</p>
        )}
      </section>

      {(archive.amendments?.length ?? 0) > 0 && (
        <section
          data-testid="archive-amendments"
          className="mt-3 rounded-xl border-[1.5px] border-pop-purple/25 bg-pop-purple-soft/15 p-3"
        >
          <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-purple">
            归档增补 <span className="font-normal text-pop-dim/60">({archive.amendments.length}) · 只增不改</span>
          </h3>
          <div className="space-y-1.5">
            {archive.amendments.map((a) => (
              <div
                key={a.id}
                data-testid="archive-amendment-entry"
                className="rounded-lg border border-pop-purple/20 bg-black/10 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10.5px] font-bold text-pop-ink">{a.reason}</span>
                  {a.target && <span className="font-mono text-[9px] text-pop-purple">{a.target}</span>}
                  {a.ingest && <span className="font-mono text-[8.5px] text-pop-green">已送知识中心</span>}
                  <span className="ml-auto font-mono text-[8.5px] text-pop-dim/60">
                    {a.at.replace('T', ' ').slice(0, 16)}
                  </span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-[10px] leading-relaxed text-pop-dim">
                  {a.content}
                </p>
                {a.ingest?.raw_path && (
                  <div className="mt-0.5 font-mono text-[8.5px] text-pop-dim/70">{a.ingest.raw_path}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
