"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { MessageBubble } from "@/components/workspace/chat/message-bubble"
import type { ChatMessage, StepExecution } from "@/lib/types"
import { getServerUrl } from "@/lib/server-config"

interface InteractionDetailTabsProps {
  step?: StepExecution
  isRunning: boolean
  workspaceId: string
  executionId: string
}

interface InteractionMessageRow {
  id: string
  execution_id: string
  node_id: string
  role: string
  type: string
  content: string
  metadata: string | null
  created_at: string
}

/**
 * InteractionDetailTabs — three-tab view for interaction node details.
 * Tab 1: Conversation — message history from interaction_messages
 * Tab 2: Trace — token/cost data from node_token_usages + llm_calls
 * Tab 3: Result — summary, vars_update, outputs
 */
export function InteractionDetailTabs({
  step,
  isRunning,
  workspaceId,
  executionId,
}: InteractionDetailTabsProps) {
  const nodeId = step?.stepId ?? ""
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState("conversation")

  // Load messages when conversation or result tab is active
  useEffect(() => {
    if ((activeTab !== "conversation" && activeTab !== "result") || !nodeId) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(
          `${getServerUrl()}/api/workspaces/${workspaceId}/interactions/${executionId}/${nodeId}/messages?limit=200`
        )
        if (!res.ok) return
        const rows: InteractionMessageRow[] = await res.json()
        if (cancelled) return

        const converted: ChatMessage[] = rows
          .filter(row => !(row.role === "assistant" && row.type === "text" && !row.content))
          .map(row => {
          let meta: Record<string, unknown> = {}
          try { meta = JSON.parse(row.metadata ?? "{}") } catch { /* ignore */ }

          return {
            id: row.id,
            sessionId: `${executionId}-${nodeId}`,
            role: row.role as ChatMessage["role"],
            displayType: (meta.displayType as ChatMessage["displayType"]) ?? row.type as ChatMessage["displayType"],
            content: row.content,
            timestamp: row.created_at,
            toolCallId: meta.toolCallId as string | undefined,
            toolName: meta.toolName as string | undefined,
            toolInput: meta.toolInput,
            toolStatus: meta.toolStatus as ChatMessage["toolStatus"],
            toolResult: meta.toolResult as string | undefined,
            toolDuration: meta.toolDuration as string | undefined,
            thinkingContent: row.type === "thinking" ? row.content : undefined,
            thinkingDone: row.type === "thinking",
            thinkingDuration: meta.thinkingDuration as string | undefined,
            tokens: meta.tokens as ChatMessage["tokens"],
            costUsd: meta.costUsd as number | undefined,
          }
        })

        setMessages(converted)
      } catch {
        // Non-fatal
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [activeTab, nodeId, workspaceId, executionId])

  // Parse result data from step output or last assistant message
  const resultData = parseResultData(step?.output, messages)

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2 shrink-0">
        <TabsTrigger value="conversation" className="text-xs">
          对话记录 {messages.length > 0 && `(${messages.length})`}
        </TabsTrigger>
        <TabsTrigger value="trace" className="text-xs">
          追踪
        </TabsTrigger>
        <TabsTrigger value="result" className="text-xs">
          结果
        </TabsTrigger>
      </TabsList>

      {/* Tab 1: Conversation */}
      <TabsContent value="conversation" className="m-0 flex-1 min-h-0 overflow-auto p-3">
        {loading ? (
          <div className="text-xs text-muted-foreground text-center py-8">加载中...</div>
        ) : messages.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">暂无对话记录</div>
        ) : (
          <div className="space-y-2">
            {messages.map((msg, idx) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={false}
                isLast={idx === messages.length - 1}
              />
            ))}
          </div>
        )}
      </TabsContent>

      {/* Tab 2: Trace */}
      <TabsContent value="trace" className="m-0 flex-1 min-h-0 overflow-auto p-3">
        <div className="space-y-3">
          {step?.tokenUsages && step.tokenUsages.length > 0 ? (
            <div>
              <h4 className="text-xs font-medium mb-2">Token 用量</h4>
              <div className="grid grid-cols-2 gap-2">
                {step.tokenUsages.map((usage, idx) => (
                  <div key={idx} className="bg-muted rounded p-2 text-xs">
                    <div className="font-medium">{usage.model ?? "unknown"}</div>
                    <div className="text-muted-foreground">
                      Input: {(usage.inputTokens ?? 0).toLocaleString()} · Output: {(usage.outputTokens ?? 0).toLocaleString()}
                    </div>
                    {usage.cacheReadTokens ? (
                      <div className="text-muted-foreground">
                        Cache Read: {usage.cacheReadTokens.toLocaleString()}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {step?.tokensInput || step?.tokensOutput ? (
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-muted rounded p-2">
                    <div className="text-muted-foreground">Input</div>
                    <div className="font-medium">{(step.tokensInput ?? 0).toLocaleString()}</div>
                  </div>
                  <div className="bg-muted rounded p-2">
                    <div className="text-muted-foreground">Output</div>
                    <div className="font-medium">{(step.tokensOutput ?? 0).toLocaleString()}</div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8">暂无追踪数据</div>
              )}
            </div>
          )}
          {(() => {
            const dur = step?.duration && step.duration > 0
              ? step.duration
              : step?.startedAt && step?.completedAt
                ? (new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000
                : null
            return dur != null && dur > 0 ? (
              <div className="bg-muted rounded p-2 text-xs">
                <div className="text-muted-foreground">Duration</div>
                <div className="font-medium">{dur.toFixed(1)}s</div>
              </div>
            ) : null
          })()}
        </div>
      </TabsContent>

      {/* Tab 3: Result */}
      <TabsContent value="result" className="m-0 flex-1 min-h-0 overflow-auto p-3">
        <div className="space-y-3">
          {resultData.summary ? (
            <div>
              <h4 className="text-xs font-medium mb-1">Summary</h4>
              <div className="bg-muted rounded p-2 text-xs">{resultData.summary}</div>
            </div>
          ) : null}

          {resultData.varsUpdate && Object.keys(resultData.varsUpdate).length > 0 ? (
            <div>
              <h4 className="text-xs font-medium mb-1">Variables Update</h4>
              <div className="bg-muted rounded p-2 text-xs space-y-1">
                {Object.entries(resultData.varsUpdate).map(([key, value]) => (
                  <div key={key} className="flex gap-2">
                    <span className="font-mono text-blue-600">{key}:</span>
                    <span className="text-muted-foreground">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {step?.output && !resultData.summary ? (
            <div>
              <h4 className="text-xs font-medium mb-1">Output</h4>
              <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                {step.output}
              </pre>
            </div>
          ) : null}

          {!resultData.summary && !resultData.varsUpdate && !step?.output ? (
            <div className="text-xs text-muted-foreground text-center py-8">暂无结果数据</div>
          ) : null}
        </div>
      </TabsContent>
    </Tabs>
  )
}

/** Parse result data from step output or last assistant message containing completion JSON. */
function parseResultData(output?: string, messages?: ChatMessage[]): {
  summary?: string
  varsUpdate?: Record<string, unknown>
} {
  // Try step output first
  if (output) {
    const fromOutput = extractCompletionJson(output)
    if (fromOutput) return fromOutput
  }

  // Fall back to last assistant message with completion JSON
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === "assistant" && msg.content) {
        const fromMsg = extractCompletionJson(msg.content)
        if (fromMsg) return fromMsg
      }
    }
  }

  return {}
}

/** Extract summary/vars_update from text containing JSON code fence or direct JSON. */
function extractCompletionJson(text: string): { summary?: string; varsUpdate?: Record<string, unknown> } | null {
  // Try code fence
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      if (parsed.summary || parsed.vars_update) {
        return { summary: parsed.summary, varsUpdate: parsed.vars_update }
      }
    } catch { /* ignore */ }
  }

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(text)
    if (parsed.summary || parsed.vars_update) {
      return { summary: parsed.summary, varsUpdate: parsed.vars_update }
    }
  } catch { /* ignore */ }

  return null
}
