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
    <div className="flex items-center border-b-[2.5px] border-pop-bd bg-pop-paper px-2 py-1.5 shrink-0">
      <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`group flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs cursor-pointer transition-colors shrink-0 border-[1.5px] ${
              session.id === activeSessionId
                ? "bg-pop-yellow text-pop-ink font-black border-pop-bd shadow-pop-sm"
                : "text-pop-dim hover:text-pop-ink hover:bg-pop-yellow-soft border-transparent"
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
                className="w-20 bg-transparent border-b-[1.5px] border-pop-bd outline-none text-xs"
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
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-pop-pink-soft rounded"
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
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-pop-pink-soft rounded"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={onCreateSession}
        aria-label="新建会话"
        className="p-1 rounded-lg border-[1.5px] border-pop-bd bg-pop-paper text-pop-dim shadow-pop-sm pop-press hover:bg-pop-green-soft hover:text-pop-ink transition-colors shrink-0 ml-1"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}