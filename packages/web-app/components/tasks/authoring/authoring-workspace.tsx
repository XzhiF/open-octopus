// packages/web-app/components/tasks/authoring/authoring-workspace.tsx
//
// The v3 two-phase-flow authoring page (ticket 09, US3/US6/US14/D11/D12).
// Rendered inside TaskModal when a v3 draft (task.task_spec.task_type set)
// is open. Layout (interaction ref: prototype VariantL authoring phase,
// app/tasks/prototype/page.tsx:3153 — code rewritten):
//
//   ┌─ top bar: type badge + 🔒 skill-group badges + 编写语境 popup ──┐
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
import { Send, Settings2, Lock } from "lucide-react"
import { toast } from "sonner"
import type { Task } from "@octopus/shared"
import { listSkillGroups, type SkillGroup } from "@/lib/skill-groups-api"
import { readyTask, TaskReadyGateError } from "@/lib/tasks-api"
import { ProjectSelector, type SelectedProject } from "@/components/scheduler/project-selector"
import { useOrgs } from "@/hooks/useOrgs"
import { useAgentChat } from "@/hooks/useAgentChat"
import { ChatArea } from "@/components/agent/chat/ChatArea"
import * as agentApi from "@/lib/agent/api"
import { GoalAcCard } from "./goal-ac-card"

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

  // ── Skill-group commands (AC7): fetch once, filter to locked groups ──
  const [allGroups, setAllGroups] = useState<SkillGroup[]>([])
  useEffect(() => {
    let cancelled = false
    listSkillGroups()
      .then((data) => { if (!cancelled) setAllGroups(data.groups) })
      .catch(() => { if (!cancelled) setAllGroups([]) })
    return () => { cancelled = true }
  }, [])

  // Aggregated /commands from the LOCKED selected groups. The default group
  // (D17 empty marker) has skills:[] → contributes nothing; the built-in flow
  // is already available via the task-author persona.
  const commands = useMemo(() => {
    const byName = new Map<string, SkillGroup>()
    for (const g of allGroups) byName.set(g.group, g)
    const out: string[] = []
    for (const name of skillGroups) {
      const g = byName.get(name)
      if (!g) continue
      for (const s of g.skills) out.push(`/${s.name}`)
    }
    return out
  }, [allGroups, skillGroups])

  // ── Chat (reuses the v2 AuthoringMode wiring) ──────────────────────
  const initialSessionId = task.source_chat_session_id ?? null
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId)
  useEffect(() => {
    if (task.source_chat_session_id && task.source_chat_session_id !== activeSessionId) {
      setActiveSessionId(task.source_chat_session_id)
    }
  }, [task.source_chat_session_id, activeSessionId])

  const apiOverrides = useMemo(() => ({
    getSession: (id: string, q?: { limit?: number; cursor?: string }) =>
      agentApi.getCloneSession(TASK_AUTHOR_CLONE, id, q),
    chatStream: (id: string, msg: string) =>
      agentApi.cloneChatStream(TASK_AUTHOR_CLONE, id, msg),
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

  const handleSend = useCallback((message: string) => {
    chat.sendMessage(message)
  }, [chat])

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

  // ── Enqueue gate (AC6/D18): derive from server-side task_spec truth ─
  const goalConfirmed = !!spec.goal_confirmed
  const acConfirmed = spec.ac_confirmed ?? []
  const acItems = spec.ac ?? []
  const allAcConfirmed = acItems.length > 0 && acItems.every((a) => acConfirmed.includes(a))
  const goalFilled = !!spec.goal && spec.goal.trim().length > 0
  const acFilled = acItems.length >= 1
  const canEnqueue = goalFilled && acFilled && goalConfirmed && allAcConfirmed

  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [gateMissing, setGateMissing] = useState<string[] | null>(null)

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
    <div className="flex flex-col h-full min-h-0" data-authoring-workspace>
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
            <Settings2 className="size-3 mr-1" /> 编写语境 · {presetOrg} · {presetProjects.length} 项目
          </Button>
        )}
        <div className="ml-auto text-[10px] text-muted-foreground">右侧 = 产出查看器 · 有问题直接在对话里让 agent 改</div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ── LEFT: chat (AC7 command bar above it) ── */}
        <div className="flex-1 flex flex-col min-h-0 border-r border-border">
          <div className="px-3 py-1.5 border-b bg-background flex items-center gap-2 overflow-x-auto" data-command-bar>
            {commands.length === 0 ? (
              <span className="text-[10px] text-muted-foreground">无额外命令（仅内置 spec-field 流程）</span>
            ) : (
              commands.map((cmd) => (
                <button
                  key={cmd}
                  onClick={() => handleSend(cmd.startsWith("/") ? `${cmd} ` : cmd)}
                  className="shrink-0 px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-accent transition-colors"
                >
                  {cmd}
                </button>
              ))
            )}
          </div>

          <div className="flex-1 min-h-0">
            <ChatArea
              messages={chat.messages}
              streaming={chat.streaming}
              streamContent={chat.streamContent}
              streamThinking={chat.streamThinking}
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
            />
          </div>
        </div>

        {/* ── RIGHT: output viewer (D11 — no skill-group info here) ── */}
        <div className="w-[340px] shrink-0 flex flex-col min-h-0 bg-muted/20 overflow-y-auto p-3 space-y-3" data-output-viewer>
          <GoalAcCard task={task} onMutated={onMutated} />

          {/* enqueue checklist (AC6) */}
          <div className="rounded-lg border bg-background px-3 py-2.5" data-enqueue-checklist>
            <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-[11px] mb-2">
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
            </div>
            {gateMissing && gateMissing.length > 0 ? (
              <div className="mb-2 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[10px] text-red-600" data-gate-missing>
                服务端门禁缺失：{gateMissing.join(", ")}
              </div>
            ) : null}
            {!canEnqueue ? (
              <p className="text-[10px] text-muted-foreground mb-2">请先确认 goal + 全部 ac</p>
            ) : null}
            <Button
              size="sm"
              className="w-full text-xs"
              onClick={handleEnqueue}
              disabled={!canEnqueue || enqueueBusy}
              data-task-enqueue
            >
              {enqueueBusy ? <Spinner className="size-4" /> : <Send className="size-3.5 mr-1" />}
              入队执行
            </Button>
          </div>
        </div>
      </div>

      {/* ── preset popup (AC3/US14: org + projects only, NO skills) ── */}
      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-base">⚙️ 编写语境</DialogTitle>
            <DialogDescription className="text-xs">
              预设只有组织 + 项目两项。执行技能由 workflow.requires 负责。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <div>
              <div className="text-muted-foreground mb-1">组织</div>
              {orgs.length > 1 ? (
                <select
                  className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
                  value={presetOrg}
                  onChange={(e) => { setPresetOrg(e.target.value); setPresetProjects([]) }}
                >
                  {orgs.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                </select>
              ) : (
                <div className="text-muted-foreground">{presetOrg || "—"}</div>
              )}
            </div>
            <div>
              <div className="text-muted-foreground mb-1">项目（多选）</div>
              {presetOrg ? (
                <ProjectSelector org={presetOrg} value={presetProjects} onChange={setPresetProjects} />
              ) : (
                <p className="text-muted-foreground">未配置组织</p>
              )}
            </div>
            <div className="rounded-md border border-dashed p-2 text-[10px] text-muted-foreground">
              预设创建后随任务锁定。换语境 = 新建任务。
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
