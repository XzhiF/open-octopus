// packages/web-app/components/tasks/authoring/goal-ac-card.tsx
//
// The v3 goal/ac card (ticket 09, US4-6/D7/D8/D18). Lives in the right-side
// OutputViewer of the AuthoringWorkspace.
//
// Editing model (always-direct, no ghost lock):
//   goal — an always-editable auto-growing textarea; commit on blur →
//   POST spec-field(goal, source=user) (server records @@spec_updated so the
//   agent reconciles next turn, D7) → ✏️ 已编辑 mark + confirmation RESET
//   (the gate must re-confirm a changed intent; the server does NOT auto-reset
//   goal_confirmed, so the client explicitly POSTs goal_confirmed=false).
//   ac — one auto-growing textarea per item with + / − buttons; add appends an
//   editable row, blur commits (trimmed, empty rows are dropped), − removes.
//   Both stay editable even before the agent has generated goal/ac (draft).
//
// Auto-wrap: textareas grow to fit their content with NO height cap — long
// goal/ac text stays fully visible (wraps, never scroll-truncated); the card
// grows and the right pane scrolls instead.
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
import { Button } from "@/components/ui/button"
import { Check, FileText, Minus, Plus } from "lucide-react"
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

// Auto-grow a textarea to fit its content (no cap). Called on change + mount
// so long goal/ac text is always fully visible rather than scroll-truncated.
function growToFit(el: HTMLTextAreaElement) {
  el.style.height = "auto"
  el.style.height = `${el.scrollHeight + 2}px`
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
  const [busy, setBusy] = useState(false)

  // Last committed goal value (snapshot at focus time). Blur commits only when
  // the textarea differs from this — so a focus-then-blur without edits is a no-op.
  const goalRef = useRef<string>(spec.goal ?? "")
  // Per-row textarea refs, for focusing the freshly added ac row.
  const rowsRefs = useRef<(HTMLTextAreaElement | null)[]>([])
  const pendingFocusRef = useRef<number | null>(null)
  // Per-row content snapshot at focus. Distinguishes a freshly added blank row
  // (never persisted → drop locally, the server rejects "") from a persisted
  // row the user cleared (→ persist the removal).
  const rowFocusSnapshot = useRef<(string | null)[]>([])

  // Re-seed when a DIFFERENT task is opened (modal switch / modal reopen
  // after close). Same-task version bumps arrive via SSE below — do NOT
  // re-seed on version change or we'd clobber in-progress edits + SSE-applied
  // fields (mirrors SpecPanel's SG8fix).
  useEffect(() => {
    if (!taskId) return
    const s = task.task_spec
    setGoal(s.goal ?? "")
    goalRef.current = s.goal ?? ""
    setAc(s.ac ?? [])
    setGoalConfirmed(!!s.goal_confirmed)
    setAcConfirmed(s.ac_confirmed ?? [])
    setEditedByUser(false)
    rowsRefs.current = []
    rowFocusSnapshot.current = []
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

  // ── Direct goal edit (AC4): blur-commit → spec-field source=user + edited
  //    mark + confirm reset ─────────────────────────────────────────────
  const saveGoal = useCallback(async () => {
    const next = goal.trim()
    // No-op if unchanged since focus (or empty→empty).
    if (next === goalRef.current) return
    setBusy(true)
    try {
      await updateSpecField(taskId, "goal", next, { source: "user" })
      goalRef.current = next
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
  }, [goal, goalConfirmed, taskId, onMutated])

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

  const addAcItem = () => {
    // Local-only: append a blank editable row. Nothing is POSTed yet — the
    // server rejects "" (ac must be non-empty strings), so a blank row only
    // persists once the user types content and blurs.
    const next = [...ac, ""]
    pendingFocusRef.current = next.length - 1
    setAc(next)
  }
  const removeAcItem = (i: number) => {
    const item = ac[i]
    if (item === undefined) return
    if (item.trim() === "" && !(rowFocusSnapshot.current[i] ?? "").trim()) {
      // Never-persisted blank row (fresh add, aborted) → drop locally, no POST.
      setAc(ac.filter((_, j) => j !== i))
      return
    }
    void writeAc(ac.filter((_, j) => j !== i))
  }
  const editAcItem = (i: number, value: string) => {
    // Local-only until blur/save (avoid a spec-field POST per keystroke).
    setAc(ac.map((a, j) => (j === i ? value : a)))
  }
  const commitAcItem = (i: number) => {
    const item = ac[i]
    if (item === undefined) return
    const trimmed = item.trim()
    // The value this row held when it gained focus = the last persisted value
    // (a fresh blank row snapshots ""). Persist only on a real change from it.
    const before = rowFocusSnapshot.current[i] ?? ""
    if (trimmed === "") {
      const hadContent = before.trim() !== ""
      if (hadContent) {
        // A persisted row the user cleared → persist the removal (server never
        // stores ""; the filtered array has no blanks, so it passes validation).
        void writeAc(ac.filter((_, j) => j !== i))
      } else {
        // A fresh blank row the user aborted → drop locally (never persisted).
        setAc(ac.filter((_, j) => j !== i))
      }
      return
    }
    if (trimmed !== before) {
      const dedup = ac.map((a, j) => (j === i ? trimmed : a))
      void writeAc(dedup)
    }
  }

  // Focus the freshly added ac row once it mounts.
  useEffect(() => {
    const i = pendingFocusRef.current
    if (i === null || i >= rowsRefs.current.length) return
    pendingFocusRef.current = null
    rowsRefs.current[i]?.focus()
  }, [ac])

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

  const toggleAllAcConfirm = async () => {
    const allConfirmed = acConfirmed.length === ac.length && ac.length > 0
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
  }

  // shrink-0: the right panel is a flex column — without it, tall content
  // (long goal/ac) makes flex SHRINK this card and overflow-hidden clips it,
  // instead of the panel scrolling.
  return (
    <div className="shrink-0 rounded-lg border-2 border-amber-400/40 bg-background overflow-hidden" data-goal-ac-card>
      <div className="px-3 py-2 border-b bg-amber-400/10 flex items-center gap-2">
        <span className="text-xs font-semibold">🎯 目标 & 验收标准</span>
        <span className="text-[10px] text-muted-foreground">可直接编辑 · agent 绑定后自动填充</span>
      </div>
      <div className="p-3 space-y-3">
        {/* ── goal: always-editable textarea, commit on blur ── */}
        <div className="flex items-start gap-2">
          <button
            onClick={() => void toggleGoalConfirm()}
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
            </div>
            <textarea
              value={goal}
              onChange={(e) => {
                setGoal(e.target.value)
                growToFit(e.target)
              }}
              onFocus={() => { goalRef.current = goal }}
              onBlur={() => void saveGoal()}
              placeholder="输入目标…(agent 绑定后自动填充)"
              disabled={busy}
              rows={1}
              className="w-full text-xs bg-transparent border-none outline-none focus:bg-muted/30 rounded px-1 resize-none overflow-hidden break-words leading-relaxed"
              aria-label="编辑 goal"
              ref={(el) => { if (el) growToFit(el) }}
            />
          </div>
        </div>

        {/* ── ac: always-rendered editor with + / − buttons ── */}
        <div className="flex items-start gap-2">
          <button
            onClick={() => void toggleAllAcConfirm()}
            disabled={busy || ac.length === 0}
            aria-label="确认全部 ac"
            data-ac-all-confirmed={acConfirmed.length === ac.length && ac.length > 0 ? "true" : "false"}
            className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${acConfirmed.length === ac.length && ac.length > 0 ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}
          >
            {acConfirmed.length === ac.length && ac.length > 0 && <Check className="size-3" />}
          </button>
          <div className="flex-1">
            <div className="text-[10px] text-muted-foreground mb-0.5">ac（{ac.length} 条）</div>
            {ac.length === 0 ? (
              <div className="text-[11px] text-muted-foreground/60 border border-dashed rounded-md px-3 py-2 mb-1.5">
                ⏳ 暂无验收标准 — 点击下方「添加验收标准」手动输入(agent 绑定后也会自动填充)
              </div>
            ) : (
              <ul className="text-xs space-y-1">
                {ac.map((item, i) => {
                  const confirmed = acConfirmed.includes(item)
                  return (
                    <li key={i} className="flex items-start gap-1.5">
                      <button
                        onClick={() => void toggleAcConfirm(item)}
                        disabled={busy || !item.trim()}
                        aria-label={`确认 ac: ${item}`}
                        data-confirmed={confirmed ? "true" : "false"}
                        className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${confirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}
                      >
                        {confirmed && <Check className="size-3" />}
                      </button>
                      <textarea
                        value={item}
                        onChange={(e) => {
                          editAcItem(i, e.target.value)
                          growToFit(e.target)
                        }}
                        onFocus={() => { rowFocusSnapshot.current[i] = ac[i] }}
                        onBlur={() => commitAcItem(i)}
                        disabled={busy}
                        placeholder="输入一条验收标准…"
                        rows={1}
                        className="flex-1 text-xs bg-transparent border-none outline-none focus:bg-muted/30 rounded px-1 resize-none overflow-hidden break-words leading-relaxed"
                        ref={(el) => {
                          rowsRefs.current[i] = el
                          if (el) growToFit(el)
                        }}
                      />
                      <button
                        onClick={() => void removeAcItem(i)}
                        disabled={busy}
                        className="text-muted-foreground/40 hover:text-red-500 shrink-0"
                        aria-label={`删除 ac ${i + 1}`}
                        title="删除本条"
                      >
                        <Minus className="size-3" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <Button variant="ghost" size="sm" className="h-6 text-[10px] mt-1" onClick={addAcItem} disabled={busy}>
              <Plus className="size-3" /> 添加验收标准
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
