"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { RefreshCw, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { listJobs, type SchedulerJob } from "@/lib/scheduler-api"
import { groupJobsByStatus, TASK_POOL_COLUMNS } from "@/lib/task-pool"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { TaskModal } from "@/components/tasks/task-modal"

const REFRESH_INTERVAL_MS = 10_000
const FETCH_LIMIT = 100

export default function TasksPage() {
  const [jobs, setJobs] = useState<SchedulerJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // null job = new-task authoring ([+新建]); a SchedulerJob = card click.
  const [modalJob, setModalJob] = useState<SchedulerJob | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const fetchJobs = useCallback(async () => {
    try {
      // T-10 server default filters trigger_source='cron'; /tasks needs requirement-type only.
      const data = await listJobs({ page: 1, limit: FETCH_LIMIT, trigger_source: "requirement" })
      setJobs(data.items)
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load tasks")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchJobs()
    const id = setInterval(fetchJobs, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchJobs])

  // Real-time push: SSE schedule_status fires on every lifecycle transition
  // (queued/claimed/rollback/abort/failed/done, G5) — refresh the kanban.
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/scheduler/events`,
      "schedule_status",
      () => fetchJobs(),
    )
    return () => unsub()
  }, [fetchJobs])

  // Keep the open modal's job in sync with the latest fetched row (version/status).
  const jobsRef = useRef<SchedulerJob[]>(jobs)
  useEffect(() => { jobsRef.current = jobs }, [jobs])
  useEffect(() => {
    if (!modalOpen || !modalJob) return
    const fresh = jobsRef.current.find((j) => j.id === modalJob.id)
    if (fresh && fresh !== modalJob) setModalJob(fresh)
  }, [jobs, modalOpen, modalJob])

  const openNew = () => { setModalJob(null); setModalOpen(true) }
  const openCard = (job: SchedulerJob) => { setModalJob(job); setModalOpen(true) }
  const close = () => { setModalOpen(false); setModalJob(null) }

  // New-task flow: the task-author clone creates a draft (linked via
  // source_chat_session_id); adopt it so [入队] enables without closing the modal.
  const handleDraftResolved = useCallback((draft: SchedulerJob) => {
    setModalJob(draft)
    void fetchJobs()
  }, [fetchJobs])

  const grouped = groupJobsByStatus(jobs)

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex flex-col h-full min-w-0">
        <header className="flex items-center gap-3 px-6 py-4 border-b border-border">
          <h1 className="text-2xl font-bold tracking-tight">任务池</h1>
          <span className="text-sm text-muted-foreground">{jobs.length} 个任务</span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchJobs} disabled={loading}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Button size="sm" onClick={openNew} data-task-new>
              <Plus className="size-4" />
              新建任务
            </Button>
          </div>
        </header>

        {error ? (
          <div className="flex-1 flex items-center justify-center text-destructive text-sm">
            {error}
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-4">
            <div className="flex gap-3 min-h-full" style={{ minWidth: "max-content" }}>
              {TASK_POOL_COLUMNS.map((col) => (
                <section
                  key={col.id}
                  data-task-column={col.id}
                  aria-label={col.label}
                  className="flex flex-col gap-2 w-[220px] shrink-0 rounded-md bg-muted/30"
                >
                  <header className="flex items-center justify-between px-3 py-2 border-b border-border">
                    <h2 className="text-sm font-semibold">{col.label}</h2>
                    <span className="text-xs text-muted-foreground">{grouped[col.id].length}</span>
                  </header>
                  <div className="flex flex-col gap-2 flex-1 p-2 overflow-auto">
                    {grouped[col.id].map((job) => (
                      <TaskCard key={job.id} job={job} onClick={() => openCard(job)} />
                    ))}
                    {grouped[col.id].length === 0 && (
                      <div
                        data-empty-column={col.id}
                        className="text-xs text-muted-foreground text-center py-6 border border-dashed rounded-md"
                      >
                        空
                      </div>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>

      <TaskModal
        open={modalOpen}
        onOpenChange={(o) => { if (!o) close(); else setModalOpen(true) }}
        job={modalJob}
        onMutated={fetchJobs}
        onDraftResolved={handleDraftResolved}
      />
    </div>
  )
}

interface TaskCardProps {
  job: SchedulerJob
  onClick: () => void
}

function TaskCard({ job, onClick }: TaskCardProps) {
  const composite = !!job.config &&
    job.job_type === "workflow" &&
    (job.config as { task_spec?: { subunits?: unknown[] } }).task_spec?.subunits?.length
  return (
    <article
      data-task-card
      data-task-status={job.status}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick() } }}
      className="rounded-md border border-border bg-card p-3 text-sm shadow-sm cursor-pointer hover:border-primary/40 hover:shadow transition-all"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium truncate">{job.name}</h3>
        {composite ? <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary shrink-0">复合</span> : null}
      </div>
      <dl className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <dt>状态</dt>
          <dd data-task-card-status>{job.status}</dd>
        </div>
        <div className="flex justify-between">
          <dt>创建</dt>
          <dd>{new Date(job.created_at).toLocaleString()}</dd>
        </div>
      </dl>
    </article>
  )
}
