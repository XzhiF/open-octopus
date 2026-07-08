'use client'

/**
 * ExperienceDetail — right panel of the experience library.
 *
 * Three states:
 *   1. Empty (no file selected) — AgentEmptyState
 *   2. View mode — markdown rendered rules + edit/compact buttons
 *   3. Edit mode — Textarea + save/cancel buttons
 *
 * Reuses the view/edit toggle pattern from PreferenceCard.
 */

import { useState, useEffect, useCallback } from 'react'
import { Edit3, Save, X, Loader2, BookOpen, Sparkles, RotateCcw, Trash2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { AgentEmptyState } from '@/components/agent/shared/AgentEmptyState'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { CompactPreviewDialog } from './CompactPreviewDialog'
import type { KnowledgeFileDetail } from '@/lib/knowledge/types'
import { getKnowledgeFile, updateKnowledgeFile, restoreRule, deleteKnowledgeFile } from '@/lib/knowledge/api'

export interface ExperienceDetailProps {
  filePath: string | null
  /** Initial content for newly created files (from AI generation) */
  initialContent?: string
  /** Current org for save/compact/restore operations */
  org?: string
  /** Called after save succeeds — parent should refetch file list */
  onSaved?: () => void
  /** Called after delete succeeds — parent should clear selection and refetch */
  onDeleted?: () => void
  /** Called when user wants to exit edit mode for a new file */
  onExitCreate?: () => void
}

export function ExperienceDetail({
  filePath,
  initialContent,
  org,
  onSaved,
  onDeleted,
  onExitCreate,
}: ExperienceDetailProps) {
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [detail, setDetail] = useState<KnowledgeFileDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [compactDialogOpen, setCompactDialogOpen] = useState(false)

  // Fetch detail when filePath changes
  useEffect(() => {
    if (!filePath) {
      setDetail(null)
      setMode('view')
      return
    }

    // If initialContent is provided (new file), go straight to edit mode
    if (initialContent) {
      setDetail(null)
      setDraft(initialContent)
      setMode('edit')
      return
    }

    let cancelled = false
    setLoading(true)
    setMode('view')

    getKnowledgeFile(filePath, org)
      .then((res) => {
        if (cancelled) return
        setDetail(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        toast.error(err instanceof Error ? err.message : '加载经验详情失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [filePath, initialContent])

  const startEditing = useCallback(() => {
    setDraft(detail?.content ?? '')
    setMode('edit')
  }, [detail])

  const cancelEditing = useCallback(() => {
    setMode('view')
    setDraft('')
    // If this was a new file (no detail yet), notify parent
    if (!detail && onExitCreate) {
      onExitCreate()
    }
  }, [detail, onExitCreate])

  const handleSave = useCallback(async () => {
    if (!filePath) return
    try {
      setSaving(true)
      await updateKnowledgeFile(filePath, draft, org)
      // Refetch detail to get updated rules
      const res = await getKnowledgeFile(filePath, org)
      setDetail(res)
      setMode('view')
      toast.success('经验已保存')
      onSaved?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [filePath, draft, onSaved])

  const handleCompact = useCallback(() => {
    if (!filePath) return
    setCompactDialogOpen(true)
  }, [filePath])

  const handleDelete = useCallback(() => {
    if (!filePath) return
    setDeleteDialogOpen(true)
  }, [filePath])

  const confirmDelete = useCallback(async () => {
    if (!filePath) return
    try {
      await deleteKnowledgeFile(filePath, org)
      toast.success('经验已删除')
      setDeleteDialogOpen(false)
      onDeleted?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }, [filePath, org, onDeleted])

  const handleRestore = useCallback(async (ruleId: string) => {
    try {
      await restoreRule(ruleId, org)
      toast.success('规则已恢复')
      if (filePath) {
        const res = await getKnowledgeFile(filePath, org)
        setDetail(res)
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '恢复失败')
    }
  }, [filePath])

  // ── Empty state ─────────────────────────────────────────────
  if (!filePath && !initialContent) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <AgentEmptyState
          icon={BookOpen}
          title="选择左侧项目查看经验"
          description="或点击「新建经验」创建"
        />
      </div>
    )
  }

  // ── Loading state ───────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
      </div>
    )
  }

  const activeRules = detail?.rules.filter((r) => r.status === 'active') ?? []
  const retiredRules = detail?.rules.filter((r) => r.status === 'retired') ?? []
  const displayName = filePath?.replace(/^(projects|workflows)\//, '').replace(/\.md$/, '') ?? ''

  // ── Edit mode ───────────────────────────────────────────────
  if (mode === 'edit') {
    return (
      <div className="flex flex-col h-full">
        <header className="flex items-center justify-between px-4 py-3 border-b border-agent-divider bg-agent-surface-raised">
          <span className="text-sm font-medium text-muted-foreground">
            {initialContent ? '新建经验' : '编辑模式'} — {displayName}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={saving}>
              <X className="size-3.5" />
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="bg-knowledge-primary hover:bg-knowledge-primary-hover text-knowledge-primary-foreground"
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              保存
            </Button>
          </div>
        </header>
        <div className="flex-1 p-4">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="在此编辑 Markdown 格式的经验规则…"
            className="h-full min-h-[400px] font-mono text-sm resize-none"
            autoFocus
          />
        </div>
      </div>
    )
  }

  // ── View mode ───────────────────────────────────────────────
  return (
    <>
    <div className="flex flex-col h-full overflow-auto">
      <header className="flex items-center justify-between px-4 py-3 border-b border-agent-divider bg-agent-surface-raised shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate">{displayName}</span>
          {detail && (
            <div className="flex items-center gap-1.5 shrink-0">
              <Badge variant="secondary" className="text-xs">
                {activeRules.length} 条经验
              </Badge>
              {retiredRules.length > 0 && (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  {retiredRules.length} 已退休
                </Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={startEditing}>
            <Edit3 className="size-3.5" />
            编辑
          </Button>
          {detail && activeRules.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleCompact}>
              <Sparkles className="size-3.5" />
              整理
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            删除
          </Button>
        </div>
      </header>

      <div className="flex-1 p-4">
        {detail?.content ? (
          <div className="space-y-4">
            <article className="preference-prose">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                {detail.content}
              </ReactMarkdown>
            </article>

            {/* Retired rules */}
            {retiredRules.length > 0 && (
              <Accordion type="single" collapsible className="mt-4">
                <AccordionItem value="retired" className="border-0">
                  <AccordionTrigger className="text-xs text-muted-foreground py-2 hover:no-underline">
                    已退休 ({retiredRules.length})
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2">
                      {retiredRules.map((rule) => (
                        <div
                          key={rule.id}
                          className="rounded-md border border-agent-divider bg-agent-surface p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm leading-relaxed flex-1 text-muted-foreground line-through">
                              {rule.text}
                            </p>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1 text-xs shrink-0 text-knowledge-primary hover:text-knowledge-primary"
                              onClick={() => handleRestore(rule.id)}
                            >
                              <RotateCcw className="size-3" />
                              恢复
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1.5">
                            {rule.id} &middot; {rule.source} &middot; {rule.date}
                          </p>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </div>
        ) : (
          <AgentEmptyState
            icon={BookOpen}
            title="暂无经验"
            description="点击「编辑」开始添加经验规则"
          />
        )}
      </div>
    </div>

    {/* Delete confirmation dialog */}
    <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除</AlertDialogTitle>
          <AlertDialogDescription>
            将删除经验文件 <span className="font-medium text-foreground">{displayName}</span> 及其所有规则。此操作不可恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirmDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Compact preview dialog */}
    {filePath && (
      <CompactPreviewDialog
        open={compactDialogOpen}
        onOpenChange={setCompactDialogOpen}
        org={org ?? ''}
        filePath={filePath}
        onSaved={async () => {
          // Refetch file detail after compact save
          try {
            const res = await getKnowledgeFile(filePath, org)
            setDetail(res)
          } catch { /* ignore */ }
          onSaved?.()
        }}
      />
    )}
  </>
  )
}
