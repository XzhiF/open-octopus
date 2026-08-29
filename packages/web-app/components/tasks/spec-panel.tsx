// packages/web-app/components/tasks/spec-panel.tsx
//
// Authoring panel for the first-class `tasks` domain (v2-D1). spec LEFT /
// task-author chat RIGHT (the chat half lives in task-modal.tsx AuthoringMode).
//
// Three linked behaviors (v2-D5/D7/D12):
//   1. SSE `spec_field_update` — the task-author agent calls the
//      `update_task_spec_field` tool server-side; the server merges the field +
//      emits `spec_field_update` SSE. SpecPanel subscribes and applies the field
//      to local state LIVE + bumps its tracked version so a subsequent
//      [save draft] doesn't 409 on a stale If-Match.
//   2. [保存草稿] → PUT /api/tasks/:id with If-Match (optimistic locking). The
//      server persists + sets a transient @@spec_updated reverse-msg notice (05)
//      so the agent sees the user's override next turn.
//   3. Resource picker — two scopes: `authoring_resources` (draft-scope,
//      prompt-injected into the task-author session, v2-D8) vs `resources`
//      (workspace-scope → workflow.requires at dispatch, v2-D13/SG7). Per-subunit
//      `resources` picker in SubunitsEditor (SG13).

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type {
  Task,
  TaskSpecField,
  TaskSpec,
  SubunitSpec,
  IntegrationGoal,
  ResourceRef,
  TaskResourceType,
  SpecFieldUpdatePayload,
  ResourceEntry,
} from "@octopus/shared"
import { SPEC_FIELD_UPDATE_EVENT } from "@octopus/shared"
import { updateTask } from "@/lib/tasks-api"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { listResources } from "@/lib/resource/api"
import { ProjectSelector, type SelectedProject } from "@/components/scheduler/project-selector"
import { useOrgs } from "@/hooks/useOrgs"
// task-workflow-presets (T6): shared WorkflowBox for v2 SpecPanel
import { WorkflowBox as WorkflowBoxShared } from "./authoring/workflow-box"

// The 4 provisionable TaskResourceType values (excludes workflow + clone —
// workflow is referenced via workflow_ref, clone is manual-install only).
const PROVISIONABLE_TYPES: ReadonlySet<TaskResourceType> = new Set([
  "skill",
  "agent",
  "command",
  "rule",
])

// ── SpecPanel ────────────────────────────────────────────────────────

export interface SpecPanelProps {
  /** null = new-task flow (no draft row yet) — renders a placeholder. */
  task: Task | null
  /** Refresh the kanban + parent state after a successful save. */
  onMutated: () => void
}

