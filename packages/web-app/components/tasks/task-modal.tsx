"use client"

import { useEffect, useMemo, useState, useCallback } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Plus, Trash2, Send, Ban, AlertCircle, CheckCircle2, Workflow, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import type { SchedulerJob, JobDetail, JobDetailChild } from "@/lib/scheduler-api"
import type { WorkflowConfig, TaskSpec, SubunitSpec, IntegrationGoal } from "@octopus/shared"
import { enqueueJob, abortJob, updateJob, listJobs, getJob } from "@/lib/scheduler-api"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { useRouter } from "next/navigation"
import { computeAggregateStatus } from "@/lib/composite-status"
import { CompositeDag } from "@/components/tasks/composite-dag"
import { CompositeEventsPanel, type CompositeEvent } from "@/components/tasks/composite-events-panel"
import { useCloneChatStream } from "@/lib/clone-chat"
import { CloneChatView } from "@/components/tasks/clone-chat-view"
import { ProjectSelector, type SelectedProject } from "@/components/scheduler/project-selector"
import { useOrgs } from "@/hooks/useOrgs"
import { listResources } from "@/lib/resource/api"

interface TaskModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = new-task authoring ([+新建]). A draft job opens authoring resumed on its
   *  source_chat_session_id; non-draft opens execution / done / terminal views. */
  job: SchedulerJob | null
  /** Refresh the kanban after a mutation (enqueue / abort / draft edit). */
  onMutated: () => void
  /** Page adopts a draft the task-author clone just created (new-task flow). */
  onDraftResolved?: (draft: SchedulerJob) => void
}

type ModalMode = "authoring" | "simple-execution" | "composite" | "done" | "terminal"

const TASK_AUTHOR_API = "/api/clones/task-author"

function workflowConfigOf(job: SchedulerJob | null): WorkflowConfig | null {
  if (!job || job.job_type !== "workflow") return null
  return job.config as WorkflowConfig
}

function taskSpecOf(job: SchedulerJob | null): TaskSpec | null {
  return workflowConfigOf(job)?.task_spec ?? null
}

function isComposite(job: SchedulerJob | null): boolean {
  const spec = taskSpecOf(job)
  return !!spec && Array.isArray(spec.subunits) && spec.subunits.length > 0
}

function resolveMode(job: SchedulerJob | null): ModalMode {
  if (job === null || job.status === "draft") return "authoring"
  if (job.status === "done") return isComposite(job) ? "composite" : "done"
  if (job.status === "failed" || job.status === "aborted") {
    // Composite failed/aborted parent still shows the composite view (terminal
    // children + integration). Simple tasks show the terminal view.
    return isComposite(job) ? "composite" : "terminal"
  }
  // queued / claimed / running
  return isComposite(job) ? "composite" : "simple-execution"
}

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿", queued: "待执行", claimed: "已认领", running: "执行中",
  done: "已完成", failed: "失败", aborted: "已中止",
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  queued: "bg-blue-500/15 text-blue-500",
  claimed: "bg-amber-500/15 text-amber-600",
  running: "bg-blue-500/15 text-blue-500",
  done: "bg-emerald-500/15 text-emerald-600",
  failed: "bg-red-500/15 text-red-500",
  aborted: "bg-zinc-500/15 text-zinc-500",
}

