"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter
} from "@/components/ui/dialog"
import { MessageCircle, Send, X } from "lucide-react"

interface InteractionModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  nodeId: string
  display?: "modal" | "panel"
  onComplete: (summary: string, varsUpdate?: Record<string, any>) => void
  loading?: boolean
}

/**
 * InteractionModal — displays a chat-like interface for interaction nodes.
 * In modal mode, opens as a dialog. In panel mode, renders inline (future).
 */
export function InteractionModal({
  open,
  onOpenChange,
  sessionId,
  nodeId,
  display = "modal",
  onComplete,
  loading = false,
}: InteractionModalProps) {
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([])
  const [input, setInput] = useState("")
  const [summary, setSummary] = useState("")

  const handleSendMessage = () => {
    if (!input.trim()) return
    setMessages(prev => [...prev, { role: "user", content: input }])
    setInput("")
    // In real implementation, this would send to the chat session via API
  }

  const handleComplete = () => {
    if (!summary.trim()) return
    onComplete(summary)
  }

  if (display === "panel") {
    // Panel mode: render inline (simplified for now)
    return (
      <div className="flex flex-col h-full border-l">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <MessageCircle className="h-4 w-4 text-purple-500" />
          <span className="text-sm font-medium">Interaction: {nodeId}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onOpenChange(false)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, i) => (
            <div key={i} className={`text-sm ${msg.role === "user" ? "text-right" : "text-left"}`}>
              <div className={`inline-block rounded-lg px-3 py-2 ${msg.role === "user" ? "bg-purple-100 dark:bg-purple-900/30" : "bg-gray-100 dark:bg-gray-800"}`}>
                {msg.content}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t p-3 space-y-2">
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send a message..."
              className="min-h-[40px]"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
            />
            <Button size="icon" onClick={handleSendMessage} disabled={!input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex gap-2">
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Completion summary..."
              className="min-h-[40px]"
            />
            <Button variant="outline" onClick={handleComplete} disabled={!summary.trim() || loading}>
              Complete
            </Button>
          </div>
        </div>
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
            Chat session for workflow interaction. Communicate with the agent and complete when done.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-[200px] space-y-3 py-4">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground text-sm py-8">
              Waiting for agent to start the conversation...
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`text-sm ${msg.role === "user" ? "text-right" : "text-left"}`}>
              <div className={`inline-block rounded-lg px-3 py-2 max-w-[80%] ${msg.role === "user" ? "bg-purple-100 dark:bg-purple-900/30" : "bg-gray-100 dark:bg-gray-800"}`}>
                {msg.content}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t pt-3 space-y-2">
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send a message..."
              className="min-h-[40px]"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
            />
            <Button size="icon" onClick={handleSendMessage} disabled={!input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex gap-2 items-end">
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Enter completion summary (or use complete_interaction tool from agent)..."
              className="min-h-[40px] flex-1"
            />
            <Button variant="outline" onClick={handleComplete} disabled={!summary.trim() || loading}>
              {loading ? "Completing..." : "Force Complete"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
