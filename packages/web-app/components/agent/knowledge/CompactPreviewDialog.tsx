'use client'

/**
 * CompactPreviewDialog — streaming preview of compacted knowledge content.
 * Shows AI output in real-time as it streams in, then allows editing before save.
 */

import { useState, useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { createCompactStream, updateKnowledgeFile } from '@/lib/knowledge/api'

export interface CompactPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  org: string
  filePath: string
  onSaved?: () => void
}

export function CompactPreviewDialog({
  open,
  onOpenChange,
  org,
  filePath,
  onSaved,
}: CompactPreviewDialogProps) {
  const [streaming, setStreaming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState('')
  const [original, setOriginal] = useState('')
  const [llmAvailable, setLlmAvailable] = useState(true)
  const abortRef = useRef<(() => void) | null>(null)

  // Stream preview when dialog opens
  useEffect(() => {
    if (!open || !filePath) return

    setStreaming(true)
    setDraft('')
    setOriginal('')
    setLlmAvailable(true)

    let accumulated = ''
    const { reader, abort } = createCompactStream(org, filePath)
    abortRef.current = abort

    async function readStream() {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const msg = JSON.parse(value) as { event: string; data: Record<string, string> }

          switch (msg.event) {
            case 'original':
              setOriginal(msg.data.originalContent ?? '')
              break
            case 'text_delta':
              accumulated += msg.data.content ?? ''
              setDraft(accumulated)
              break
            case 'fallback':
              // LLM unavailable — show original content
              setLlmAvailable(false)
              accumulated = msg.data.content ?? ''
              setDraft(accumulated)
              break
            case 'done':
              break
            case 'error':
              toast.error(msg.data.message ?? '整理失败')
              break
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          toast.error((err as Error).message ?? '流式读取失败')
        }
      } finally {
        setStreaming(false)
      }
    }

    readStream()

    return () => {
      abort()
      abortRef.current = null
    }
  }, [open, org, filePath])

  const handleSave = async () => {
    try {
      setSaving(true)
      await updateKnowledgeFile(filePath, draft, org)
      toast.success('整理已保存')
      onOpenChange(false)
      onSaved?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const originalLines = original.split('\n').length
  const draftLines = draft.split('\n').length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>整理预览</DialogTitle>
          <DialogDescription>
            {streaming
              ? 'AI 正在分析整理...'
              : llmAvailable
                ? 'AI 已合并去重规则。可直接编辑后保存。'
                : 'AI 服务不可用，以下为原始内容。可手动精简后保存。'
            }
            {!streaming && originalLines > 0 && (
              <span className="block mt-1 text-xs">
                {originalLines} 行 → {draftLines} 行
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden relative">
          {streaming && !draft && (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              <Loader2 className="size-5 animate-spin mr-2" />
              AI 正在分析整理...
            </div>
          )}
          {(draft || !streaming) && (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-[400px] font-mono text-sm resize-none"
              readOnly={streaming}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={streaming || saving || !draft}
            className="bg-knowledge-primary hover:bg-knowledge-primary-hover text-knowledge-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                保存中...
              </>
            ) : (
              '确认保存'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
