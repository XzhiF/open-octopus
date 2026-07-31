"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MessageCircle, CheckCircle2 } from "lucide-react"
import { getServerUrl } from "@/lib/server-config"
import { toast } from "sonner"
import { useChatStream } from "./chat/use-chat-stream"
import { ChatPanel } from "./chat/chat-panel"

interface InteractionModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  executionId: string
  nodeId: string
  workspaceId: string
  display?: "modal" | "panel"
  onComplete: (summary: string, varsUpdate?: Record<string, any>) => void
}

/**
 * InteractionModal — embeds the full ChatPanel inside a Dialog for interaction nodes.
 * Reuses useChatStream for all SSE handling (ask_user_question, tool_call, thinking, etc.)
 * and ChatPanel for rich message rendering (QuestionCard, ToolCard, etc.)
 */
export function InteractionModal({
  open,
  onOpenChange,
  executionId,
  nodeId,
  workspaceId,
  display = "modal",
  onComplete,
}: InteractionModalProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null)
  const [forceCompleting, setForceCompleting] = useState(false)
  const sessionCreatedRef = useRef<string | null>(null)

  // Use the full chat stream hook — handles all SSE chunk types
  const chat = useChatStream(workspaceId, sessionId)

  // Create interaction session when modal opens (only once per execution+node)
  useEffect(() => {
    if (!open) return
    const key = `${executionId}-${nodeId}`
    if (sessionCreatedRef.current === key) return
    let cancelled = false

    const startSession = async () => {
      try {
        const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/interaction/${nodeId}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
        if (!res.ok) throw new Error("Failed to start interaction session")
        const data = await res.json()
        if (!cancelled) {
          sessionCreatedRef.current = key
          setSessionId(data.sessionId)
          setInitialPrompt(data.initialPrompt ?? null)
        }
      } catch (err) {
        toast.error("Failed to start interaction session")
      }
    }

    startSession()
    return () => { cancelled = true }
  }, [open, executionId, nodeId, workspaceId])

  // Send initial prompt once session is ready and messages are loaded
  const promptSentRef = useRef<string | null>(null)
  useEffect(() => {
    if (!sessionId || !initialPrompt) return
    if (promptSentRef.current === sessionId) return
    if (chat.isStreaming) return // wait for idle

    promptSentRef.current = sessionId
    const messageContent = `[系统指令 - 以下是你在本次交互中的角色和任务]\n\n${initialPrompt}\n\n[请根据以上指令开始与用户对话]`
    chat.sendMessage(messageContent).catch(() => {
      toast.error("Failed to start agent conversation")
    })
  }, [sessionId, initialPrompt, chat.isStreaming])

  // Listen for interaction completion via workspace SSE
  useEffect(() => {
    if (!open || !workspaceId) return
    const eventSource = new EventSource(`${getServerUrl()}/api/workspaces/${workspaceId}/events`)

    eventSource.addEventListener("execution_interaction_completed", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.executionId === executionId && data.nodeId === nodeId) {
          onOpenChange(false)
          onComplete(data.summary ?? "Completed", data.vars_update)
          toast.success("Interaction completed")
        }
      } catch { /* ignore parse errors */ }
    })

    return () => eventSource.close()
  }, [open, workspaceId, executionId, nodeId, onOpenChange, onComplete])

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      // Don't reset sessionId — keep the session alive for re-opening
    }
  }, [open])

  const handleCreateSession = useCallback(async () => {
    return sessionId ?? ""
  }, [sessionId])

  // Force complete the interaction (fallback when agent doesn't signal completion)
  const handleForceComplete = useCallback(async () => {
    if (forceCompleting) return
    const confirmed = window.confirm("确定要强制结束交互吗？工作流将继续执行下一步。")
    if (!confirmed) return
    setForceCompleting(true)
    try {
      const res = await fetch(
        `${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/interaction/${nodeId}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summary: "用户手动结束交互" }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Force complete failed" }))
        throw new Error(err.error ?? "Force complete failed")
      }
      onOpenChange(false)
      onComplete("用户手动结束交互")
      toast.success("Interaction force completed")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to force complete interaction")
    } finally {
      setForceCompleting(false)
    }
  }, [forceCompleting, workspaceId, executionId, nodeId, onOpenChange, onComplete])

  // Chat content (shared between modal and panel modes)
  const chatContent = sessionId ? (
    <ChatPanel
      messages={chat.messages}
      sessions={chat.sessions}
      activeSessionId={sessionId}
      isStreaming={chat.isStreaming}
      status={chat.status}
      streamStartMs={chat.streamStartMs}
      streamEndState={chat.streamEndState}
      hasMoreMessages={chat.hasMoreMessages}
      onLoadMoreMessages={chat.loadMoreMessages}
      onSendMessage={async (content: string) => {
        await chat.sendMessage(content)
      }}
      onAbort={() => chat.abort()}
      onCreateSession={handleCreateSession}
      onSelectSession={() => {}}
      onDeleteSession={() => {}}
      onRenameSession={() => {}}
    />
  ) : (
    <div className="flex items-center justify-center h-64 text-muted-foreground">
      Initializing interaction session...
    </div>
  )

  if (display === "panel") {
    return (
      <div className="flex flex-col h-full border-l">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <MessageCircle className="h-4 w-4 text-purple-500" />
          <span className="text-sm font-medium">Interaction: {nodeId}</span>
        </div>
        <div className="flex-1 min-h-0">
          {chatContent}
        </div>
      </div>
    )
  }

  // Modal mode (default) — same size as approval dialog
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-5xl flex flex-col h-[95vh] max-h-[95vh] overflow-hidden gap-0 p-0"
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0 px-6 pt-4 pb-2">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-purple-500" />
              Interaction: {nodeId}
            </DialogTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={handleForceComplete}
              disabled={forceCompleting}
              className="text-amber-600 border-amber-300 hover:bg-amber-50"
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              {forceCompleting ? "Completing..." : "Force Complete"}
            </Button>
          </div>
          <DialogDescription>
            Chat with the agent. Ask questions, provide feedback. The interaction completes automatically when the agent signals completion. Use "Force Complete" if the agent doesn't respond correctly.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-hidden">
          {chatContent}
        </div>
      </DialogContent>
    </Dialog>
  )
}
