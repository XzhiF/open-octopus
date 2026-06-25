"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChevronDown, ChevronUp, Bot, Zap } from "lucide-react"

interface AgentOutputViewerProps {
  output: string | null
  modelUsed?: string | null
  tokenUsage?: {
    input_tokens?: number
    output_tokens?: number
  } | null
  maxPreviewLength?: number
}

export function AgentOutputViewer({
  output,
  modelUsed,
  tokenUsage,
  maxPreviewLength = 200,
}: AgentOutputViewerProps) {
  const [expanded, setExpanded] = useState(false)

  if (!output) {
    return (
      <div className="text-sm text-muted-foreground italic py-2">
        无 Agent 输出
      </div>
    )
  }

  const isTruncated = output.length > maxPreviewLength
  const displayText = expanded ? output : output.slice(0, maxPreviewLength)

  return (
    <div className="space-y-2">
      {/* Token usage badges */}
      {(modelUsed || tokenUsage) && (
        <div className="flex items-center gap-2 flex-wrap">
          {modelUsed && (
            <Badge variant="outline" className="gap-1 text-xs">
              <Bot className="size-3" />
              {modelUsed}
            </Badge>
          )}
          {tokenUsage && (
            <Badge variant="outline" className="gap-1 text-xs">
              <Zap className="size-3" />
              {tokenUsage.input_tokens ?? 0}/{tokenUsage.output_tokens ?? 0} tokens
            </Badge>
          )}
        </div>
      )}

      {/* Output content */}
      <div className="relative">
        <pre className="bg-muted rounded-md p-3 text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-96">
          {displayText}
          {isTruncated && !expanded && "..."}
        </pre>

        {isTruncated && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 gap-1"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3" />
                收起
              </>
            ) : (
              <>
                <ChevronDown className="size-3" />
                展开全文 ({output.length} 字符)
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
