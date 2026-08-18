// packages/web-app/components/tasks/authoring/goal-ac-card.tsx
//
// The v3 goal/ac card (ticket 09, US4-6/D7/D8/D18). Lives in the right-side
// OutputViewer of the AuthoringWorkspace. Interaction reference: prototype
// VariantL (app/tasks/prototype/page.tsx:3289) — code rewritten, not copied.
//
// Lifecycle (AC4):
//   ghost placeholder → SSE spec_field_update(goal/ac) emerges the field →
//   user direct-edit (inline textarea) → POST spec-field source=user
//   (server records @@spec_updated so the agent reconciles next turn, D7) →
//   ✏️ 已编辑 mark + confirmation RESET (the gate must re-confirm a changed
//   intent; the server does NOT auto-reset goal_confirmed, so the client
//   explicitly POSTs goal_confirmed=false / ac_confirmed=[] after an edit).
//
// Confirmation (AC5/D18): per-field toggles POST spec-field
// (goal_confirmed / ac_confirmed[]) source=user. The state persists in
// task_spec (survives modal close — the ready gate reads it server-side).
//
// The SSE seam mirrors SpecPanel's pattern (spec-panel.tsx:127): subscribe
// to spec_field_update, filter by task_id, apply the field locally + bump
// the tracked version. Only the fields this card cares about are handled.

"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Check, FileText, X, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { Task, SpecFieldUpdatePayload } from "@octopus/shared"
import { SPEC_FIELD_UPDATE_EVENT } from "@octopus/shared"
import { updateSpecField } from "@/lib/tasks-api"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"

export interface GoalAcCardProps {
  task: Task
  onMutated: () => void
}

