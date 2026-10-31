'use client'

// 归档台（2026-10-31 AI-native 归档 · v2 定稿）—— 只读明细面。
//
// 这里只展示事实：project 同步结果、术语冲突、反思决策、知识包 / 编译状态、
// 归档报告。所有操作（落 wiki / 跳过 / 重试）都回主 Chat 用自然语言完成，
// 所以本窗口没有任何按钮 —— 页脚写死「只读明细 · 操作在对话里完成」。

import { useCallback, useEffect, useState } from 'react'
import {
  getTaskArchive,
  type ArchiveKnowledgeItemWire,
  type ArchiveProjectReportWire,
  type TaskArchivePayload,
  type TaskView,
} from '@/lib/tasks-api'
import { Spinner } from '@/components/ui/spinner'
import { ArchivePackDialog } from './archive-pack-dialog'

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

/** done 后构建产物清理状态（running + 非 in_flight = 进程中断）。 */
const CLEANUP_LABEL: Record<string, string> = {
  running: '清理中',
  done: '已清理',
  partial: '部分失败',
  failed: '失败',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
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
  /** 点开的冻结素材件（null = 预览弹窗关闭）。 */
  const [viewingPackItem, setViewingPackItem] = useState<ArchiveKnowledgeItemWire | null>(null)

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
    }, archive?.in_flight || task.status === 'archiving' || archive?.cleanup_in_flight ? 4_000 : 20_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [load, archive?.in_flight, archive?.cleanup_in_flight, task.status])

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
  // archive-consent: 末 phase 已验收、归档尚未启动 —— 窗口可能被深链/旧窗口打开，
  // 必须如实说「未启动」，不能冒充「编排中」。
  const awaitingArchive = task.status === 'awaiting_archive'
  const stateDate = (archive.state as { date?: string } | null)?.date
  const compile = archive.knowledge?.compile_state
  const packItems = archive.knowledge?.items ?? []
  const excludedPackItems = packItems.filter((item) => item.excluded).length
  const compileLabel = compile
    ? (COMPILE_LABEL[compile] ?? compile)
    : archive.knowledge && archive.knowledge.pack_items > 0
      ? '已冻结'
      : '—'
  const cleanup = archive.cleanup
  const cleanupRunning = cleanup?.status === 'running'
  // 进程重启后 cleanup.json 可能停在 running —— 只有本进程在跑才算「清理中」。
  const cleanupInterrupted = cleanupRunning && !archive.cleanup_in_flight
  const cleanupLabel = cleanup
    ? cleanupInterrupted
      ? '中断'
      : (CLEANUP_LABEL[cleanup.status] ?? cleanup.status)
    : '未清理'

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="archive-window">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9.5px] font-black tracking-[.08em] text-pop-dim">ARCHIVE · 归档</span>
        <span className={`rounded-full px-2 py-[3px] font-mono text-[9.5px] font-black ${
          done
            ? 'bg-pop-green-soft text-pop-green'
            : archiving
              ? 'bg-pop-amber-soft text-pop-amber'
              : awaitingArchive
                ? 'bg-pop-pink-soft text-pop-pink'
                : 'bg-pop-green-soft text-pop-green'
        }`}>
          {done ? '已完成' : archive.in_flight ? '编排中' : archiving ? '停在 archiving' : awaitingArchive ? '待归档 · 未启动' : archive.status}
        </span>
        <span className="font-mono text-[9px] text-pop-dim">
          {stateDate ? `date ${stateDate}` : '尚无 state.json'}
          {rows.length > 0 ? ` · ${rows.length} project` : ''}
        </span>
        <span className="ml-auto font-mono text-[9px] text-pop-dim/70" data-testid="archive-readonly-note">
          只读明细 · 操作在对话里完成
        </span>
      </div>

      {awaitingArchive && (
        <div
          data-testid="archive-not-started"
          className="mb-3 rounded-xl border-[1.5px] border-pop-pink/35 bg-pop-pink/[0.04] px-3 py-2 text-[10.5px] text-pop-ink/85"
        >
          末 phase 已验收，但归档尚未启动 —— 回主 Chat 说「归档」后才执行 git 同步 / ADR·术语合并 / 知识沉淀。
        </div>
      )}

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

      {(cleanup || done) && (
        <section
          data-testid="archive-cleanup"
          className="mt-3 rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3"
        >
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
              <span className="ml-auto font-mono text-[9px] font-normal text-pop-dim">
                释放 {formatBytes(cleanup.total_freed_bytes)}
              </span>
            )}
          </h3>
          {!cleanup ? (
            <p className="py-2 text-[10.5px] text-pop-dim">
              还没有清理记录（旧任务或服务端尚未开始）。归档完成后会自动清理各 project worktree 的构建产物。
            </p>
          ) : (
            <>
              {cleanup.error && (
                <p className="mb-1.5 whitespace-pre-wrap break-words font-mono text-[9px] text-pop-red">
                  {cleanup.error}
                </p>
              )}
              {cleanup.projects.length === 0 ? (
                <p className="py-2 text-[10.5px] text-pop-dim">没有可清理的 project。</p>
              ) : (
                <div className="space-y-1.5">
                  {cleanup.projects.map((p) => (
                    <div
                      key={p.project}
                      data-testid="archive-cleanup-row"
                      className="rounded-lg border border-pop-bd/50 bg-black/10 px-2 py-1.5"
                    >
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
                        {!p.ok && (
                          <span className="ml-auto font-mono text-[8.5px] font-black text-pop-red">未完成</span>
                        )}
                      </div>
                      {p.error && (
                        <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[9px] text-pop-red">
                          {p.error}
                        </div>
                      )}
                      {(p.failed?.length ?? 0) > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {p.failed!.slice(0, 3).map((f) => (
                            <li key={f.path} className="truncate font-mono text-[9px] text-pop-red/90">
                              删除失败 · {f.path} — {f.message}
                            </li>
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
                            <li className="font-mono text-[8.5px] text-pop-dim/60">
                              …（其余 {p.leftover_count - 4} 项见主 Chat 的 get_archive_state）
                            </li>
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
                <span className="text-pop-dim">
                  已冻结素材件
                  {excludedPackItems > 0 && (
                    <span className="ml-1 font-mono text-[8.5px] text-pop-dim/60">（另 {excludedPackItems} 件已剔除）</span>
                  )}
                </span>
                <span className="font-mono font-black text-pop-ink">{archive.knowledge.pack_items}</span>
              </div>
              {packItems.length > 0 && (
                <ul
                  data-testid="archive-pack-items"
                  className="space-y-0.5 rounded-lg border border-pop-bd/50 bg-black/10 px-1.5 py-1"
                >
                  {packItems.map((item) => (
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
                        <span className={`shrink-0 font-mono text-[8.5px] ${item.excluded ? 'text-pop-dim line-through' : 'text-pop-cyan'}`}>
                          {item.kind}
                        </span>
                        <span className={`min-w-0 flex-1 truncate ${item.excluded ? 'text-pop-dim line-through' : 'text-pop-ink/85'}`}>
                          {item.name}
                        </span>
                        {item.excluded && (
                          <span className="shrink-0 font-mono text-[8.5px] font-black text-pop-amber">已剔除</span>
                        )}
                        <span className="shrink-0 font-mono text-[8.5px] tabular-nums text-pop-dim/70">{formatBytes(item.bytes)}</span>
                        <span className="shrink-0 font-mono text-[8.5px] text-pop-dim/40">▸</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {packItems.length > 0 && (
                <p className="px-0.5 text-[8.5px] text-pop-dim/60">点任意件打开只读预览（.md 渲染 / .json 高亮）。</p>
              )}
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
            素材包 = 验收台账 / phase 打回记录 / 执行 JSONL 摘录 / PR diff / matt 产物指针 / ADR·notes，
            外加归档总结；件数只算未剔除的件，编译进 wiki 由知识中心串行队列执行。
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

      <ArchivePackDialog
        item={viewingPackItem}
        onOpenChange={(open) => { if (!open) setViewingPackItem(null) }}
      />
    </div>
  )
}
