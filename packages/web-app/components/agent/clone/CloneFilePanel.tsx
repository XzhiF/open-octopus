'use client'

import { useState, useEffect, useCallback } from 'react'
import { Save, Loader2, FileText, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import * as api from '@/lib/agent/api'
import type { CloneInfo } from '@/lib/agent/types'

interface CloneFilePanelProps {
  clone: CloneInfo | null
  onClose: () => void
}

type FileTab = 'persona.md' | 'config.json'

export function CloneFilePanel({ clone, onClose }: CloneFilePanelProps) {
  const [activeTab, setActiveTab] = useState<FileTab>('persona.md')
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadFile = useCallback(async (filePath: FileTab) => {
    if (!clone) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.getCloneFile(clone.name, filePath)
      setContent(res.content)
      setOriginalContent(res.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file')
      setContent('')
      setOriginalContent('')
    } finally {
      setLoading(false)
    }
  }, [clone])

  useEffect(() => {
    if (clone) {
      loadFile(activeTab)
    }
  }, [clone, activeTab, loadFile])

  const handleSave = async () => {
    if (!clone) return

    // Validate config.json is valid JSON
    if (activeTab === 'config.json') {
      try {
        JSON.parse(content)
      } catch {
        toast.error('config.json 格式无效，请检查 JSON 语法')
        return
      }
    }

    setSaving(true)
    try {
      await api.updateCloneFile(clone.name, activeTab, content)
      setOriginalContent(content)
      toast.success(`${activeTab} 已保存`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = content !== originalContent

  return (
    <Sheet open={!!clone} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-[480px] sm:w-[540px] flex flex-col p-0">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4" />
            文件管理 — {clone?.display_name || clone?.name}
          </SheetTitle>
        </SheetHeader>

        {/* Tab selector */}
        <div className="flex border-b">
          {(['persona.md', 'config.json'] as FileTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'px-4 py-2 text-sm font-mono transition-colors border-b-2',
                activeTab === tab
                  ? 'border-agent-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              加载中...
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-sm text-agent-error py-4">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          ) : (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="h-full min-h-[300px] font-mono text-xs resize-none bg-agent-surface-inset border-agent-divider"
              spellCheck={false}
            />
          )}
        </div>

        {/* Save bar */}
        <div className="flex items-center justify-between px-4 py-3 border-t bg-agent-surface-raised">
          <div className="text-xs text-muted-foreground">
            {hasChanges ? (
              <span className="text-agent-warn">有未保存的更改</span>
            ) : (
              <span>无更改</span>
            )}
          </div>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saving || loading}
            size="sm"
            className="gap-1.5 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
