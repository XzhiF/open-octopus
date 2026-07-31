"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter
} from "@/components/ui/dialog"
import { MessageCircle, Send, X, Loader2 } from "lucide-react"
import { getServerUrl } from "@/lib/server-config"
import { toast } from "sonner"

interface InteractionMessage {
  role: "user" | "assistant"
  content: string
  timestamp?: string
}

interface InteractionModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  executionId: string
  nodeId: string
  workspaceId: string
  display?: "modal" | "panel"
  onComplete: (summary: string, varsUpdate?: Record<string, any>) => void
}

/** Shared message list component — used in both modal and panel modes. */
function MessageList({ messages, streaming }: { messages: InteractionMessage[]; streaming: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages.length, streaming])

  if (messages.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-8">
        {streaming ? "Agent is thinking..." : "Waiting for agent to start the conversation..."}
      </div>
    )
  }

  return (
    <>
      {messages.map((msg, i) => (
        <div key={i} className={`text-sm ${msg.role === "user" ? "text-right" : "text-left"}`}>
          <div className={`inline-block rounded-lg px-3 py-2 max-w-[80%] ${msg.role === "user" ? "bg-purple-100 dark:bg-purple-900/30" : "bg-gray-100 dark:bg-gray-800"}`}>
            {msg.content}
          </div>
        </div>
      ))}
      {streaming && (
        <div className="text-left text-sm">
          <div className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Agent is responding...</span>
          </div>
        </div>
      )}
      <div ref={endRef} />
    </>
  )
}

/**
 * InteractionModal — chat-based interface for interaction nodes.
 * Connects to the workspace chat API for real-time multi-turn conversation.
 * In modal mode, opens as a dialog. In panel mode, renders inline.
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
  const [messages, setMessages] = useState<InteractionMessage[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [completing, setCompleting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Start interaction session when modal opens
  useEffect(() => {
    if (!open) return
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
          setSessionId(data.sessionId)
          // Auto-send the initial prompt to kick off the agent conversation
          if (data.initialPrompt && data.sessionId) {
            sendInitialPrompt(data.sessionId, data.initialPrompt)
          }
        }
      } catch (err) {
        toast.error("Failed to start interaction session")
      }
    }

    startSession()
    return () => { cancelled = true }
  }, [open, executionId, nodeId, workspaceId])

  // Send the initial prompt as the first message to the chat session
  const sendInitialPrompt = async (sid: string, prompt: string) => {
    setStreaming(true)
    setMessages([{ role: "assistant", content: "正在启动对话..." }])

    abortRef.current = new AbortController()
    try {
      // Wrap the prompt as agent instructions, not as a user question
      const messageContent = `[系统指令 - 以下是你在本次交互中的角色和任务]\n\n${prompt}\n\n[请根据以上指令开始与用户对话]`
      const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/chat/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: messageContent }),
        signal: abortRef.current.signal,
      })

      if (!res.ok || !res.body) throw new Error("Failed to send initial message")

      // Parse SSE stream for assistant response
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantText = ""
      // Replace placeholder with real assistant message
      setMessages([{ role: "assistant", content: "" }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split("\n")
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const d = JSON.parse(line.slice(6))
              if (d.type === "text_delta" && d.content) {
                assistantText += d.content
                setMessages([{ role: "assistant", content: assistantText }])
              }
              if (d.type === "result" && d.content) {
                assistantText = d.content
                setMessages([{ role: "assistant", content: assistantText }])
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        toast.error("Failed to start agent conversation")
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  // Listen for interaction completion via workspace SSE
  useEffect(() => {
    if (!open) return
    const eventSource = new EventSource(`${getServerUrl()}/api/workspaces/${workspaceId}/events`)

    eventSource.addEventListener("execution_interaction_completed", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.executionId === executionId && data.nodeId === nodeId) {
          onOpenChange(false)
          toast.success("Interaction completed")
        }
      } catch { /* ignore parse errors */ }
    })

    return () => eventSource.close()
  }, [open, workspaceId, executionId, nodeId, onOpenChange])

  // Send message to the chat session via API
  const handleSendMessage = useCallback(async () => {
    if (!input.trim() || !sessionId || streaming) return

    const userMsg: InteractionMessage = { role: "user", content: input }
    setMessages(prev => [...prev, userMsg])
    const content = input
    setInput("")
    setStreaming(true)

    abortRef.current = new AbortController()

    try {
      const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: abortRef.current.signal,
      })

      if (!res.ok || !res.body) throw new Error("Failed to send message")

      // Parse SSE stream for assistant response
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantText = ""

      // Add placeholder assistant message
      setMessages(prev => [...prev, { role: "assistant", content: "" }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        // Parse SSE events from the stream
        const lines = chunk.split("\n")
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.type === "text_delta" && data.content) {
                assistantText += data.content
                setMessages(prev => {
                  const updated = [...prev]
                  const last = updated[updated.length - 1]
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = { ...last, content: assistantText }
                  }
                  return updated
                })
              }
              if (data.type === "result" && data.content) {
                assistantText = data.content
                setMessages(prev => {
                  const updated = [...prev]
                  const last = updated[updated.length - 1]
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = { ...last, content: assistantText }
                  }
                  return updated
                })
              }
            } catch { /* ignore non-JSON lines */ }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        toast.error("Failed to send message")
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [input, sessionId, streaming, workspaceId])

  // Force complete the interaction
  const handleForceComplete = useCallback(async () => {
    if (!sessionId || completing) return
    setCompleting(true)

    try {
      const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/interaction/${nodeId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Manually completed by user" }),
      })
      if (!res.ok) throw new Error("Failed to complete interaction")
      onOpenChange(false)
      toast.success("Interaction completed")
    } catch (err) {
      toast.error("Failed to complete interaction")
    } finally {
      setCompleting(false)
    }
  }, [sessionId, completing, workspaceId, executionId, nodeId, onOpenChange])

  // Abort streaming on unmount
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const chatContent = (
    <>
      <div className="flex-1 overflow-y-auto min-h-[200px] space-y-3 py-4">
        <MessageList messages={messages} streaming={streaming} />
      </div>

      <div className="border-t pt-3 space-y-2">
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Send a message..."
            className="min-h-[40px]"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
            disabled={streaming || !sessionId}
          />
          <Button size="icon" onClick={handleSendMessage} disabled={!input.trim() || streaming || !sessionId}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={handleForceComplete} disabled={!sessionId || completing || streaming}>
            {completing ? "Completing..." : "Force Complete"}
          </Button>
        </div>
      </div>
    </>
  )

  if (display === "panel") {
    return (
      <div className="flex flex-col h-full border-l">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <MessageCircle className="h-4 w-4 text-purple-500" />
          <span className="text-sm font-medium">Interaction: {nodeId}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onOpenChange(false)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {chatContent}
      </div>
    )
  }

  // Modal mode (default)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-purple-500" />
            Interaction: {nodeId}
          </DialogTitle>
          <DialogDescription>
            Chat with the agent. Ask questions, provide feedback, and complete when satisfied.
          </DialogDescription>
        </DialogHeader>
        {chatContent}
      </DialogContent>
    </Dialog>
  )
}
