'use client'

import { useState } from 'react'
import { Calendar as CalendarIcon, Pencil, Check, X } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import * as api from '@/lib/agent/api'
import type { MemoryContent } from '@/lib/agent/types'

interface DailyBrowserProps {
  content: MemoryContent | MemoryContent[] | null
  loading: boolean
  onRefresh?: () => void
}

export function DailyBrowser({ content, loading, onRefresh }: DailyBrowserProps) {
  const items = Array.isArray(content) ? content : content ? [content] : []
  const [selectedDate, setSelectedDate] = useState<string | null>(
    items[0]?.date ?? null
  )
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)

  const selectedContent = items.find(item => item.date === selectedDate)

  const handleStartEdit = () => {
    setEditContent(selectedContent?.content ?? '')
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditContent('')
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.addMemory({ layer: 'daily', content: editContent })
      toast.success('工作记忆已保存')
      setIsEditing(false)
      onRefresh?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">工作记忆</h2>
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={handleStartEdit}>
            <Pencil className="h-3.5 w-3.5" />
            新建
          </Button>
        </div>
        {isEditing ? (
          <div className="space-y-3">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full h-64 rounded-lg border border-agent-divider bg-agent-surface-inset p-4 font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-agent-primary/50"
              placeholder="记录今天的工作内容..."
            />
            <div className="flex items-center gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={handleCancelEdit} disabled={saving}>取消</Button>
              <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
                <Check className="h-3.5 w-3.5" />
                {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            还没有工作记忆。Agent 每天会自动记录工作摘要。
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">工作记忆</h2>
        {!isEditing && (
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={handleStartEdit}>
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </Button>
        )}
      </div>

      {/* Date selector */}
      <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-2">
        <CalendarIcon className="h-4 w-4 text-muted-foreground shrink-0" />
        {items.map((item, i) => (
          <button
            key={item.date ?? i}
            onClick={() => { setSelectedDate(item.date ?? null); setIsEditing(false) }}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
              selectedDate === item.date
                ? 'bg-agent-primary text-agent-primary-foreground'
                : 'bg-accent text-foreground hover:bg-accent/80'
            )}
          >
            {item.date}
          </button>
        ))}
      </div>

      {/* Content */}
      {isEditing ? (
        <div className="space-y-3">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full h-64 rounded-lg border border-agent-divider bg-agent-surface-inset p-4 font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-agent-primary/50"
            placeholder="记录今天的工作内容..."
          />
          <div className="flex items-center gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={handleCancelEdit} disabled={saving}>
              <X className="h-3.5 w-3.5 mr-1" />
              取消
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
              <Check className="h-3.5 w-3.5" />
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      ) : selectedContent ? (
        <div className="rounded-lg border border-agent-divider bg-agent-surface-inset p-4 prose prose-sm dark:prose-invert max-w-none">
          <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
            {selectedContent.content}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
