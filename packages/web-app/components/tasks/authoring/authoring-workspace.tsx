// packages/web-app/components/tasks/authoring/authoring-workspace.tsx
//
// The v3 two-phase-flow authoring page (ticket 09, US3/US6/US14/D11/D12).
// Rendered inside TaskModal when a v3 draft (task.task_spec.task_type set)
// is open. Layout (interaction ref: prototype VariantL authoring phase,
// app/tasks/prototype/page.tsx:3153 — code rewritten):
//
//   ┌─ top bar: type badge + 🔒 skill-group badges + codebase popup ──┐
//   ├─ LEFT (chat): command bar (aggregated /commands) + ChatArea      │
//   ├─ RIGHT (output viewer): GoalAcCard + enqueue checklist           │
//   └─ footer: 入队 button (disabled until confirmed; 409 → missing)   ─┘
//
// D11: the right panel is the OUTPUT VIEWER — no skill-group info there
// (the command bar above chat already exposes the groups' /commands). Skill
// groups are LOCKED post-creation (ADR-0012): the top bar shows badges only,
// no dropdown to change them.
//
// The chat half reuses the v2 AuthoringMode's useAgentChat + ChatArea +
// task-author-clone wiring (task.source_chat_session_id is the bound session).

"use client"

import { useEffect, useMemo, useState, useCallback, useRef } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Send, Settings2, Lock, Brain } from "lucide-react"
import { toast } from "sonner"
import type { Task } from "@octopus/shared"
import { SPEC_FIELD_UPDATE_EVENT } from "@octopus/shared"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { listSkillGroups, type SkillGroup } from "@/lib/skill-groups-api"
import { readyTask, updateTask, getTask, TaskReadyGateError, triggerAssistWorkflow } from "@/lib/tasks-api"
import { listBuiltInWorkflows, type BuiltInWorkflowSummary } from "@/lib/workflow-presets-api"
import { ProjectSelector, type SelectedProject } from "@/components/scheduler/project-selector"
import { useOrgs } from "@/hooks/useOrgs"
import { useAgentChat } from "@/hooks/useAgentChat"
import { ChatArea } from "@/components/agent/chat/ChatArea"
import * as agentApi from "@/lib/agent/api"
import { GoalAcCard } from "./goal-ac-card"
import { OutputViewer } from "./output-viewer"
import { WorkflowBox } from "./workflow-box"
import { MoATriggerDialog, type MoATriggerInput, type SingleExpertInput } from "./moa-trigger-dialog"

const TASK_AUTHOR_CLONE = "task-author"

export interface AuthoringWorkspaceProps {
  task: Task
  onMutated: () => void
  onClose: () => void
}

