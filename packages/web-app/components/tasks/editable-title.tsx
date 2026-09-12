// packages/web-app/components/tasks/editable-title.tsx
//
// Editable draft title in the TaskModal header. Mirrors the goal/ac-card
// blur-commit model (ticket 09) so the header title is directly editable:
//
//   click title → input replaces it (select-all, so typing replaces the old
//   name) → blur or Enter commits via PUT /api/tasks/:id {name} with the
//   optimistic-lock If-Match version → onMutated() refreshes the board.
//   Escape cancels; empty / unchanged values are a no-op.
//
// Only drafts are editable (the server only accepts PUT on draft/ready, and a
// non-draft header is just a label). Renaming only changes the display name —
// the task home dir is keyed on the task id (`~/.octopus/tasks/{id}/`), so no
// workspace path is affected.
//
// editingRef guards the blur-after-Escape race: unmounting a focused input
// fires a blur whose closure still holds editing=true — the ref's false
// short-circuits commit so Escape never saves.

"use client"

import { useEffect, useRef, useState } from "react"
import { DialogTitle } from "@/components/ui/dialog"
import { Pencil } from "lucide-react"
import { toast } from "sonner"
import type { Task } from "@octopus/shared"
import { updateTask } from "@/lib/tasks-api"
import { cn } from "@/lib/utils"

export interface EditableTitleProps {
  task: Task | null
  onMutated: () => void
  /** "term" = 深色 terminal 导航条内嵌款（mono、黄字、虚下划线，2026-09-12 草稿改版）。 */
  variant?: "default" | "term"
}

export function EditableTitle({ task, onMutated, variant = "default" }: EditableTitleProps) {
  const isDraft = task?.status === "draft"
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task?.name ?? "")
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const editingRef = useRef(false)

  // Re-sync the input when the task name changes (rename, board refetch).
  useEffect(() => { setDraft(task?.name ?? "") }, [task?.name])

  if (!isDraft) {
    return <DialogTitle className="text-base truncate">{task?.name ?? "新建任务"}</DialogTitle>
  }

  const startEdit = () => {
    if (!task) return
    setDraft(task.name ?? "")
    editingRef.current = true
    setEditing(true)
    // Select-all: typing replaces the old name; blur/Enter commits.
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
  }

  const cancel = () => {
    editingRef.current = false
    setEditing(false)
  }

  const commit = async () => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    if (!task) return
    const next = draft.trim()
    if (!next || next === (task.name ?? "")) return // unchanged or blank → no-op
    setSaving(true)
    try {
      await updateTask(task.id, { name: next }, task.version)
      toast.success("标题已更新")
      onMutated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存标题失败")
    } finally {
      setSaving(false)
    }
  }

  // term 变体（terminal 导航条内嵌）不包 DialogTitle —— Radix 要求 Dialog
  // 上下文，而 AuthoringWorkspace 会被单测裸挂载；草稿态的 DialogTitle 由
  // TaskModal 以 sr-only 形式兜底（a11y 标题不缺）。
  const inner = (
    <>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commit() }
            if (e.key === "Escape") cancel()
          }}
          disabled={saving}
          aria-label="编辑任务标题"
          data-title-edit-input
          className={
            variant === "term"
              ? "w-64 max-w-[50vw] rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-pop-bg outline-none focus:ring-1 focus:ring-pop-yellow"
              : "w-72 max-w-[60vw] bg-muted/50 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-primary"
          }
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          title="点击编辑标题"
          data-title-edit
          className={cn(
            "inline-flex items-center gap-1.5 min-w-0 max-w-full text-left transition-colors",
            variant === "term"
              ? "min-w-0 max-w-[36ch] font-mono text-[11px] font-bold text-pop-yellow hover:underline hover:decoration-dashed hover:underline-offset-4"
              : "hover:text-primary",
          )}
        >
          {variant === "term" && <span aria-hidden>✎</span>}
          <span className={variant === "term" ? "truncate" : undefined}>{task?.name ?? "新建任务"}</span>
          {variant !== "term" && <Pencil className="size-3 shrink-0 opacity-60" aria-hidden="true" />}
        </button>
      )}
    </>
  )

  if (variant === "term") {
    return <span className="inline-flex min-w-0 max-w-full items-center">{inner}</span>
  }

  return (
    <DialogTitle className="group/title text-base min-w-0">
      {inner}
    </DialogTitle>
  )
}