export function GoalAcCard({ task, onMutated }: GoalAcCardProps) {
  const taskId = task.id
  const spec = task.task_spec

  // ── Local state (seeded from task; re-synced only on task.id change) ─
  const [goal, setGoal] = useState<string>(spec.goal ?? "")
  const [ac, setAc] = useState<string[]>(spec.ac ?? [])
  const [goalConfirmed, setGoalConfirmed] = useState<boolean>(!!spec.goal_confirmed)
  const [acConfirmed, setAcConfirmed] = useState<string[]>(spec.ac_confirmed ?? [])
  const [editedByUser, setEditedByUser] = useState(false)
  const [editingGoal, setEditingGoal] = useState(false)
  const [draftGoal, setDraftGoal] = useState("")
  const [busy, setBusy] = useState(false)

  // Re-seed when a DIFFERENT task is opened (modal switch / modal reopen
  // after close). Same-task version bumps arrive via SSE below — do NOT
  // re-seed on version change or we'd clobber in-progress edits + SSE-applied
  // fields (mirrors SpecPanel's SG8fix).
  const dirtyRef = useRef(false)
  // dirty tracking isn't used for save-enabling here (spec-field is the write
  // path, not PUT), but the ref keeps the re-seed guard honest for future use.
  void dirtyRef
  useEffect(() => {
    if (!taskId) return
    const s = task.task_spec
    setGoal(s.goal ?? "")
    setAc(s.ac ?? [])
    setGoalConfirmed(!!s.goal_confirmed)
    setAcConfirmed(s.ac_confirmed ?? [])
    setEditedByUser(false)
    setEditingGoal(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on switch only
  }, [taskId])

  // ── SSE: spec_field_update → apply goal/ac/confirm fields locally ──
  const applyField = useCallback((field: string, value: unknown) => {
    switch (field) {
      case "goal":
        setGoal(value as string)
        break
      case "ac":
        setAc(value as string[])
        break
      case "goal_confirmed":
        setGoalConfirmed(value as boolean)
        break
      case "ac_confirmed":
        setAcConfirmed(value as string[])
        break
      default:
        break
    }
  }, [])

  useEffect(() => {
    if (!taskId) return
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      SPEC_FIELD_UPDATE_EVENT,
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as SpecFieldUpdatePayload
          if (payload.task_id !== taskId) return
          applyField(payload.field, payload.value)
        } catch {
          // Malformed event payload — ignore (defensive).
        }
      },
    )
    return () => unsub()
  }, [taskId, applyField])

  // ── Direct goal edit (AC4): spec-field source=user + edited mark + reset ─
  const startEditGoal = () => {
    setDraftGoal(goal)
    setEditingGoal(true)
  }
  const cancelEditGoal = () => setEditingGoal(false)

  const saveGoal = async () => {
    const next = draftGoal.trim()
    if (!next || next === goal) { setEditingGoal(false); return }
    setBusy(true)
    try {
      await updateSpecField(taskId, "goal", next, { source: "user" })
      setGoal(next)
      setEditingGoal(false)
      setEditedByUser(true)
      // AC4: confirm reset — the goal changed, the prior confirmation is stale.
      // The server does NOT auto-reset goal_confirmed; the client must, or the
      // ready gate (goal_confirmed===true) would pass against a new goal.
      if (goalConfirmed) {
        await updateSpecField(taskId, "goal_confirmed", false, { source: "user" })
        setGoalConfirmed(false)
      }
      onMutated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  // ── AC edit: add / remove / edit item → spec-field(ac, source=user) + reset ─
  const writeAc = async (next: string[]) => {
    setBusy(true)
    try {
      await updateSpecField(taskId, "ac", next, { source: "user" })
      setAc(next)
      setEditedByUser(true)
      // Reset ac confirmations: the set changed; stale confirms are invalid.
      const stillConfirmed = acConfirmed.filter((c) => next.includes(c))
      if (stillConfirmed.length !== acConfirmed.length) {
        await updateSpecField(taskId, "ac_confirmed", stillConfirmed, { source: "user" })
        setAcConfirmed(stillConfirmed)
      }
      onMutated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  const addAcItem = () => void writeAc([...ac, ""])
  const removeAcItem = (i: number) => void writeAc(ac.filter((_, j) => j !== i))
  const editAcItem = (i: number, value: string) => {
    // Local-only until blur/save (avoid a spec-field POST per keystroke).
    setAc(ac.map((a, j) => (j === i ? value : a)))
  }
  const commitAcItem = (i: number) => {
    const item = ac[i]
    if (item === undefined || item.trim() === "") return
    const dedup = ac.map((a, j) => (j === i ? a.trim() : a))
    if (dedup.join("\n") !== ac.join("\n")) void writeAc(dedup)
  }

  // ── Confirm toggles (AC5): spec-field(goal_confirmed / ac_confirmed) ─
  const toggleGoalConfirm = async () => {
    const next = !goalConfirmed
    setBusy(true)
    try {
      await updateSpecField(taskId, "goal_confirmed", next, { source: "user" })
      setGoalConfirmed(next)
      onMutated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "确认失败")
    } finally {
      setBusy(false)
    }
  }

  const toggleAcConfirm = async (item: string) => {
    const has = acConfirmed.includes(item)
    const next = has ? acConfirmed.filter((c) => c !== item) : [...acConfirmed, item]
    setBusy(true)
    try {
      await updateSpecField(taskId, "ac_confirmed", next, { source: "user" })
      setAcConfirmed(next)
      onMutated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "确认失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border-2 border-amber-400/40 bg-background overflow-hidden" data-goal-ac-card>
      <div className="px-3 py-2 border-b bg-amber-400/10 flex items-center gap-2">
        <span className="text-xs font-semibold">🎯 目标 & 验收标准</span>
        <span className="text-[10px] text-muted-foreground">agent 绑定时浮现 · 可直编</span>
      </div>
      <div className="p-3 space-y-3">
        {/* ── goal ── */}
        {!goal && !editingGoal ? (
          <div className="text-[11px] text-muted-foreground/50 border border-dashed rounded-md px-3 py-2">
            ⏳ goal — 待 agent 绑定后浮现…
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <button
              onClick={toggleGoalConfirm}
              disabled={busy || !goal}
              aria-label="确认 goal"
              data-confirmed={goalConfirmed ? "true" : "false"}
              className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${goalConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}
            >
              {goalConfirmed && <Check className="size-3" />}
            </button>
            <div className="flex-1">
              <div className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-2">
                goal
                {editedByUser && (
                  <span className="inline-flex items-center gap-0.5 text-amber-600 text-[9px]" data-edited-mark>
                    <FileText className="size-3" /> 已编辑
                  </span>
                )}
                {!editingGoal && goal && (
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    title="直接编辑"
                    aria-label="直接编辑 goal"
                    onClick={startEditGoal}
                  >
                    <FileText className="size-3" />
                  </button>
                )}
              </div>
              {editingGoal ? (
                <div className="space-y-1.5">
                  <Textarea
                    value={draftGoal}
                    onChange={(e) => setDraftGoal(e.target.value)}
                    className="text-xs min-h-[52px]"
                    disabled={busy}
                  />
                  <div className="flex gap-1.5">
                    <Button size="sm" className="h-6 text-[10px]" onClick={saveGoal} disabled={busy}>
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={cancelEditGoal} disabled={busy}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-xs">{goal}</div>
              )}
            </div>
          </div>
        )}

        {/* ── ac ── */}
        {ac.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/50 border border-dashed rounded-md px-3 py-2">
            ⏳ ac — 待 agent 绑定后浮现…
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <button
              onClick={() => {
                // Confirm all ac items at once (convenience).
                const allConfirmed = acConfirmed.length === ac.length
                void (async () => {
                  const next = allConfirmed ? [] : ac
                  setBusy(true)
                  try {
                    await updateSpecField(taskId, "ac_confirmed", next, { source: "user" })
                    setAcConfirmed(next)
                    onMutated()
                  } catch (err: unknown) {
                    toast.error(err instanceof Error ? err.message : "确认失败")
                  } finally {
                    setBusy(false)
                  }
                })()
              }}
              disabled={busy}
              aria-label="确认全部 ac"
              data-ac-all-confirmed={acConfirmed.length === ac.length ? "true" : "false"}
              className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${acConfirmed.length === ac.length ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}
            >
              {acConfirmed.length === ac.length && ac.length > 0 && <Check className="size-3" />}
            </button>
            <div className="flex-1">
              <div className="text-[10px] text-muted-foreground mb-0.5">ac（{ac.length} 条）</div>
              <ul className="text-xs space-y-1">
                {ac.map((item, i) => {
                  const confirmed = acConfirmed.includes(item)
                  return (
                    <li key={i} className="flex items-start gap-1.5">
                      <button
                        onClick={() => void toggleAcConfirm(item)}
                        disabled={busy}
                        aria-label={`确认 ac: ${item}`}
                        data-confirmed={confirmed ? "true" : "false"}
                        className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${confirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}
                      >
                        {confirmed && <Check className="size-3" />}
                      </button>
                      <input
                        value={item}
                        onChange={(e) => editAcItem(i, e.target.value)}
                        onBlur={() => commitAcItem(i)}
                        disabled={busy}
                        className="flex-1 text-xs bg-transparent border-none outline-none focus:bg-muted/30 rounded px-1"
                      />
                      <button
                        onClick={() => void removeAcItem(i)}
                        disabled={busy}
                        className="text-muted-foreground/40 hover:text-red-500 shrink-0"
                        aria-label={`删除 ac ${i + 1}`}
                      >
                        <X className="size-3" />
                      </button>
                    </li>
                  )
                })}
              </ul>
              <Button variant="ghost" size="sm" className="h-6 text-[10px] mt-1" onClick={addAcItem} disabled={busy}>
                <Plus className="size-3" /> 添加
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