export function SpecPanel({ task, onMutated }: SpecPanelProps) {
  const { orgs } = useOrgs()
  const [org, setOrg] = useState<string>(orgs[0]?.name ?? "")

  // Sync org when orgs list loads (initially empty → first org).
  useEffect(() => {
    if (orgs.length > 0 && !org) setOrg(orgs[0].name)
  }, [orgs, org])

  // ── Local spec state (seeded from task; re-synced only on task.id change) ─
  const [version, setVersion] = useState<number>(task?.version ?? 0)
  const [goal, setGoal] = useState<string>(task?.task_spec.goal ?? "")
  const [ac, setAc] = useState<string[]>(task?.task_spec.ac?.length ? task.task_spec.ac : [""])
  const [subunits, setSubunits] = useState<SubunitSpec[]>(task?.task_spec.subunits ?? [])
  const [integration, setIntegration] = useState<IntegrationGoal>(
    task?.task_spec.integration_goal ?? { strategy: "synthesis" },
  )
  const [skills, setSkills] = useState<string[]>(task?.skills ?? [])
  const [projects, setProjects] = useState<SelectedProject[]>(
    (task?.project_ids ?? []).map((name) => ({ name, source_path: "", group: "" })),
  )
  const [resources, setResources] = useState<ResourceRef[]>(task?.resources ?? [])
  const [authoringResources, setAuthoringResources] = useState<ResourceRef[]>(
    task?.authoring_resources ?? [],
  )
  // task-workflow-handoff (ADR-0013): workflow_ref state. Seeded from the task
  // row's workflow_ref column (not task_spec — it's a top-level column like
  // skills/projects). SSE spec_field_update with field="workflow_ref" updates
  // this in real time.
  const [workflowRef, setWorkflowRef] = useState<string>(task?.workflow_ref ?? "")
  const [saving, setSaving] = useState(false)

  const taskId = task?.id
  // Mirror dirty in a ref so the re-seed effect can check it without depending on dirty
  // directly (would re-run the effect on every keystroke). Assigned after dirty useMemo below.
  const dirtyRef = useRef(false)

  // Re-seed local state when a DIFFERENT task is opened (modal switch). Same
  // task's version bumps arrive via SSE below — do NOT re-seed on version change
  // or we'd clobber the user's in-progress edits + the SSE-applied fields.
  useEffect(() => {
    if (!taskId) return
    // SG8fix: don't clobber user edits — only re-seed when the panel is clean.
    // This also catches missed SSE events: the /tasks page's 10s poll returns
    // a fresh task (version bumped) → this effect re-runs → applies the fresh
    // value even if the spec_field_update SSE was missed during a Strict Mode
    // remount gap.
    if (dirtyRef.current) return
    const t = task!
    setVersion(t.version)
    setGoal(t.task_spec.goal ?? "")
    setAc(t.task_spec.ac?.length ? t.task_spec.ac : [""])
    setSubunits(t.task_spec.subunits ?? [])
    setIntegration(t.task_spec.integration_goal ?? { strategy: "synthesis" })
    setSkills(t.skills ?? [])
    setProjects((t.project_ids ?? []).map((name) => ({ name, source_path: "", group: "" })))
    setResources(t.resources ?? [])
    setAuthoringResources(t.authoring_resources ?? [])
    setWorkflowRef(t.workflow_ref ?? "")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on switch only
  }, [taskId, task?.version]) // SG8fix: re-seed on version too (catch missed SSE via poll)

  // ── SSE: spec_field_update → apply field locally + bump version (v2-D7/D12) ─
  useEffect(() => {
    if (!taskId) return
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      SPEC_FIELD_UPDATE_EVENT,
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as SpecFieldUpdatePayload
          if (payload.task_id !== taskId) return // ignore events for other tasks
          applySpecField(payload.field, payload.value)
          setVersion(payload.version)
        } catch {
          // Malformed event payload — ignore (defensive, don't crash the panel).
        }
      },
    )
    return () => unsub()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applySpecField is stable
  }, [taskId])

  function applySpecField(field: TaskSpecField, value: unknown): void {
    switch (field) {
      case "goal":
        setGoal(value as string)
        break
      case "ac":
        setAc(value as string[])
        break
      case "subunits":
        setSubunits(value as SubunitSpec[])
        break
      case "integration_goal":
        setIntegration(value as IntegrationGoal)
        break
      case "skills":
        setSkills(value as string[])
        break
      case "projects":
        setProjects(
          (value as string[]).map((name) => ({ name, source_path: "", group: "" })),
        )
        break
      case "resources":
        setResources(value as ResourceRef[])
        break
      case "authoring_resources":
        setAuthoringResources(value as ResourceRef[])
        break
      case "workflow_ref":
        // task-workflow-handoff (ADR-0013): SSE-driven live update.
        setWorkflowRef(value as string)
        break
    }
  }

  // ── dirty detection (enables [save draft]) ──────────────────────────────────
  const dirty = useMemo(() => {
    if (!task) return false
    const spec = task.task_spec
    return (
      goal !== (spec.goal ?? "") ||
      ac.join("\n") !== (spec.ac ?? []).join("\n") ||
      JSON.stringify(subunits) !== JSON.stringify(spec.subunits ?? []) ||
      JSON.stringify(integration) !== JSON.stringify(spec.integration_goal ?? { strategy: "synthesis" }) ||
      JSON.stringify(skills) !== JSON.stringify(task.skills ?? []) ||
      JSON.stringify(projects.map((p) => p.name)) !== JSON.stringify(task.project_ids ?? []) ||
      JSON.stringify(resources) !== JSON.stringify(task.resources ?? []) ||
      JSON.stringify(authoringResources) !== JSON.stringify(task.authoring_resources ?? [])
    )
  }, [task, goal, ac, subunits, integration, skills, projects, resources, authoringResources])
  dirtyRef.current = dirty  // mirror for the re-seed effect (runs each render)

  const handleSave = async (): Promise<void> => {
    if (!task) return
    setSaving(true)
    try {
      // task_spec carries the structured WHAT (goal/ac/subunits/integration).
      // resources/authoring_resources live in their OWN columns — passed as
      // top-level UpdateTaskInput fields below, NOT inside task_spec. The
      // shared TaskSpec type marks them required (zod .default[]) but the
      // server's taskSpecSchema.parse applies those defaults, so the cast is
      // honest: we send the WHAT, the server fills the resource defaults.
      const nextSpec = {
        goal: goal.trim() || task.task_spec.goal || "未命名目标",
        ac: ac.map((s) => s.trim()).filter(Boolean),
        ...(task.task_spec.data_model ? { data_model: task.task_spec.data_model } : {}),
        ...(task.task_spec.contracts ? { contracts: task.task_spec.contracts } : {}),
        ...(subunits.length > 0 ? { subunits } : {}),
        integration_goal: integration,
      } as TaskSpec
      const updated = await updateTask(
        task.id,
        {
          task_spec: nextSpec,
          skills,
          project_ids: projects.map((p) => p.name),
          resources,
          authoring_resources: authoringResources,
        },
        version,
      )
      setVersion(updated.version) // post-save version (avoids stale 409 on next save)
      toast.success("草稿已保存")
      onMutated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (!task) {
    return (
      <div className="p-4 space-y-2 text-sm text-muted-foreground" data-task-spec-panel>
        <p>先与 task-author 对话生成 spec。</p>
        <p className="text-xs">agent 会自动绑定目标 / 验收标准 / 项目 / 技能 / 子单元 / 资源；本面板经 SSE 实时刷新。</p>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4" data-task-spec-panel>
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground shrink-0">组织</Label>
          {orgs.length > 1 ? (
            <select
              className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
            >
              {orgs.map((o) => (
                <option key={o.name} value={o.name}>{o.name}</option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-muted-foreground truncate">{org || "—"}</span>
          )}
        </div>
        <Label className="text-xs text-muted-foreground">项目 (多仓库)</Label>
        {org ? (
          <ProjectSelector org={org} value={projects} onChange={setProjects} />
        ) : (
          <p className="text-xs text-muted-foreground">未配置组织 — 请先运行 octopus setup。</p>
        )}
      </section>

      <SkillsSelector value={skills} onChange={setSkills} />

      {/* task-workflow-handoff (ADR-0013): workflow_ref display + view. */}
      <WorkflowRefDisplay taskId={task?.id ?? null} workflowRef={workflowRef} />

      {/* task-workflow-presets (T6): WorkflowBox for binding dialog in v2 */}
      {task && <WorkflowBoxShared task={task} onMutated={onMutated} />}

      <section className="space-y-2">
        <Label htmlFor="task-goal" className="text-xs text-muted-foreground">目标 (goal)</Label>
        <Textarea
          id="task-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
          placeholder="任务要达成什么…"
          className="text-sm"
        />
      </section>

      <section className="space-y-2">
        <Label className="text-xs text-muted-foreground">验收标准 (AC)</Label>
        <div className="space-y-1.5">
          {ac.map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-xs text-muted-foreground mt-2 w-5 shrink-0">{i + 1}.</span>
              <Input
                value={item}
                onChange={(e) => setAc(ac.map((a, j) => (j === i ? e.target.value : a)))}
                className="h-8 text-sm"
              />
              <button
                onClick={() => setAc(ac.filter((_, j) => j !== i))}
                className="mt-1 text-muted-foreground hover:text-destructive"
                aria-label="删除验收标准"
              >
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

      <ResourcePicker scope="authoring" value={authoringResources} onChange={setAuthoringResources} />
      <ResourcePicker scope="workspace" value={resources} onChange={setResources} />

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={handleSave} disabled={!task || saving || !dirty} data-task-save>
          {saving ? <Spinner className="size-4" /> : null}
          保存草稿
        </Button>
      </div>
    </div>
  )
}

// ── SkillsSelector ───────────────────────────────────────────────────

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
                <input type="checkbox" checked={value.includes(s.name)} onChange={() => toggle(s.name)} aria-label={s.name} />
                <span className="truncate">{s.name}</span>
              </label>
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  )
}

// ── SubunitsEditor (per-subunit resources picker, SG13) ─────────────

function SubunitsEditor({ subunits, onChange }: { subunits: SubunitSpec[]; onChange: (s: SubunitSpec[]) => void }) {
  const update = (i: number, patch: Partial<SubunitSpec>) =>
    onChange(subunits.map((s, j) => (j === i ? { ...s, ...patch } : s)))
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
            <Input
              value={su.skills.join(", ")}
              onChange={(e) => update(i, { skills: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
              className="h-7 text-xs"
              placeholder="skills (逗号分隔)"
            />
            <div data-testid={`subunit-resource-picker-${i}`}>
              <ResourcePicker
                scope="workspace"
                value={su.resources ?? []}
                onChange={(next) => update(i, { resources: next })}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── ResourcePicker (authoring vs workspace two scope, SG13) ─────────

export interface ResourcePickerProps {
  /** 'authoring' = draft-scope (prompt-injected into task-author session);
   *  'workspace' = workspace-scope (→ workflow.requires at dispatch). */
  scope: "authoring" | "workspace"
  value: ResourceRef[]
  onChange: (v: ResourceRef[]) => void
}

export function ResourcePicker({ scope, value, onChange }: ResourcePickerProps) {
  const [available, setAvailable] = useState<ResourceEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // One call (no type filter) — filter to the 4 provisionable types client-side.
    listResources({ installed: true })
      .then((data) => {
        if (cancelled) return
        setAvailable(data.resources.filter((r) => PROVISIONABLE_TYPES.has(r.type as TaskResourceType)))
      })
      .catch(() => { if (!cancelled) setAvailable([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const toggle = (r: ResourceEntry): void => {
    const ref: ResourceRef = { type: r.type as TaskResourceType, name: r.name }
    const exists = value.some((v) => v.type === ref.type && v.name === ref.name)
    onChange(
      exists
        ? value.filter((v) => !(v.type === ref.type && v.name === ref.name))
        : [...value, ref],
    )
  }

  const label = scope === "authoring" ? "草稿期资源 (authoring_resources · prompt-inject)" : "工作区资源 (resources · workflow.requires)"
  const testId = `resource-picker-${scope}`

  return (
    <section className="space-y-2" data-testid={testId}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" /> 加载资源…</div>
      ) : available.length === 0 ? (
        <p className="text-xs text-muted-foreground">未安装可绑定资源。</p>
      ) : (
        <ScrollArea className="h-32 rounded border p-2">
          <div className="flex flex-col gap-1">
            {available.map((r) => {
              const checked = value.some((v) => v.type === r.type && v.name === r.name)
              return (
                <label
                  key={`${r.type}:${r.name}`}
                  className="flex cursor-pointer items-center gap-2 text-xs hover:bg-accent rounded px-1 py-0.5"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(r)}
                    aria-label={r.name}
                  />
                  <span className="truncate">{r.name}</span>
                  <span className="text-[10px] text-muted-foreground px-1 rounded bg-muted shrink-0">{r.type}</span>
                </label>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </section>
  )
}

// ── WorkflowRefDisplay (ADR-0013, S5 / US5 / AC8) ────────────────────
//
// Shows the bound workflow_ref (top-level column, not in task_spec). The value
// arrives via SSE spec_field_update in real time. Clicking "查看" fetches
// GET /api/tasks/:id/workflow-ref and renders the content + source in a
// degraded-friendly way. When no ref is bound, shows a muted hint that the
// agent will bind one during HOW-handoff.

interface WorkflowRefDisplayProps {
  taskId: string | null
  workflowRef: string
}

function WorkflowRefDisplay({ taskId, workflowRef }: WorkflowRefDisplayProps) {
  const [viewing, setViewing] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleOpen = async () => {
    if (!taskId || !workflowRef) return
    setViewing(true)
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getServerUrl()}/api/tasks/${taskId}/workflow-ref`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? `HTTP ${res.status}`)
        setLoading(false)
        return
      }
      const data = (await res.json()) as { ref: string | null; content: string | null; source: string | null }
      setContent(data.content)
      setSource(data.source)
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed")
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    setViewing(false)
    setContent(null)
    setSource(null)
    setError(null)
  }

  return (
    <section className="space-y-2" data-testid="workflow-ref-display">
      <Label className="text-xs text-muted-foreground">工作流 (workflow_ref)</Label>
      {workflowRef ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono truncate flex-1" title={workflowRef}>
            {workflowRef}
          </span>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleOpen}>
            查看
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          未绑定工作流 — task-author 在 HOW-handoff 阶段会枚举已安装工作流并推荐。
        </p>
      )}
      {viewing && (
        <div className="rounded-md border border-border p-2 space-y-2" data-testid="workflow-ref-viewer">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">来源: {source ?? "—"}</span>
            <button
              onClick={handleClose}
              className="text-[10px] text-muted-foreground hover:text-foreground"
              aria-label="关闭"
            >
              关闭
            </button>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> 加载中…
            </div>
          ) : error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : content ? (
            <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-60 rounded bg-muted p-2">
              {content}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground italic">无内容</p>
          )}
        </div>
      )}
    </section>
  )
}
