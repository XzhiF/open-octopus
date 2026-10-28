'use client'

// 2026-10-28 task-thread M5: the archive window — per-project results, the
// report, the knowledge reflection decisions, and the idempotent retry.
// The conversation stays in the main chat; this is a dedicated surface.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  getTaskArchive,
  postArchiveRetry,
  postReflectionDecision,
  type TaskArchivePayload,
  type TaskView,
} from '@/lib/tasks-api'
import { Spinner } from '@/components/ui/spinner'

interface ProjectState {
  status?: string
  commit?: string | null
  completedAt?: string
}

export function ArchiveWindow({ task, onMutated }: { task: TaskView; onMutated?: () => void }) {
  const [archive, setArchive] = useState<TaskArchivePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    return getTaskArchive(task.id)
      .then((next) => { setArchive(next); setError(null) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取归档状态失败'))
  }, [task.id])

  useEffect(() => {
    let alive = true
    void load()
    const timer = window.setInterval(() => { if (alive) void load() }, archive?.in_flight || task.status === 'archiving' ? 4_000 : 20_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [load, archive?.in_flight, task.status])

  const decide = async (entryId: string, action: 'ingest' | 'skip') => {
    if (busy) return
    setBusy(entryId)
    try {
      const res = await postReflectionDecision(task.id, { entry_id: entryId, action })
      setArchive((prev) => (prev ? { ...prev, reflection: res.store } : prev))
      toast.success(action === 'ingest' ? '已落 wiki（编译已入队）' : '已跳过')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '沉淀决策失败')
    } finally {
      setBusy(null)
    }
  }

  const retry = async () => {
    if (busy) return
    setBusy('retry')
    try {
      await postArchiveRetry(task.id)
      toast.success('归档续跑已触发')
      await load()
      onMutated?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '重试归档失败')
    } finally {
      setBusy(null)
    }
  }

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

  const projects = (archive.state as { projects?: Record<string, ProjectState> } | null)?.projects ?? {}
  const projectRows = Object.entries(projects)
  const reflection = archive.reflection
  const archiving = task.status === 'archiving'

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="archive-window">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9.5px] font-black tracking-[.08em] text-pop-dim">ARCHIVE · 归档</span>
        <span className={`rounded-full px-2 py-[3px] font-mono text-[9.5px] font-black ${archiving ? 'bg-pop-amber-soft text-pop-amber animate-pulse' : 'bg-pop-green-soft text-pop-green'}`}>
          {archive.in_flight ? '编排中' : archiving ? '停在 archiving' : '已完成'}
        </span>
        <span className="font-mono text-[9px] text-pop-dim">{archive.state ? `date ${(archive.state as { date?: string }).date ?? '—'}` : '尚无 state.json'}</span>
        {archiving && (
          <button
            type="button"
            onClick={() => void retry()}
            disabled={busy !== null}
            data-testid="archive-retry"
            className="ml-auto rounded border border-pop-amber/50 bg-pop-amber-soft px-2 py-1 text-[10px] font-black text-pop-amber hover:opacity-90 disabled:opacity-50"
          >
            ↻ 重试归档
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <section className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
          <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">PROJECT 结果</h3>
          {projectRows.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-pop-dim">还没有 project 完成归档。</p>
          ) : (
            <table className="w-full text-[10.5px]">
              <thead>
                <tr className="text-left font-mono text-[8.5px] uppercase tracking-[.06em] text-pop-dim">
                  <th className="pb-1">project</th><th className="pb-1">commit</th><th className="pb-1">完成</th><th className="pb-1">状态</th>
                </tr>
              </thead>
              <tbody>
                {projectRows.map(([name, p]) => (
                  <tr key={name} className="border-t border-pop-bd/50">
                    <td className="py-1.5 font-bold text-pop-ink">{name}</td>
                    <td className="py-1.5 font-mono text-pop-cyan">{p.commit ? p.commit.slice(0, 8) : '—'}</td>
                    <td className="py-1.5 font-mono text-[9px] text-pop-dim">{p.completedAt ? new Date(p.completedAt).toLocaleString() : '—'}</td>
                    <td className="py-1.5 text-pop-green">✓</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[9.5px] leading-relaxed text-pop-dim/80">
            全绿才 done；任一 project 失败会停在 archiving，重试按 project 幂等续跑。系统自动投喂已在归档开始时触发（知识中心）。
          </p>
        </section>

        <section className="rounded-xl border-[1.5px] border-pop-bd bg-pop-paper/50 p-3">
          <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">反思 · 沉淀建议</h3>
          {!reflection || reflection.entries.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-pop-dim">还没有反思建议。主 chat 会在进入归档时给出。</p>
          ) : (
            <div className="space-y-1.5">
              {reflection.entries.map((entry) => {
                const decision = reflection.decisions[entry.id]
                return (
                  <div key={entry.id} className="rounded-lg border border-pop-purple/25 bg-pop-purple-soft/20 px-2 py-1.5">
                    <div className="text-[10.5px] font-bold text-pop-ink">{entry.title}</div>
                    {entry.target && <div className="font-mono text-[9px] text-pop-purple">{entry.target}</div>}
                    <div className="mt-1 flex items-center gap-1">
                      {decision ? (
                        <span className={`font-mono text-[9px] font-black ${decision.action === 'ingest' ? 'text-pop-green' : 'text-pop-dim'}`}>
                          {decision.action === 'ingest' ? '已落 wiki' : '已跳过'}
                          {decision.raw_path ? <span className="ml-1 text-pop-dim/60">{decision.raw_path}</span> : null}
                        </span>
                      ) : (
                        <>
                          <button type="button" disabled={busy !== null} onClick={() => void decide(entry.id, 'ingest')}
                            className="rounded bg-pop-purple px-1.5 py-0.5 text-[9px] font-black text-pop-bg disabled:opacity-50">
                            落 wiki
                          </button>
                          <button type="button" disabled={busy !== null} onClick={() => void decide(entry.id, 'skip')}
                            className="rounded border border-pop-bd px-1.5 py-0.5 text-[9px] text-pop-dim hover:text-pop-ink disabled:opacity-50">
                            跳过
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <section className="mt-3 rounded-xl border-[1.5px] border-pop-bd bg-pop-bg p-3">
        <h3 className="mb-2 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">归档报告 · archive/report.md</h3>
        {archive.report_md ? (
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-pop-dim">{archive.report_md}</pre>
        ) : (
          <p className="text-[10.5px] text-pop-dim">报告尚未生成。</p>
        )}
      </section>
    </div>
  )
}
