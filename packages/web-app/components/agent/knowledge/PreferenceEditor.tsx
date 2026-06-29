'use client'

/**
 * Traceability: P-02 × US-22 × TC-028, TC-029
 * User preference editor with Markdown view/edit modes and scope switching
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Edit3, Save, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/agent/shared/ConfirmDialog'
import { AgentEmptyState } from '@/components/agent/shared/AgentEmptyState'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { getPreference, updatePreference } from '@/lib/knowledge/api'

type Scope = 'global' | 'org'

export function PreferenceEditor() {
  const [scope, setScope] = useState<Scope>('global')
  const [isEditing, setIsEditing] = useState(false)
  const [content, setContent] = useState('')
  const [editContent, setEditContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pendingScope, setPendingScope] = useState<Scope | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Fetch preference on mount and scope change
  const fetchPreference = useCallback(async (currentScope: Scope) => {
    try {
      setLoading(true)
      const res = await getPreference(currentScope)
      setContent(res.content ?? '')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '加载偏好配置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPreference(scope)
  }, [fetchPreference, scope])

  // Handle scope change with unsaved edit guard
  const handleScopeChange = useCallback(
    (newScope: string) => {
      const ns = newScope as Scope
      if (ns === scope) return

      if (isEditing && editContent !== content) {
        setPendingScope(ns)
        setShowConfirm(true)
        return
      }

      setScope(ns)
    },
    [scope, isEditing, editContent, content],
  )

  const confirmScopeChange = useCallback(() => {
    if (pendingScope) {
      setIsEditing(false)
      setEditContent('')
      setScope(pendingScope)
      setPendingScope(null)
    }
    setShowConfirm(false)
  }, [pendingScope])

  // Enter edit mode
  const startEditing = useCallback(() => {
    setEditContent(content)
    setIsEditing(true)
  }, [content])

  // Cancel editing
  const cancelEditing = useCallback(() => {
    setIsEditing(false)
    setEditContent('')
  }, [])

  // Save preference
  const handleSave = useCallback(async () => {
    try {
      setSaving(true)
      await updatePreference(scope, editContent)
      setContent(editContent)
      setIsEditing(false)
      toast.success('偏好配置已保存')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [scope, editContent])

  // Ctrl+S keyboard shortcut in edit mode
  useEffect(() => {
    if (!isEditing) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isEditing, handleSave])

  // Auto-resize textarea
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [isEditing, editContent])

  // Loading skeleton
  if (loading) {
    return (
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-9 w-20" />
        </div>
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      {/* Top bar: scope switcher + edit button */}
      <div className="flex items-center justify-between mb-6">
        <RadioGroup
          value={scope}
          onValueChange={handleScopeChange}
          className="flex flex-row items-center gap-4"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="global" id="scope-global" />
            <Label htmlFor="scope-global" className="cursor-pointer text-sm font-medium">
              全局
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="org" id="scope-org" />
            <Label htmlFor="scope-org" className="cursor-pointer text-sm font-medium">
              当前组织
            </Label>
          </div>
        </RadioGroup>

        {!isEditing ? (
          <Button
            onClick={startEditing}
            variant="outline"
            size="sm"
            className="gap-1.5"
          >
            <Edit3 className="h-3.5 w-3.5" />
            编辑
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              onClick={cancelEditing}
              variant="ghost"
              size="sm"
              className="gap-1.5"
              disabled={saving}
            >
              <X className="h-3.5 w-3.5" />
              取消
            </Button>
            <Button
              onClick={handleSave}
              size="sm"
              className="gap-1.5 bg-knowledge-primary hover:bg-knowledge-primary/90 text-knowledge-primary-foreground"
              disabled={saving}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        )}
      </div>

      {/* Content area */}
      {isEditing ? (
        <Textarea
          ref={textareaRef}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="min-h-[400px] font-mono text-sm leading-relaxed bg-agent-surface border-agent-divider focus-visible:ring-knowledge-primary resize-y"
          placeholder="在此输入你的偏好配置（支持 Markdown）..."
        />
      ) : content ? (
        <div className="rounded-lg border border-agent-divider bg-agent-surface p-6 min-h-[400px] prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <AgentEmptyState
          icon={Edit3}
          title="暂无偏好配置"
          description="点击上方编辑按钮创建你的偏好配置"
        />
      )}

      {/* Bottom info bar */}
      <div
        className={cn(
          'mt-4 rounded-md px-3 py-2 text-sm',
          'bg-knowledge-primary-light text-knowledge-primary',
        )}
      >
        <span role="img" aria-label="lightning">
          &#9889;
        </span>{' '}
        此文件手动维护，不会被 LLM 自动修改
      </div>

      {/* Scope change confirm dialog */}
      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title="未保存的修改"
        description="当前编辑内容尚未保存，切换范围将丢失修改。是否继续？"
        confirmLabel="继续切换"
        cancelLabel="返回编辑"
        onConfirm={confirmScopeChange}
      />
    </div>
  )
}
