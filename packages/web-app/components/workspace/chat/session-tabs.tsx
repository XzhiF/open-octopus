"use client"

import type { ChatSession } from "@/lib/types"
import { Plus, X, Pencil, Check } from "lucide-react"
import { useState } from "react"

interface SessionTabsProps {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  onDeleteSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => void
}

export function SessionTabs({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onRenameSession,
}: SessionTabsProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState("")

  return (
    <div className="flex items-center border-b border-border px-2 py-1 shrink-0">
      <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`group flex items-center gap-1 px-3 py-1.5 rounded-t-md text-xs cursor-pointer transition-colors shrink-0 ${
              session.id === activeSessionId
                ? "bg-background text-foreground border border-border border-b-transparent -mb-px"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
            onClick={() => onSelectSession(session.id)}
          >
            {editingId === session.id ? (
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={() => {
                  if (editTitle.trim()) onRenameSession(session.id, editTitle.trim())
                  setEditingId(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (editTitle.trim()) onRenameSession(session.id, editTitle.trim())
                    setEditingId(null)
                  }
                  if (e.key === "Escape") setEditingId(null)
                }}
                className="w-20 bg-transparent border-b border-primary outline-none text-xs"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="max-w-[100px] truncate"
                onDoubleClick={() => {
                  setEditingId(session.id)
                  setEditTitle(session.title ?? "")
                }}
              >
                {session.title || "新会话"}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (editingId === session.id) {
                  if (editTitle.trim()) onRenameSession(session.id, editTitle.trim())
                  setEditingId(null)
                } else {
                  setEditingId(session.id)
                  setEditTitle(session.title ?? "")
                }
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-muted rounded"
            >
              {editingId === session.id ? (
                <Check className="w-3 h-3" />
              ) : (
                <Pencil className="w-3 h-3" />
              )}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDeleteSession(session.id)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-muted rounded"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={onCreateSession}
        className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors shrink-0 ml-1"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}