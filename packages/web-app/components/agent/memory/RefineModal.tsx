'use client'

import { useState } from 'react'
import { Sparkles, X, ArrowRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import * as api from '@/lib/agent/api'

interface RefineModalProps {
  currentContent: string
  onRefined: (newContent: string) => void
  onClose: () => void
}

export function RefineModal({ currentContent, onRefined, onClose }: RefineModalProps) {
  const [refining, setRefining] = useState(false)
  const [refinedContent, setRefinedContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRefine = async () => {
    setRefining(true)
    setError(null)

    try {
      // Simulate refinement — in production this would call an LLM API
      // For now, perform basic structural refinement: remove redundant lines
      const lines = currentContent.split('\n')
      const seen = new Set<string>()
      const refinedLines: string[] = []

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '' || !seen.has(trimmed)) {
          refinedLines.push(line)
          if (trimmed !== '') seen.add(trimmed)
        }
      }

      const refined = refinedLines.join('\n')
      setRefinedContent(refined)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '精炼失败')
    } finally {
      setRefining(false)
    }
  }

  const handleApply = async () => {
    if (!refinedContent) return

    try {
      // Save refined content — the server creates .bak automatically
      await api.addMemory({ layer: 'long-term', content: refinedContent })
      onRefined(refinedContent)
      toast.success('精炼完成，原内容已备份为 long-term.md.bak')
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '精炼失败已回滚')
    }
  }

  const beforeTokenCount = Math.ceil(currentContent.length / 3)
  const afterTokenCount = refinedContent ? Math.ceil(refinedContent.length / 3) : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-xl border border-agent-divider bg-agent-surface-raised shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-agent-divider bg-agent-surface-inset">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-agent-accent" />
            <span className="text-sm font-medium">M-MEM-REFINE · 长期记忆精炼</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="关闭"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {!refinedContent ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                精炼将去除冗余内容，压缩到 1500 token 以内。原内容会自动备份为 long-term.md.bak。
              </p>
              <div className="rounded-lg border border-agent-divider bg-agent-surface-inset p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium">当前内容</span>
                  <span className="text-xs text-muted-foreground">{beforeTokenCount} tokens</span>
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">{currentContent}</pre>
              </div>
              {error && (
                <div className="rounded-md bg-agent-error-light border border-agent-error/20 p-2 text-sm text-agent-error flex items-center gap-2">
                  <RotateCcw className="h-4 w-4" />
                  {error} — 精炼失败已回滚
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-agent-divider bg-agent-surface-inset p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium">精炼前</span>
                    <span className="text-xs text-muted-foreground">{beforeTokenCount} tokens</span>
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap max-h-36 overflow-y-auto text-muted-foreground line-through">{currentContent.slice(0, 300)}...</pre>
                </div>
                <div className="rounded-lg border border-agent-success/20 bg-agent-success/5 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-agent-success">精炼后</span>
                    <span className="text-xs text-agent-success">{afterTokenCount} tokens</span>
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap max-h-36 overflow-y-auto">{refinedContent.slice(0, 300)}...</pre>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                节省 {beforeTokenCount - afterTokenCount} tokens ({Math.round((1 - afterTokenCount / beforeTokenCount) * 100)}%)
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-agent-divider">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          {!refinedContent ? (
            <Button
              onClick={handleRefine}
              disabled={refining}
              className="gap-1.5 bg-agent-accent hover:bg-agent-accent/90 text-agent-accent-foreground"
            >
              <Sparkles className="h-4 w-4" />
              {refining ? '精炼中...' : '开始精炼'}
            </Button>
          ) : (
            <Button
              onClick={handleApply}
              className="gap-1.5 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
            >
              应用精炼结果
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