export function TaskModal({ open, onOpenChange, job, onMutated, onDraftResolved }: TaskModalProps) {
  const mode = resolveMode(job)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="sm:max-w-[92vw] w-[92vw] max-h-[90vh] h-[90vh] p-0 gap-0 flex flex-col"
        aria-describedby={undefined}
      >
        <ModalHeader job={job} mode={mode} />
        <div className="flex-1 min-h-0 overflow-hidden">
          {mode === "authoring" && (
            <AuthoringMode job={job} onMutated={onMutated} onDraftResolved={onDraftResolved} onClose={() => onOpenChange(false)} />
          )}
          {mode === "simple-execution" && job && (
            <SimpleExecutionMode job={job} onMutated={onMutated} onClose={() => onOpenChange(false)} />
          )}
          {mode === "composite" && job && (
            <CompositeMode job={job} onMutated={onMutated} onClose={() => onOpenChange(false)} />
          )}
          {mode === "done" && job && <DoneMode job={job} />}
          {mode === "terminal" && job && <TerminalMode job={job} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ModalHeader({ job, mode }: { job: SchedulerJob | null; mode: ModalMode }) {
  const title = job?.name ?? "新建任务"
  const status = job?.status ?? "draft"
  const subtitle =
    mode === "authoring"
      ? "Authoring · spec 左 / 对话 右"
      : mode === "composite"
        ? "复合任务"
        : mode === "done"
          ? "结果"
          : mode === "terminal"
            ? "终态"
            : "执行"
  return (
    <DialogHeader className="px-5 py-3 border-b border-border flex-row items-center justify-between space-y-0">
      <div className="min-w-0">
        <DialogTitle className="text-base truncate">{title}</DialogTitle>
        <DialogDescription className="text-xs">{subtitle}</DialogDescription>
      </div>
      <Badge variant="secondary" className={`shrink-0 ${STATUS_TONE[status] ?? ""}`} data-task-modal-status={status}>
        {STATUS_LABEL[status] ?? status}
      </Badge>
    </DialogHeader>
  )
}

// ── Authoring: spec LEFT / clone chat RIGHT ──────────────────────────

function AuthoringMode({
  job, onMutated, onDraftResolved, onClose,
}: {
  job: SchedulerJob | null
  onMutated: () => void
  onDraftResolved?: (draft: SchedulerJob) => void
  onClose: () => void
}) {
  const sessionId = job?.source_chat_session_id ?? null
  const chat = useCloneChatStream({
    apiBase: TASK_AUTHOR_API,
    sessionId,
    onSessionCreated: () => {},
  })

  // New-task flow: after each completed turn, look up the draft the clone created
  // (linked via source_chat_session_id) and lift it to the page so [入队] enables.
  const resolveDraft = useCallback(async (sid: string) => {
    if (!sid || job) return
    try {
      const data = await listJobs({ page: 1, limit: 100, trigger_source: "requirement" })
      const draft = data.items
        .filter((j) => j.source_chat_session_id === sid && j.status === "draft")
        .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))[0]
      if (draft) onDraftResolved?.(draft)
    } catch {
      // refetch will happen via onMutated elsewhere
    }
  }, [job, onDraftResolved])

  const handleSend = useCallback(async (content: string) => {
    const sid = await chat.sendMessage(content)
    if (sid) void resolveDraft(sid)
  }, [chat, resolveDraft])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 h-full min-h-0">
      <div className="flex flex-col min-h-0 border-r border-border overflow-y-auto">
        <SpecPanel job={job} onMutated={onMutated} />
      </div>
      <div className="flex flex-col min-h-0">
        <CloneChatView
          messages={chat.messages}
          isStreaming={chat.isStreaming}
          status={chat.status}
          onSend={handleSend}
          onAbort={chat.abort}
        />
      </div>
      <AuthoringFooter job={job} chatReady={chat.ready} onEnqueue={onMutated} onClose={onClose} />
    </div>
  )
}