export function AuthoringWorkspace({ task, onMutated, onClose }: AuthoringWorkspaceProps) {
  const spec = task.task_spec
  const taskType = spec.task_type ?? "generic"
  const skillGroups = spec.skill_groups ?? []

  // ── P2 (review): live spec-field feedback for the v4 right panel ────
  // V3 analogy: GoalAcCard subscribes spec_field_update to apply goal/ac in
  // place. v4 hides GoalAcCard, so phases/autoAdvance/workflow_ref writes
  // (agent-driven: 拆分确认、per-phase 绑定、传播改写) had NO subscriber —
  // PhaseBindingList/入队清单 stayed stale until modal reopen (the exact
  // "不推送" bug class this redesign set out to kill). Refetch via the
  // parent's onMutated (single truth = fresh task DTO, no local patching).
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      SPEC_FIELD_UPDATE_EVENT,
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as { task_id?: string; field?: string }
          if (payload.task_id !== task.id) return
          if (
            payload.field === "phases" ||
            payload.field === "auto_advance" ||
            payload.field === "workflow_ref"
          ) {
            onMutated()
          }
        } catch {
          // Malformed event payload — ignore (defensive).
        }
      },
    )
    return () => unsub()
  }, [task.id, onMutated])

  // ── Resizable panels: drag the divider to adjust chat ↔ output width ──
  // Default split: 60% chat (left) / 40% output (right).
  const containerRef = useRef<HTMLDivElement>(null)
  const [rightWidth, setRightWidth] = useState(0)
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // Measure container on mount and set initial 40% width.
  useEffect(() => {
    if (containerRef.current && rightWidth === 0) {
      setRightWidth(Math.round(containerRef.current.clientWidth * 0.4))
    }
  }, [rightWidth])

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    startXRef.current = e.clientX
    startWidthRef.current = rightWidth
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      // Dragging left → wider right panel (delta negative → right grows)
      const delta = startXRef.current - ev.clientX
      const container = containerRef.current
      const maxW = container ? container.clientWidth * 0.6 : 700
      setRightWidth(Math.min(maxW, Math.max(240, startWidthRef.current + delta)))
    }
    const onMouseUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }, [rightWidth])

  // ── Skill-group commands (AC7): fetch once, filter to locked groups ──
  const [allGroups, setAllGroups] = useState<SkillGroup[]>([])
  useEffect(() => {
    let cancelled = false
    listSkillGroups()
      .then((data) => { if (!cancelled) setAllGroups(data.groups) })
      .catch(() => { if (!cancelled) setAllGroups([]) })
    return () => { cancelled = true }
  }, [])

  // Aggregated slash commands for the `/` autocomplete in the chat input —
  // scoped to the task's LOCKED skill groups (bugfix 2026-08-26). Previously
  // this aggregated every installed skill from /api/skill-groups regardless
  // of the selection: creating a coding task with only mattpocock-skills then
  // seeing "101 技能可用" + /superpowers commands in the chat was a display
  // mismatch. The actual loadable set is the task-home materialization (plugin
  // #3, only the locked groups) + platform built-ins via plugin #1 — the old
  // comment's "clone has all shared skills" assumption only covered plugin #1's
  // octo-* built-ins, not the whole global registry. The UI now advertises /
  // autocompletes only what the selection implies.
  // "default" group (D17) is an empty marker → contributes nothing.
  const lockedGroupNames = useMemo(() => new Set(skillGroups), [skillGroups])
  const commandGroups = useMemo(
    () => allGroups.filter((g) => lockedGroupNames.has(g.group)),
    [allGroups, lockedGroupNames],
  )
  const commands = useMemo(() => {
    const out: Array<{ name: string; description?: string }> = []
    for (const g of commandGroups) {
      for (const s of g.skills) out.push({ name: s.name, description: s.description })
    }
    return out
  }, [commandGroups])

  // ── Chat (reuses the v2 AuthoringMode wiring) ──────────────────────
  const initialSessionId = task.source_chat_session_id ?? null
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId)
  useEffect(() => {
    if (task.source_chat_session_id && task.source_chat_session_id !== activeSessionId) {
      setActiveSessionId(task.source_chat_session_id)
    }
  }, [task.source_chat_session_id, activeSessionId])

  // ── Model selection (pro-max / pro / se, default pro) ──
  const [model, setModel] = useState('pro')
  const modelRef = useRef(model)
  modelRef.current = model

  const apiOverrides = useMemo(() => ({
    getSession: (id: string, q?: { limit?: number; cursor?: string }) =>
      agentApi.getCloneSession(TASK_AUTHOR_CLONE, id, q),
    chatStream: (id: string, msg: string, opts?: { model?: string; subagents?: Array<{ id: string; label?: string }> }) =>
      agentApi.cloneChatStream(TASK_AUTHOR_CLONE, id, msg, {
        model: opts?.model ?? modelRef.current,
        subagents: opts?.subagents,
      }),
    stopChat: (id: string) =>
      agentApi.stopCloneChat(TASK_AUTHOR_CLONE, id),
  }), [])
  const chat = useAgentChat(activeSessionId, { api: apiOverrides })
  const loadedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!activeSessionId) return
    if (loadedRef.current.has(activeSessionId)) return
    loadedRef.current.add(activeSessionId)
    chat.loadMessages()
  }, [activeSessionId, chat])

  // Lazy session (bugfix 2026-08-19): pre-v3 legacy drafts open here too but
  // may lack source_chat_session_id (e.g. actuator-era rows). Mirror v2
  // AuthoringMode: buffer the first message, create the task-author session,
  // send once the session id lands. v3 drafts always have a session (D15
  // session-first create) so this path is legacy-only.
  const pendingMessageRef = useRef<{ message: string; opts?: { subagents?: Array<{ id: string; label?: string }> } } | null>(null)
  const createSession = useCallback(async (): Promise<string | null> => {
    try {
      const session = await agentApi.createCloneSession(TASK_AUTHOR_CLONE)
      setActiveSessionId(session.id)
      return session.id
    } catch {
      toast.error("创建会话失败")
      return null
    }
  }, [])

  const handleSend = useCallback((message: string) => {
    if (activeSessionId) {
      chat.sendMessage(message)
    } else {
      pendingMessageRef.current = { message }
      void createSession()
    }
  }, [activeSessionId, chat, createSession])

  // ── Single-expert consultation (v1): compose + send the consult message to
  // the task-author session, registering the expert as an SDK subagent for this
  // turn (the server resolves body.subagents → agents option). No workflow run.
  const handleSingleConsult = useCallback((input: SingleExpertInput) => {
    if (chat.streaming) {
      toast.error("请等待当前回复完成后再咨询")
      return
    }
    const subagents = [{ id: input.role.id, label: input.role.label }]
    if (activeSessionId) {
      chat.sendMessage(input.composedPrompt, { subagents })
    } else {
      pendingMessageRef.current = { message: input.composedPrompt, opts: { subagents } }
      void createSession()
    }
    // The message is enqueued (or buffered for a lazy session) — the consultation
    // starts in the chat. Close the dialog so the user watches it work (bugfix
    // 2026-08-21: previously the window stayed open after 开始咨询).
    setMoaOpen(false)
  }, [activeSessionId, chat, createSession])

  useEffect(() => {
    if (activeSessionId && pendingMessageRef.current) {
      const pending = pendingMessageRef.current
      pendingMessageRef.current = null
      requestAnimationFrame(() => {
        chat.sendMessage(pending.message, pending.opts)
      })
    }
  }, [activeSessionId, chat])

  // AC7: command-bar click sends the slash-command straight to the agent
  // (ChatArea owns its input internally, so seeding isn't an option without
  // modifying a shared component; sending the command directly is the v1
  // behavior — the user can add context in a follow-up turn).

  // ── Preset popup (AC3/US14: org + projects ONLY, no skills) ─────────
  const { orgs } = useOrgs()
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetOrg, setPresetOrg] = useState<string>(task.org || orgs[0]?.name || "")
  const [presetProjects, setPresetProjects] = useState<SelectedProject[]>(
    (task.project_ids ?? []).map((name) => ({ name, source_path: "", group: "" })),
  )
  useEffect(() => {
    if (orgs.length > 0 && !presetOrg) setPresetOrg(orgs[0].name)
  }, [orgs, presetOrg])

  // Preset save: persist project selection to task.project_ids via updateTask.
  // The selection is "locked" once saved (matches the dialog hint: "预设创建后
  // 随任务锁定"). When task.project_ids is non-empty the dialog becomes
  // effectively read-only (save button hidden).
  const [presetSaveBusy, setPresetSaveBusy] = useState(false)
  const presetLocked = (task.project_ids ?? []).length > 0
  const presetDirty = useMemo(() => {
    if (presetLocked) return false
    const saved = (task.project_ids ?? []).sort()
    const current = presetProjects.map((p) => p.name).sort()
    return JSON.stringify(saved) !== JSON.stringify(current)
  }, [task.project_ids, presetProjects, presetLocked])
  const handleSavePreset = useCallback(async () => {
    setPresetSaveBusy(true)
    try {
      await updateTask(task.id, {
        project_ids: presetProjects.map((p) => p.name),
      }, task.version)
      onMutated()
      setPresetOpen(false)
    } catch (err) {
      toast.error(`保存项目失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPresetSaveBusy(false)
    }
  }, [task.id, task.version, presetProjects, onMutated])

  // ── Enqueue gate (AC6/D18): derive from server-side task_spec truth ─
  // task-phase-redesign 票 12 (K13): v4 = format flag 三处分叉之一（gate/物化/UI）。
  // v4 任务的 gate 完全换轨：goal/ac/双确认退役，改判「phases 完备 ∧ 逐 phase
  // spec ∧ 逐 phase 绑定 ∧ inputs 齐」四行（server gateV4Phases 同源，票 04）。
  const isV4 = spec.format === "v4"
  const goalConfirmed = !!spec.goal_confirmed
  const acConfirmed = spec.ac_confirmed ?? []
  const acItems = spec.ac ?? []
  const allAcConfirmed = acItems.length > 0 && acItems.every((a) => acConfirmed.includes(a))
  const goalFilled = !!spec.goal && spec.goal.trim().length > 0
  const acFilled = acItems.length >= 1

  // 前端预检与 server gate 同源（消灭「点了才 409」断链）：
  //   ① phases≥1；② 每 phase specPath 非空；③ 每 phase workflowRef 非空；
  //   ④ required inputs 被非空值或 ${...} 占位符覆盖（用 built-in 目录的
  //     inputs 定义镜像 gateV4Phases ③；目录未加载/未知 ref（task-home 工作流）
  //     时该行不阻塞 — server 端解析是最终权威）。
  // 409 missing（`phase:<i>:<why>` 格式）反解后逐行标 ✗ + 人话提示。
  const [catalog, setCatalog] = useState<BuiltInWorkflowSummary[]>([])
  useEffect(() => {
    if (!isV4) return
    let cancelled = false
    listBuiltInWorkflows()
      .then((list) => { if (!cancelled) setCatalog(list) })
      .catch(() => { if (!cancelled) setCatalog([]) })
    return () => { cancelled = true }
  }, [isV4])

  const v4Phases = spec.phases ?? []
  const v4Rows = useMemo(() => {
    const phases = v4Phases
    const rowPhases = phases.length >= 1
    const rowSpec = phases.length >= 1 && phases.every((p) => (p.specPath ?? "").trim().length > 0)
    const rowBind = phases.length >= 1 && phases.every((p) => (p.workflowRef ?? "").trim().length > 0)
    let inputsUnknown = false
    const rowInputs = phases.length >= 1 && phases.every((p) => {
      const def = catalog.find((w) => w.ref === p.workflowRef)
      if (!def) { if (p.workflowRef) inputsUnknown = true; return true } // 未知 ref = task-home 工作流，server 权威
      const required = Object.entries(def.inputs ?? {}).filter(([, d]) => d.required).map(([k]) => k)
      return required.every((k) => {
        const v = (p.inputValues?.[k] ?? "").trim()
        return v.length > 0 || v.includes("${")
      })
    })
    return { rowPhases, rowSpec, rowBind, rowInputs, inputsUnknown }
  }, [v4Phases, catalog])

  const canEnqueue = isV4
    ? v4Rows.rowPhases && v4Rows.rowSpec && v4Rows.rowBind && v4Rows.rowInputs
    : goalFilled && acFilled && goalConfirmed && allAcConfirmed

  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [gateMissing, setGateMissing] = useState<string[] | null>(null)

  // v4 gate 409 missing 反解（票 04 契约 `phase:<i>:<why>`：no-phases /
  // spec-missing / workflow-ref / input:<key>）→ 回填四行清单 ✗ + 人话。
  const gateHits = useMemo<Record<"phases" | "spec" | "bind" | "inputs", string[]>>(() => {
    const hits: Record<"phases" | "spec" | "bind" | "inputs", string[]> = { phases: [], spec: [], bind: [], inputs: [] }
    for (const key of gateMissing ?? []) {
      const m = /^phase:(\d+):(.+)$/.exec(key)
      if (!m) { hits.phases.push(key); continue }
      const i = Number(m[1])
      const why = m[2]
      if (why === "no-phases") hits.phases.push("phases 列表为空")
      else if (why === "spec-missing") hits.spec.push(`Phase ${i}：批次目录中 spec 文件缺失`)
      else if (why === "workflow-ref") hits.bind.push(`Phase ${i}：工作流引用无法解析`)
      else if (why.startsWith("input:")) hits.inputs.push(`Phase ${i}：必填输入 ${why.slice("input:".length)} 未填（或占位符解析为空）`)
      else hits.phases.push(key)
    }
    return hits
  }, [gateMissing])

  // AC5 (K6/US11): autoAdvance 开关 — 编辑只在 draft 合法（PUT/spec-field 的
  // 服务端 guard = draft/ready），故落草稿面板；验收弹窗只显只读态。
  // 乐观本地态：click 即时翻转（否则 PUT 往返 + 轮询换 prop 前 checkbox
  // 纹丝不动 — playwright uncheck / 用户感知都判定「切不动」）；失败回滚。
  const [autoLocal, setAutoLocal] = useState<boolean | null>(null)
  useEffect(() => {
    setAutoLocal(null) // 任务行刷新（version bump / 切换任务）→ 回到服务端事实
  }, [task.id, task.version])
  const autoOn = autoLocal ?? (spec.autoAdvance !== false)
  const [autoBusy, setAutoBusy] = useState(false)
  const handleToggleAutoAdvance = async () => {
    if (autoBusy) return
    const next = !autoOn
    setAutoBusy(true)
    setAutoLocal(next)
    try {
      // S5 同款纪律：写回前重取 version。
      const fresh = await getTask(task.id)
      await updateTask(task.id, { task_spec: { ...fresh.task_spec, autoAdvance: next } }, fresh.version)
      toast.success(next ? "已开 — 验收通过后下一 Phase 自动开跑" : "已关 — 每个 Phase 都停在你的 gate（看板「启动下一 Phase」）")
      onMutated()
    } catch (err: unknown) {
      setAutoLocal(null) // 回滚到服务端事实
      toast.error(err instanceof Error ? err.message : "autoAdvance 切换失败")
    } finally {
      setAutoBusy(false)
    }
  }

  // ── Assist-workflow runs (US9/AC4): tracked run ids → OutputViewer fetches ─
  // The command-bar MoA button triggers the built-in moa-requirements-review
  // template (primary; the agent's suggestion bubble is LLM-driven → manual
  // verification). The run executes in the background (D16 temp workspace);
  // progress + completion arrive via assist_run_update SSE (D19) inside the
  // OutputViewer. Reset on task switch so a different task's runs aren't shown.
  const [runIds, setRunIds] = useState<string[]>([])
  const [moaOpen, setMoaOpen] = useState(false)
  const [moaRunning, setMoaRunning] = useState(false)
  useEffect(() => {
    setRunIds([])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on task switch
  }, [task.id])

  const handleTriggerMoa = async (input: MoATriggerInput) => {
    setMoaRunning(true)
    try {
      const result = await triggerAssistWorkflow(task.id, "dynamic-moa-analysis", {
        goal: input.goal || undefined,
        ac: input.ac.length > 0 ? input.ac : undefined,
        projects: input.projects.length > 0 ? input.projects : undefined,
        userInput: input.userInput || undefined,
        mode: input.mode,
        experts: input.experts,
        aggregator: input.aggregator,
        rounds: input.rounds,
      })
      setRunIds((prev) => (prev.includes(result.run_id) ? prev : [...prev, result.run_id]))
      const modeLabel = input.mode === "moa" ? "MoA 分析" : "Debate 辩论"
      toast.message(`${modeLabel}已启动`, { description: `完成后结果将保存为产物文件` })
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "触发分析失败")
    } finally {
      setMoaRunning(false)
      setMoaOpen(false)
    }
  }

  const handleEnqueue = async () => {
    if (!canEnqueue || enqueueBusy) return
    setEnqueueBusy(true)
    setGateMissing(null)
    try {
      await readyTask(task.id)
      toast.success("已入队，任务进入待执行列")
      onMutated()
      onClose()
    } catch (err: unknown) {
      if (err instanceof TaskReadyGateError) {
        // AC6: server-side gate backstop — show exactly what's missing.
        setGateMissing(err.missing)
        toast.error(`入队被拒：缺少 ${err.missing.join(", ")}`)
      } else {
        toast.error(err instanceof Error ? err.message : "入队失败")
      }
    } finally {
      setEnqueueBusy(false)
    }
  }

  const typeBadge = taskType === "coding" ? "🛠 开发任务" : "📄 通用任务"

  return (
    <div ref={containerRef} className="flex flex-col h-full min-h-0" data-authoring-workspace>
      {/* ── top bar (AC3) ── */}
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className="text-[10px]" data-task-type-badge>{typeBadge}</Badge>
        {skillGroups.map((g) => (
          <Badge key={g} variant="outline" className="text-[10px]" data-skill-group-badge={g}>
            <Lock className="size-2.5 mr-0.5" aria-label="锁定" /> {g}
          </Badge>
        ))}
        {taskType === "coding" && (
          <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => setPresetOpen(true)} data-preset-button>
            <Settings2 className="size-3 mr-1" /> codebase · {presetOrg} · {presetProjects.length} 项目
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">右侧 = 产出 · 有问题对话里让 agent 改</span>
          <Button
            size="sm"
            className="h-6 text-[10px]"
            onClick={handleEnqueue}
            disabled={!canEnqueue || enqueueBusy}
            data-task-enqueue data-testid="task-enqueue"
          >
            {enqueueBusy ? <Spinner className="size-3" /> : <Send className="size-3 mr-0.5" />}
            入队执行
          </Button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ── LEFT: chat (AC7 command bar above it) ── */}
        {/* min-w-0 (bugfix 2026-08-19): the command bar's shrink-0 chips give
            this column a huge min-content width; without min-w-0 the flex item
            refuses to shrink below it, blowing the row past the dialog and
            pushing the right output-viewer panel off-screen (user-visible:
            "明细右边内容溢出"). min-w-0 lets flex-basis:0 win so the command
            bar scrolls internally (overflow-x-auto) instead. */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 border-r border-border">
          {/* Assist-trigger bar (MoA). Skill commands moved to the chat input's
              `/` slash-autocomplete — no more command-bar chips that auto-send. */}
          <div className="px-3 py-1.5 border-b bg-background flex items-center gap-2" data-command-bar>
            {commands.length > 0 && (
              <span className="text-[10px] text-muted-foreground">输入 / 调用技能（{commands.length} 个可用）</span>
            )}
            {commands.length === 0 && (
              <span className="text-[10px] text-muted-foreground">无额外命令（仅内置 spec-field 流程）</span>
            )}
            <div className="ml-auto">
              <button
                onClick={() => setMoaOpen(true)}
                className="shrink-0 px-2 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-600 hover:bg-purple-500/20 transition-colors flex items-center gap-1"
                data-assist-trigger="moa-requirements-review"
                title="运行专家咨询辅助工作流（MoA / Debate / 单专家）"
              >
                <Brain className="size-3" /> 专家咨询
              </button>
              <MoATriggerDialog
                task={task}
                open={moaOpen}
                onOpenChange={setMoaOpen}
                onTrigger={handleTriggerMoa}
                onConsultSingle={handleSingleConsult}
                running={moaRunning}
              />
            </div>
          </div>

          {/* flex flex-col (bugfix 2026-08-19): ChatArea's root is `flex-1`,
              which only constrains its height inside a flex parent — without
              it the message list grows unbounded and never scrolls ("chat
              内容多了不能上下拖动"). v2 AuthoringMode had the flex parent. */}
          <div className="flex-1 min-h-0 flex flex-col">
            <ChatArea
              messages={chat.messages}
              streaming={chat.streaming}
              streamContent={chat.streamContent}
              streamThinking={chat.streamThinking}
              streamTimeline={chat.streamTimeline}
              isThinking={chat.isThinking}
              toolCalls={chat.toolCalls}
              pendingConfirm={chat.pendingConfirm}
              error={chat.error}
              statusMessage={chat.statusMessage}
              onSend={handleSend}
              onStop={chat.stopGenerate}
              onConfirm={chat.handleConfirm}
              hasSession={!!activeSessionId}
              currentCloneName={TASK_AUTHOR_CLONE}
              hideEmptyState
              commands={commands}
              contextUsage={chat.contextUsage}
              currentModel={model}
              onModelChange={setModel}
            />
          </div>
        </div>

        {/* ── Draggable divider ── */}
        <div
          onMouseDown={onDividerMouseDown}
          className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 active:bg-primary transition-colors"
          title="拖拽调整宽度"
        />

        {/* ── RIGHT: output viewer (D11 — no skill-group info here) ── */}
        <div style={{ width: rightWidth }} className="shrink-0 flex flex-col min-h-0 bg-muted/20 overflow-y-auto p-3 space-y-3" data-output-viewer>
          {/* K13: goal/ac 卡 v4 退役（task_spec 顶层 goal/ac 不再是 v4 gate 项），v3 保留 */}
          {!isV4 && <GoalAcCard task={task} onMutated={onMutated} />}

          <WorkflowBox task={task} onMutated={onMutated} />

          <OutputViewer task={task} runIds={runIds} onAdopted={onMutated} />

          {/* enqueue checklist — v4 = 四行 phase 契约（server gateV4Phases 同源）；
              v3 = goal/ac/workflow 现状。状态只显；按钮在顶栏。 */}
          {isV4 ? (
            <div className="shrink-0 rounded-lg border bg-background px-3 py-2.5 space-y-1" data-enqueue-checklist data-testid="enqueue-checklist-v4">
              <div className="text-[11px] font-medium mb-0.5">入队清单（v4 phase 契约）</div>
              {(
                [
                  { id: "phases", ok: v4Rows.rowPhases, hits: gateHits.phases, label: `phases 完备 ×${v4Phases.length}` },
                  { id: "spec", ok: v4Rows.rowSpec, hits: gateHits.spec, label: "逐 phase spec（批次目录 spec.md）" },
                  { id: "bind", ok: v4Rows.rowBind, hits: gateHits.bind, label: "逐 phase 绑定 workflow" },
                  { id: "inputs", ok: v4Rows.rowInputs, hits: gateHits.inputs, label: "inputs 齐（必填项非空/占位符）" },
                ] as const
              ).map((row) => {
                const failed = row.hits.length > 0
                const good = row.ok && !failed
                return (
                  <div key={row.id} className="text-[11px]" data-checklist-v4={row.id} data-testid={`checklist-v4-${row.id}`}>
                    <span className={good ? "text-emerald-600" : failed ? "text-red-500" : "text-amber-500"}>
                      {good ? "✅" : failed ? "✗" : "⏳"}
                    </span>{" "}
                    {row.label}
                    {failed && (
                      <ul className="ml-4 list-disc text-[10px] text-red-500">
                        {row.hits.map((h) => <li key={h}>{h}</li>)}
                      </ul>
                    )}
                  </div>
                )
              })}
              {v4Rows.inputsUnknown && (
                <p className="text-[10px] text-muted-foreground">
                  存在非内置 workflow —— inputs 解析以服务端入队门禁为最终权威。
                </p>
              )}
              <div className="pt-1 mt-1 border-t flex items-center gap-2 text-[11px]" data-autoadvance-row>
                <label className="flex items-center gap-1.5 cursor-pointer select-none" data-autoadvance-toggle-label>
                  <input
                    type="checkbox"
                    checked={autoOn}
                    onChange={() => void handleToggleAutoAdvance()}
                    data-autoadvance-switch data-testid="autoadvance-switch"
                  />
                  验收通过后自动开跑下一 Phase（auto_advance）
                </label>
                {autoBusy && <Spinner className="size-3" />}
              </div>
              {!canEnqueue ? (
                <p className="text-[10px] text-muted-foreground">四行未齐不可入队 —— 对话里让 agent 补，或在绑定卡逐 phase 配置。</p>
              ) : null}
            </div>
          ) : (
            <div className="shrink-0 rounded-lg border bg-background px-3 py-2.5" data-enqueue-checklist>
              <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-[11px]">
                <span className="flex items-center gap-1">
                  <span className={goalConfirmed ? "text-emerald-600" : "text-amber-500"}>
                    {goalConfirmed ? "✅" : "⏳"}
                  </span> goal
                </span>
                <span className="flex items-center gap-1">
                  <span className={allAcConfirmed ? "text-emerald-600" : "text-amber-500"}>
                    {allAcConfirmed ? "✅" : "⏳"}
                  </span> ac ×{acItems.length}
                </span>
                {/* task-workflow-presets (T6): workflow_ref status line */}
                <span className="flex items-center gap-1" data-checklist-workflow>
                  <span className={!!task.workflow_ref ? "text-emerald-600" : "text-amber-500"}>
                    {!!task.workflow_ref ? "✅" : "⏳"}
                  </span> workflow
                </span>
              </div>
              {gateMissing && gateMissing.length > 0 ? (
                <div className="mt-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[10px] text-red-600" data-gate-missing>
                  服务端门禁缺失：{gateMissing.join(", ")}
                </div>
              ) : null}
              {!canEnqueue ? (
                <p className="mt-1.5 text-[10px] text-muted-foreground">请先确认 goal + 全部 ac（顶部「入队执行」按钮）</p>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* ── preset popup (AC3/US14: org + projects only, NO skills) ── */}
      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-base">⚙️ codebase</DialogTitle>
            <DialogDescription className="text-xs">
              预设只有组织 + 项目两项。执行技能由 workflow.requires 负责。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <div>
              <div className="text-muted-foreground mb-1">组织</div>
              {orgs.length > 1 && !presetLocked ? (
                <select
                  className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
                  value={presetOrg}
                  onChange={(e) => { setPresetOrg(e.target.value); setPresetProjects([]) }}
                >
                  {orgs.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                </select>
              ) : (
                <div className="text-muted-foreground">{presetOrg || "—"}{presetLocked && " 🔒"}</div>
              )}
            </div>
            <div>
              <div className="text-muted-foreground mb-1">项目（多选）{presetLocked && "🔒"}</div>
              {presetOrg ? (
                <ProjectSelector org={presetOrg} value={presetProjects} onChange={presetLocked ? () => {} : setPresetProjects} />
              ) : (
                <p className="text-muted-foreground">未配置组织</p>
              )}
            </div>
            <div className="rounded-md border border-dashed p-2 text-[10px] text-muted-foreground">
              {presetLocked
                ? "语境已锁定。换语境 = 新建任务。"
                : "选择项目后保存以锁定。保存后不可更改。"}
            </div>
            {!presetLocked && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!presetDirty || presetSaveBusy}
                  onClick={() => { void handleSavePreset() }}
                >
                  {presetSaveBusy ? <Spinner className="size-3 mr-1" /> : null}
                  {presetSaveBusy ? "保存中…" : "保存并锁定"}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  )
}
