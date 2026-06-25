'use client'

import { useState, useCallback, useEffect } from 'react'
import { Save, Eye, Edit3, Sparkles, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { MemoryContent } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'
import { RefineModal } from './RefineModal'

interface LongTermEditorProps {
  content: MemoryContent | MemoryContent[] | null
  loading: boolean
}

const TOKEN_BUDGET = 1500

export function LongTermEditor({ content, loading }: LongTermEditorProps) {
  const memContent = Array.isArray(content) ? content[0] : content
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(memContent?.content ?? '')
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [showRefine, setShowRefine] = useState(false)
  const [lastModified, setLastModified] = useState<string | undefined>(memContent?.last_modified)
  const [conflictData, setConflictData] = useState<{ serverContent: string } | null>(null)

  // Sync content when loaded
  useEffect(() => {
    if (memContent?.content) {
      setText(memContent.content)
      setLastModified(memContent.last_modified)
    }
  }, [memContent])

  const tokenCount = Math.ceil(text.length / 3) // Rough estimate
  const overBudget = tokenCount > TOKEN_BUDGET

  const handleSave = useCallback(async () => {
    try {
      setSaving(true)
      await api.addMemory({
        layer: 'long-term',
        content: text,
        expected_last_modified: lastModified,
      })
      toast.success('长期记忆已保存')
      setEditing(false)
      setLastModified(new Date().toISOString())
    } catch (err: unknown) {
      // Check if error is a conflict (thrown by request helper with err.code)
      const errCode = (err as { code?: string })?.code
      if (errCode === 'MEMORY_CONFLICT') {
        const serverContent = (err as { details?: { server_content?: string } })?.details?.server_content ?? ''
        setConflictData({ serverContent })
        toast.error('记忆冲突：文件已被其他操作修改')
        return
      }
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [text, lastModified])

  const handleOverwrite = useCallback(async () => {
    try {
      setSaving(true)
      setConflictData(null)
      await api.addMemory({ layer: 'long-term', content: text })
      toast.success('已覆盖保存')
      setEditing(false)
      setLastModified(new Date().toISOString())
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '覆盖保存失败')
    } finally {
      setSaving(false)
    }
  }, [text])

  const handleMerge = useCallback(async () => {
    if (!conflictData) return
    // Simple merge: append server content below user content
    const merged = `${text}\n\n---\n## 归档合并内容\n${conflictData.serverContent}`
    try {
      setSaving(true)
      setConflictData(null)
      await api.addMemory({ layer: 'long-term', content: merged })
      setText(merged)
      toast.success('已合并保存')
      setEditing(false)
      setLastModified(new Date().toISOString())
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '合并保存失败')
    } finally {
      setSaving(false)
    }
  }, [text, conflictData])

  if (loading) {
    return (
      <div className="p-6 space-y-4 max-w-3xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!memContent && !editing) {
    return (
      <div className="p-6 max-w-3xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">长期记忆</h2>
          <Button onClick={() => setEditing(true)} className="bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground gap-1.5">
            <Edit3 className="h-4 w-4" />
            创建
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Agent 还没有长期记忆。开始对话后，重要信息将自动积累在这里。你也可以手动编辑。
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">长期记忆</h2>
        <div className="flex items-center gap-2">
          {!editing ? (
            <Button onClick={() => setEditing(true)} variant="outline" size="sm" className="gap-1.5">
              <Edit3 className="h-3.5 w-3.5" />
              编辑
            </Button>
          ) : (
            <>
              <Button
                onClick={() => setPreviewing(!previewing)}
                variant="ghost"
                size="sm"
                className="gap-1.5"
              >
                <Eye className="h-3.5 w-3.5" />
                {previewing ? '编辑' : '预览'}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving}
                size="sm"
                className="gap-1.5 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? '保存中...' : '保存'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Token budget indicator */}
      {editing && (
        <div className="flex items-center gap-2 mb-3">
          <Badge
            variant="outline"
            className={cn(
              'text-xs',
              overBudget
                ? 'border-agent-error/30 text-agent-error bg-agent-error-light'
                : 'border-agent-info/30 text-agent-info bg-agent-info-light'
            )}
          >
            Token: {tokenCount} / {TOKEN_BUDGET}
          </Badge>
          {overBudget && (
            <span className="text-xs text-agent-error">
              建议精简，超预算会被截取
            </span>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" className="gap-1 text-agent-accent" onClick={() => setShowRefine(true)}>
            <Sparkles className="h-3.5 w-3.5" />
            精炼
          </Button>
        </div>
      )}

      {editing && !previewing ? (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-[400px] font-mono text-sm leading-relaxed bg-agent-surface-inset border-agent-divider focus-visible:ring-agent-primary resize-y"
          placeholder={"## 人格\n## 偏好\n## 经验教训\n## 常用工作流\n## 项目索引"}
        />
      ) : (
        <div className="rounded-lg border border-agent-divider bg-agent-surface-inset p-4 min-h-[400px] prose prose-sm dark:prose-invert max-w-none">
          <pre className="whitespace-pre-wrap font-mono text-sm">{text || '(空)'}</pre>
        </div>
      )}

      {/* Refine modal */}
      {showRefine && (
        <RefineModal
          currentContent={text}
          onRefined={(newContent) => {
            setText(newContent)
            toast.success('精炼完成')
          }}
          onClose={() => setShowRefine(false)}
        />
      )}

      {/* Memory conflict dialog (TC-023: M-MEM-CONFLICT) */}
      {conflictData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-agent-error/30 bg-agent-surface p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="h-5 w-5 text-agent-error" />
              <h3 className="text-lg font-semibold text-agent-error">记忆冲突</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              长期记忆文件已被其他操作（如归档）修改。请选择如何处理：
            </p>
            <div className="flex flex-col gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleOverwrite}
                className="w-full justify-start gap-2"
              >
                <Save className="h-4 w-4" />
                覆盖 — 用我的版本替换服务端内容
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleMerge}
                className="w-full justify-start gap-2"
              >
                <Edit3 className="h-4 w-4" />
                合并 — 将归档内容追加到我的内容后
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConflictData(null)}
                className="w-full justify-start gap-2"
              >
                取消 — 保留本地编辑，不保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