function AuthoringFooter({
  job, chatReady, onEnqueue, onClose,
}: {
  job: SchedulerJob | null
  chatReady: boolean
  onEnqueue: () => Promise<void> | void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const canEnqueue = !!job && job.status === "draft"

  const handleEnqueue = async () => {
    if (!job) return
    setBusy(true)
    try {
      await enqueueJob(job.id)
      toast.success("已入队，任务进入待执行列")
      onEnqueue()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "入队失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="col-span-full flex items-center justify-end gap-2 border-t border-border px-5 py-3 bg-background">
      <span className="mr-auto text-xs text-muted-foreground">
        {job ? "确认 spec 后入队执行" : chatReady ? "先与 task-author 对话生成 spec" : "正在准备对话…"}
      </span>
      <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
      <Button size="sm" onClick={handleEnqueue} disabled={!canEnqueue || busy} data-task-enqueue>
        {busy ? <Spinner className="size-4" /> : <Send className="size-4" />}
        入队
      </Button>
    </div>
  )
}

// ── Spec panel: project/skill selectors + task_spec editor ───────────

function SpecPanel({ job, onMutated }: { job: SchedulerJob | null; onMutated: () => void }) {
  const { orgs } = useOrgs()
  const org = orgs[0]?.name ?? ""
  const wfConfig = workflowConfigOf(job)
  const seedProjects: SelectedProject[] = useMemo(
    () => (wfConfig?.workspace_spec.projects ?? []).map((p) => ({ name: p.name, source_path: p.source_path, group: p.group })),
    [wfConfig]
  )
  const [projects, setProjects] = useState<SelectedProject[]>(seedProjects)
  useEffect(() => { setProjects(seedProjects) }, [seedProjects])

  const spec = taskSpecOf(job)
  const [goal, setGoal] = useState(spec?.goal ?? "")
  const [ac, setAc] = useState<string[]>(spec?.ac ?? [""])
  const [subunits, setSubunits] = useState<SubunitSpec[]>(spec?.subunits ?? [])
  const [integration, setIntegration] = useState<IntegrationGoal>(spec?.integration_goal ?? { strategy: "synthesis" })
  const [skills, setSkills] = useState<string[]>(spec?.subunits?.flatMap((s) => s.skills) ?? [])

  useEffect(() => {
    setGoal(spec?.goal ?? "")
    setAc(spec?.ac ?? [""])
    setSubunits(spec?.subunits ?? [])
    setIntegration(spec?.integration_goal ?? { strategy: "synthesis" })
  }, [spec])

  const [saving, setSaving] = useState(false)
  const dirty = useMemo(() => {
    if (!spec) return false
    const seedProjNames = (wfConfig?.workspace_spec.projects ?? []).map((p) => p.name)
    return (
      goal !== (spec.goal ?? "")
      || ac.join("\n") !== (spec.ac ?? []).join("\n")
      || JSON.stringify(subunits) !== JSON.stringify(spec.subunits ?? [])
      || JSON.stringify(integration) !== JSON.stringify(spec.integration_goal ?? { strategy: "synthesis" })
      || JSON.stringify(projects.map((p) => p.name)) !== JSON.stringify(seedProjNames)
      || JSON.stringify(skills) !== JSON.stringify(spec.subunits?.flatMap((s) => s.skills) ?? [])
    )
  }, [goal, ac, subunits, integration, projects, skills, spec, wfConfig])

  const handleSave = async () => {
    if (!job || !wfConfig) return
    const nextSpec: TaskSpec = {
      goal: goal.trim() || spec?.goal || "未命名目标",
      ac: ac.map((s) => s.trim()).filter(Boolean),
      ...(spec?.data_model ? { data_model: spec.data_model } : {}),
      ...(spec?.contracts ? { contracts: spec.contracts } : {}),
      ...(subunits.length > 0 ? { subunits } : {}),
      integration_goal: integration,
    }
    setSaving(true)
    try {
      await updateJob(job.id, {
        config: {
          ...wfConfig,
          workspace_spec: { ...wfConfig.workspace_spec, projects },
          task_spec: nextSpec,
          ...(skills.length > 0 ? { skills } : {}),
        },
      }, job.version)
      toast.success("spec 已保存")
      onMutated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 space-y-4" data-task-spec-panel>
      <section className="space-y-2">
        <Label className="text-xs text-muted-foreground">项目 (多仓库)</Label>
        {org ? (
          <ProjectSelector org={org} value={projects} onChange={setProjects} />
        ) : (
          <p className="text-xs text-muted-foreground">未配置组织 — 请先运行 octopus setup。</p>
        )}
      </section>

      <SkillsSelector value={skills} onChange={setSkills} />

      <section className="space-y-2">
        <Label htmlFor="task-goal" className="text-xs text-muted-foreground">目标 (goal)</Label>
        <Textarea id="task-goal" value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder="任务要达成什么…" className="text-sm" />
      </section>

      <section className="space-y-2">
        <Label className="text-xs text-muted-foreground">验收标准 (AC)</Label>
        <div className="space-y-1.5">
          {ac.map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-xs text-muted-foreground mt-2 w-5 shrink-0">{i + 1}.</span>
              <Input value={item} onChange={(e) => setAc(ac.map((a, j) => j === i ? e.target.value : a))} className="h-8 text-sm" />
              <button onClick={() => setAc(ac.filter((_, j) => j !== i))} className="mt-1 text-muted-foreground hover:text-destructive" aria-label="删除验收标准">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAc([...ac, ""])}>
            <Plus className="size-3.5" /> 添加验收标准
          </Button>
        </div>
      </section>

      {subunits.length > 0 ? (
        <SubunitsEditor subunits={subunits} onChange={setSubunits} />
      ) : (
        <section className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          简单任务（单个 workspace）。若 task-author 生成多个 subunit，将在此编辑复合 spec。
        </section>
      )}

      <section className="space-y-2">
        <Label className="text-xs text-muted-foreground">整合策略 (integration_goal)</Label>
        <select
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          value={integration.strategy}
          onChange={(e) => setIntegration({ ...integration, strategy: e.target.value as "synthesis" | "merge" })}
        >
          <option value="synthesis">synthesis (moa 聚合，默认)</option>
          <option value="merge">merge (结构合并)</option>
        </select>
      </section>

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={handleSave} disabled={!job || saving || !dirty}>
          {saving ? <Spinner className="size-4" /> : null}
          保存 spec
        </Button>
      </div>
    </div>
  )
}

function SkillsSelector({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [available, setAvailable] = useState<{ name: string }[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listResources({ type: "skill", installed: true })
      .then((data) => { if (!cancelled) setAvailable(data.resources.map((r) => ({ name: r.name }))) })
      .catch(() => { if (!cancelled) setAvailable([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const toggle = (name: string) => {
    onChange(value.includes(name) ? value.filter((s) => s !== name) : [...value, name])
  }

  return (
    <section className="space-y-2">
      <Label className="text-xs text-muted-foreground">技能 (skills)</Label>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" /> 加载技能…</div>
      ) : available.length === 0 ? (
        <p className="text-xs text-muted-foreground">未安装技能。</p>
      ) : (
        <ScrollArea className="h-28 rounded border p-2">
          <div className="flex flex-col gap-1">
            {available.map((s) => (
              <label key={s.name} className="flex cursor-pointer items-center gap-2 text-xs hover:bg-accent rounded px-1 py-0.5">
                <Checkbox checked={value.includes(s.name)} onCheckedChange={() => toggle(s.name)} />
                <span className="truncate">{s.name}</span>
              </label>
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  )
}

function SubunitsEditor({ subunits, onChange }: { subunits: SubunitSpec[]; onChange: (s: SubunitSpec[]) => void }) {
  const update = (i: number, patch: Partial<SubunitSpec>) =>
    onChange(subunits.map((s, j) => j === i ? { ...s, ...patch } : s))
  return (
    <section className="space-y-2">
      <Label className="text-xs text-muted-foreground">子单元 (subunits) · 复合任务</Label>
      <div className="space-y-2">
        {subunits.map((su, i) => (
          <div key={i} className="rounded-md border border-border p-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <Input value={su.name} onChange={(e) => update(i, { name: e.target.value })} className="h-7 text-xs flex-1" placeholder="名称" />
              <button onClick={() => onChange(subunits.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive" aria-label="删除子单元">
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <Input value={su.workflow_ref} onChange={(e) => update(i, { workflow_ref: e.target.value })} className="h-7 text-xs" placeholder="workflow_ref" />
            <Input value={su.skills.join(", ")} onChange={(e) => update(i, { skills: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className="h-7 text-xs" placeholder="skills (逗号分隔)" />
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Simple execution: single-ws status + abort ──────────────────────

function SimpleExecutionMode({ job, onMutated, onClose }: { job: SchedulerJob; onMutated: () => void; onClose: () => void }) {
  const wfConfig = workflowConfigOf(job)
  const workflowRef = wfConfig?.workflow_chain?.[0]?.workflow_ref ?? "—"
  const [aborting, setAborting] = useState(false)
  const canAbort = job.status === "claimed" || job.status === "running"

  const handleAbort = async () => {
    setAborting(true)
    try {
      await abortJob(job.id)
      toast.success("已中止任务，工作区将清理")
      onMutated()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "中止失败")
    } finally {
      setAborting(false)
    }
  }

  return (
    <div className="p-5 space-y-4" data-task-simple-execution>
      <div className="rounded-lg border border-border p-4 space-y-1.5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">workflow_ref</span><code className="text-xs">{workflowRef}</code></div>
        <div className="flex justify-between"><span className="text-muted-foreground">状态</span><span>{STATUS_LABEL[job.status] ?? job.status}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">认领时间</span><span>{job.claimed_at ? new Date(job.claimed_at).toLocaleString() : "—"}</span></div>
        {job.last_execution?.error_summary ? (
          <div className="flex items-start gap-1.5 pt-1 text-red-500"><AlertCircle className="size-3.5 mt-0.5 shrink-0" /><span className="text-xs">{job.last_execution.error_summary}</span></div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        实时进度经 SSE schedule_status 推送，看板卡与状态秒级同步。完整执行流程图见执行详情。
      </p>
      <div className="flex justify-end">
        <Button variant="destructive" size="sm" onClick={handleAbort} disabled={!canAbort || aborting} data-task-abort>
          {aborting ? <Spinner className="size-4" /> : <Ban className="size-4" />}
          中止
        </Button>
      </div>
    </div>
  )
}

// ── Composite: composition DAG + N child cards + integration + SSE ──────

/** Derive the integration (moa/synthesis) node status from parent + children.
 *  The integration node is the composition workflow's final aggregator — its
 *  status tracks whether synthesis has run. Parent schedule status reflects the
 *  whole composition; children reflect the subunit fan-out. */
function integrationStatusOf(parent: string, children: JobDetailChild[]): string {
  if (parent === "done" || parent === "failed" || parent === "aborted") return parent
  const allChildrenDone = children.length > 0 && children.every((c) => c.status === "done")
  return allChildrenDone ? "running" : "pending"
}

export function CompositeMode({
  job, onMutated, onClose,
}: {
  job: SchedulerJob
  onMutated: () => void
  onClose: () => void
}) {
  const router = useRouter()
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [aborting, setAborting] = useState(false)
  const [events, setEvents] = useState<CompositeEvent[]>([])

  // Fetch the full JobDetail (children[] + dag) — the kanban row only carries
  // SchedulerJob; the composite fields come from GET /jobs/:id (ticket 10).
  const fetchDetail = useCallback(async (id: string) => {
    try {
      const data = await getJob(id)
      setDetail(data)
    } catch {
      // Non-fatal: the modal still shows the parent row from props.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchDetail(job.id)
  }, [job.id, fetchDetail])

  // Real-time SSE: subscribe to schedule_status for the parent + each child.
  // On any matching event, append to the events log and re-fetch the detail so
  // statuses refresh in real time (ticket 13 AC: SSE 实时刷新父+各子状态).
  useEffect(() => {
    if (!job.id) return
    const parentLabel = "父任务"
    const labelFor = (scheduleId: string): string => {
      if (scheduleId === job.id) return parentLabel
      const child = detail?.children?.find((c) => c.schedule_id === scheduleId)
      return child?.subunit_name ?? scheduleId.slice(0, 8)
    }
    const isRelevant = (scheduleId: string): boolean => {
      if (scheduleId === job.id) return true
      return detail?.children?.some((c) => c.schedule_id === scheduleId) ?? false
    }

    const unsub = subscribeSSE(
      `${getServerUrl()}/api/scheduler/events`,
      "schedule_status",
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as { schedule_id: string; status: string }
          if (!isRelevant(payload.schedule_id)) return
          setEvents((prev) => [
            ...prev,
            {
              schedule_id: payload.schedule_id,
              status: payload.status,
              label: labelFor(payload.schedule_id),
              at: new Date().toISOString(),
            },
          ])
          void fetchDetail(job.id)
        } catch {
          // Malformed event payload — ignore.
        }
      }
    )
    return () => unsub()
  }, [job.id, detail, fetchDetail])

  const children = detail?.children ?? []
  const dag = detail?.dag
  const parentStatus = detail?.status ?? job.status
  const aggregate = computeAggregateStatus(children, parentStatus)
  const integrationStatus = integrationStatusOf(parentStatus, children)
  const canAbort = parentStatus === "claimed" || parentStatus === "running"

  const handleChildClick = useCallback((scheduleId: string) => {
    router.push(`/scheduler/jobs/${scheduleId}`)
  }, [router])

  const handleAbort = async () => {
    setAborting(true)
    try {
      await abortJob(job.id)
      toast.success("已中止任务，工作区将清理")
      onMutated()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "中止失败")
    } finally {
      setAborting(false)
    }
  }

  if (loading && !detail) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="size-5" />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] h-full min-h-0" data-task-composite>
      {/* Left: DAG + child cards + integration + abort */}
      <div className="flex flex-col min-h-0 overflow-y-auto">
        {/* Aggregate status bar */}
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Workflow className="size-4 text-primary" />
            <span className="text-sm font-medium">聚合状态</span>
            <Badge
              variant="secondary"
              className={STATUS_TONE[aggregate] ?? ""}
              data-testid="composite-aggregate-status"
            >
              {STATUS_LABEL[aggregate] ?? aggregate}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">{children.length} 个子任务</span>
        </div>

        {/* Composition DAG */}
        {dag ? (
          <div className="px-2 py-3 border-b border-border">
            <CompositeDag
              dag={dag}
              children={children}
              integrationStatus={integrationStatus}
              onChildClick={(name) => {
                const child = children.find((c) => c.subunit_name === name)
                if (child) handleChildClick(child.schedule_id)
              }}
            />
          </div>
        ) : (
          <div className="px-4 py-6 text-xs text-muted-foreground">等待 composition DAG…</div>
        )}

        {/* Child cards */}
        <div className="p-3 space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">子任务执行</h3>
          {children.map((c) => (
            <button
              key={c.schedule_id}
              data-testid={`composite-child-${c.schedule_id}`}
              onClick={() => handleChildClick(c.schedule_id)}
              className="w-full text-left rounded-md border border-border bg-card p-2.5 hover:border-primary/40 hover:shadow-sm transition-all flex items-center gap-2"
            >
              <span className={`size-2 rounded-full shrink-0 ${STATUS_DOT_COLOR[c.status] ?? "bg-muted-foreground"}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.subunit_name}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <code className="text-[10px]">{c.workflow_ref}</code>
                  <span>·</span>
                  <span>{STATUS_LABEL[c.status] ?? c.status}</span>
                </div>
              </div>
              <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
            </button>
          ))}
          {children.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">子任务尚未派发。</p>
          )}
        </div>

        {/* Integration node status */}
        <div className="px-3 pb-3" data-testid="composite-integration">
          <div className="rounded-md border border-dashed border-primary/30 bg-primary/5 p-2.5 flex items-center gap-2">
            <span className={`size-2 rounded-full shrink-0 ${STATUS_DOT_COLOR[integrationStatus] ?? "bg-muted-foreground"}`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">整合节点</div>
              <div className="text-xs text-muted-foreground">
                {taskSpecOf(job)?.integration_goal?.strategy === "merge" ? "merge" : "synthesis (moa 聚合)"}
              </div>
            </div>
            <Badge variant="secondary" className={STATUS_TONE[integrationStatus] ?? ""}>
              {STATUS_LABEL[integrationStatus] ?? integrationStatus}
            </Badge>
          </div>
        </div>

        {/* Abort */}
        {canAbort && (
          <div className="flex justify-end px-3 pb-4">
            <Button variant="destructive" size="sm" onClick={handleAbort} disabled={aborting} data-task-abort>
              {aborting ? <Spinner className="size-4" /> : <Ban className="size-4" />}
              中止
            </Button>
          </div>
        )}
      </div>

      {/* Right: real-time SSE events panel */}
      <div className="border-l border-border min-h-0">
        <CompositeEventsPanel events={events} />
      </div>
    </div>
  )
}

const STATUS_DOT_COLOR: Record<string, string> = {
  queued: "bg-blue-500",
  claimed: "bg-amber-500",
  running: "bg-blue-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  aborted: "bg-zinc-500",
  pending: "bg-muted-foreground",
}

function DoneMode({ job }: { job: SchedulerJob }) {
  const spec = taskSpecOf(job)
  return (
    <div className="p-5 space-y-3" data-task-done>
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm space-y-1">
        <div className="flex items-center gap-2 font-medium text-emerald-600"><CheckCircle2 className="size-4" /> 任务完成</div>
        {spec ? <p className="text-xs text-muted-foreground">目标: {spec.goal}</p> : null}
        {job.last_execution?.error_summary ? (
          <p className="text-xs text-muted-foreground">{job.last_execution.error_summary}</p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">综合报告与 PR 链接在结果产物就绪后展示。</p>
    </div>
  )
}

function TerminalMode({ job }: { job: SchedulerJob }) {
  const failed = job.status === "failed"
  return (
    <div className="p-5 space-y-3" data-task-terminal>
      <div className={`rounded-lg border p-4 text-sm space-y-1 ${failed ? "border-red-500/30 bg-red-500/5" : "border-zinc-500/30 bg-zinc-500/5"}`}>
        <div className={`flex items-center gap-2 font-medium ${failed ? "text-red-500" : "text-zinc-500"}`}>
          {failed ? <AlertCircle className="size-4" /> : <Ban className="size-4" />}
          {failed ? "任务失败" : "任务已中止"}
        </div>
        {job.last_execution?.error_summary ? (
          <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{job.last_execution.error_summary}</pre>
        ) : (
          <p className="text-xs text-muted-foreground">无错误摘要。</p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{failed ? "失败为终态 (G2)，不会自动重派。可新建任务重试。" : "中止为终态，工作区已清理。"}</p>
    </div>
  )
}
