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

export interface EditableTitleProps {
  task: Task | null
  onMutated: () => void
}

export function EditableTitle({ task, onMutated }: EditableTitleProps) {
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

  return (
    <DialogTitle className="group/title text-base min-w-0">
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
          className="w-72 max-w-[60vw] bg-muted/50 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          title="点击编辑标题"
          data-title-edit
          className="inline-flex items-center gap-1.5 min-w-0 max-w-full text-left hover:text-primary transition-colors"
        >
          <span className="truncate">{task?.name ?? "新建任务"}</span>
          <Pencil className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      )}
    </DialogTitle>
  )
}
