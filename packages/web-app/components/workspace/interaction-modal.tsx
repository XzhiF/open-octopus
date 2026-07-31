"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { MessageCircle, CheckCircle2 } from "lucide-react"
import { getServerUrl } from "@/lib/server-config"
import { toast } from "sonner"
import { useInteractionStream } from "./interaction/use-interaction-stream"
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
 * InteractionModal — embeds the full ChatPanel for interaction node conversations.
 * Uses useInteractionStream for SSE handling (ask_user_question, tool_call, thinking, etc.)
 * and ChatPanel for rich message rendering (QuestionCard, ToolCard, etc.)
 *
 * Data flow: interaction route API (not chat API) → interaction_messages table.
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
  const [sessionReady, setSessionReady] = useState(false)
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null)
  const [forceCompleting, setForceCompleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const sessionCreatedRef = useRef<string | null>(null)

  // Use the interaction stream hook — handles all SSE chunk types
  const interaction = useInteractionStream({ workspaceId, executionId, nodeId })

  // Create interaction session when modal opens (only once per execution+node)
  useEffect(() => {
    if (!open) return
    const key = `${executionId}-${nodeId}`
    if (sessionCreatedRef.current === key) return
    let cancelled = false

    const startSession = async () => {
      try {
        const res = await fetch(
          `${getServerUrl()}/api/workspaces/${workspaceId}/interactions/${executionId}/${nodeId}/start`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display }),
          },
        )
        if (!res.ok) throw new Error("Failed to start interaction session")
        const data = await res.json()
        if (!cancelled) {
          sessionCreatedRef.current = key
          setSessionReady(true)
          setInitialPrompt(data.initialPrompt ?? null)
        }
      } catch (err) {
        toast.error("Failed to start interaction session")
      }
    }

    startSession()
    return () => { cancelled = true }
  }, [open, executionId, nodeId, workspaceId, display])

  // Send initial prompt once session is ready and not streaming
  const promptSentRef = useRef<string | null>(null)
  useEffect(() => {
    if (!sessionReady || !initialPrompt) return
    const promptKey = `${executionId}-${nodeId}`
    if (promptSentRef.current === promptKey) return
    if (interaction.isStreaming) return

    promptSentRef.current = promptKey
    const messageContent = `[系统指令 - 以下是你在本次交互中的角色和任务]\n\n${initialPrompt}\n\n[请根据以上指令开始与用户对话]`
    interaction.sendMessage(messageContent).catch(() => {
      toast.error("Failed to start agent conversation")
    })
  }, [sessionReady, initialPrompt, executionId, nodeId, interaction.isStreaming, interaction.sendMessage])

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

  const handleCreateSession = useCallback(async () => {
    return `${executionId}-${nodeId}`
  }, [executionId, nodeId])

  // Force complete the interaction
  const handleForceComplete = useCallback(async () => {
    if (forceCompleting) return
    setForceCompleting(true)
    try {
      const res = await fetch(
        `${getServerUrl()}/api/workspaces/${workspaceId}/interactions/${executionId}/${nodeId}/complete`,
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
      setConfirmOpen(false)
      onOpenChange(false)
      onComplete("用户手动结束交互")
      toast.success("交互已结束")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to force complete interaction")
    } finally {
      setForceCompleting(false)
    }
  }, [forceCompleting, workspaceId, executionId, nodeId, onOpenChange, onComplete])

  // Chat content (shared between modal and panel modes)
  const chatContent = sessionReady ? (
    <ChatPanel
      messages={interaction.messages}
      sessions={[]}
      activeSessionId={`${executionId}-${nodeId}`}
      isStreaming={interaction.isStreaming}
      status={interaction.status}
      streamStartMs={interaction.streamStartMs}
      streamEndState={interaction.streamEndState}
      hasMoreMessages={interaction.hasMoreMessages}
      onLoadMoreMessages={interaction.loadMoreMessages}
      onSendMessage={async (content: string) => {
        await interaction.sendMessage(content)
      }}
      onAbort={() => interaction.abort()}
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

  // Modal mode (default)
  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-5xl flex flex-col h-[95vh] max-h-[95vh] overflow-hidden gap-0 p-0"
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0 px-6 pt-4 pb-2">
          <div className="flex items-center justify-between pr-8">
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-purple-500" />
              Interaction: {nodeId}
            </DialogTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={forceCompleting}
              className="text-amber-600 border-amber-300 hover:bg-amber-50"
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              {forceCompleting ? "结束中..." : "结束交互"}
            </Button>
          </div>
          <DialogDescription>
            与 Agent 对话，完成后自动关闭。
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-hidden">
          {chatContent}
        </div>
      </DialogContent>
    </Dialog>

    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>结束交互</AlertDialogTitle>
          <AlertDialogDescription>
            确定要结束当前交互吗？工作流将继续执行下一步。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleForceComplete}
            className="bg-amber-600 text-white hover:bg-amber-700"
          >
            {forceCompleting ? "结束中..." : "确认结束"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
