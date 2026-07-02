'use client'

/**
 * Traceability: P-07 × US-26, US-11 × TC-036, TC-037, TC-015
 * Archive dialog with rule extraction, execution summary, and AI assistant panel
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Save, SkipForward, FileText, BarChart3 } from 'lucide-react'
import { getArchiveSummary, proposeArchive, batchReview } from '@/lib/knowledge/api'
import type { ArchiveSummaryResponse, ArchiveProposeResponse } from '@/lib/knowledge/types'
import { ExtractedRulesPanel, ExtractedRulesPanelSkeleton } from './ExtractedRulesPanel'
import { ExecutionSummaryPanel, ExecutionSummaryPanelSkeleton } from './ExecutionSummaryPanel'
import { KnowledgeAssistantPanel } from '../assistant/KnowledgeAssistantPanel'

interface ArchiveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  executionId: string
  org: string
  onArchiveComplete?: () => void
}

type TabType = 'rules' | 'summary'

export function ArchiveDialog({
  open,
  onOpenChange,
  executionId,
  org,
  onArchiveComplete,
}: ArchiveDialogProps) {
  const [activeTab, setActiveTab] = useState<TabType>('rules')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showSkipConfirm, setShowSkipConfirm] = useState(false)

  const [proposeData, setProposeData] = useState<ArchiveProposeResponse | null>(null)
  const [summaryData, setSummaryData] = useState<ArchiveSummaryResponse | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // Reset state when dialog opens
  useEffect(() => {
    if (!open) return

    setActiveTab('rules')
    setLoading(true)
    setError(null)
    setProposeData(null)
    setSummaryData(null)
    setSelectedIds(new Set())

    Promise.all([
      proposeArchive(executionId, org),
      getArchiveSummary(executionId),
    ])
      .then(([propose, summary]: [ArchiveProposeResponse, ArchiveSummaryResponse]) => {
        setProposeData(propose)
        setSummaryData(summary)
        // Auto-select all rules without conflicts
        const defaultSelected = new Set<number>()
        propose.rules.forEach((rule, idx) => {
          if (!rule.conflicts || rule.conflicts.length === 0) {
            defaultSelected.add(idx)
          }
        })
        setSelectedIds(defaultSelected)
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : '加载失败'
        setError(message)
        toast.error(`归档数据加载失败: ${message}`)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [open, executionId, org])

  const handleToggleSelect = useCallback((index: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    if (!proposeData) return
    setSelectedIds(new Set(proposeData.rules.map((_, idx) => idx)))
  }, [proposeData])

  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const handleSave = useCallback(async () => {
    if (selectedIds.size === 0 || !proposeData) return

    setSaving(true)
    try {
      const ruleIds = Array.from(selectedIds).map((idx) => String(idx))
      await batchReview(ruleIds, 'approve')
      toast.success(`已保存 ${selectedIds.size} 条规则`)
      onOpenChange(false)
      onArchiveComplete?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败'
      toast.error(`规则保存失败: ${message}`)
    } finally {
      setSaving(false)
    }
  }, [selectedIds, proposeData, onOpenChange, onArchiveComplete])

  const handleSkip = useCallback(() => {
    setShowSkipConfirm(false)
    onOpenChange(false)
    toast.info('已跳过规则提取')
  }, [onOpenChange])

  const handleRetry = useCallback(() => {
    if (!open) return
    setLoading(true)
    setError(null)

    Promise.all([
      proposeArchive(executionId, org),
      getArchiveSummary(executionId),
    ])
      .then(([propose, summary]: [ArchiveProposeResponse, ArchiveSummaryResponse]) => {
        setProposeData(propose)
        setSummaryData(summary)
        const defaultSelected = new Set<number>()
        propose.rules.forEach((rule, idx) => {
          if (!rule.conflicts || rule.conflicts.length === 0) {
            defaultSelected.add(idx)
          }
        })
        setSelectedIds(defaultSelected)
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : '加载失败'
        setError(message)
        toast.error(`归档数据加载失败: ${message}`)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [open, executionId, org])

  const rules = proposeData?.rules ?? []
  const hasRules = rules.length > 0
  const selectedCount = selectedIds.size

  // Build execution context for the assistant panel
  const executionContext = useMemo(() => {
    if (!summaryData) return undefined
    return {
      reviewBlockers: summaryData.reviewBlockers,
      e2eResults: summaryData.e2eResults,
      nodeOutputs: summaryData.poolSnapshot ?? undefined,
    }
  }, [summaryData])

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-5xl w-[90vw] max-h-[85vh] p-0 gap-0 overflow-hidden"
          showCloseButton
        >
          {/* Header */}
          <DialogHeader className="px-6 py-4 border-b border-agent-divider shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <FileText className="size-4 text-knowledge-primary" />
              工作区归档
            </DialogTitle>
          </DialogHeader>

          {/* Main content: left + right split */}
          <div className="flex flex-1 min-h-0 overflow-hidden" style={{ height: 'calc(85vh - 140px)' }}>
            {/* Left side — 55% */}
            <div className="flex flex-col w-[55%] border-r border-agent-divider min-h-0">
              {/* Sub-tabs */}
              <div className="flex items-center gap-1 px-4 py-2 border-b border-agent-divider bg-agent-surface/30">
                <button
                  onClick={() => setActiveTab('rules')}
                  className={cn(
                    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    activeTab === 'rules'
                      ? 'bg-knowledge-primary/10 text-knowledge-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                  )}
                >
                  提取规则
                  {hasRules && (
                    <span className="ml-1.5 text-xs opacity-70">({rules.length})</span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab('summary')}
                  className={cn(
                    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1.5',
                    activeTab === 'summary'
                      ? 'bg-knowledge-primary/10 text-knowledge-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                  )}
                >
                  <BarChart3 className="size-3.5" />
                  执行摘要
                </button>
              </div>

              {/* Content area */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {loading && activeTab === 'rules' && (
                  <div className="flex flex-col items-center justify-center h-full gap-3">
                    <Spinner className="size-6 text-knowledge-primary" />
                    <p className="text-sm text-muted-foreground">正在提取规则...</p>
                  </div>
                )}

                {loading && activeTab === 'summary' && (
                  <ExecutionSummaryPanelSkeleton />
                )}

                {!loading && error && (
                  <div className="flex flex-col items-center justify-center h-full gap-3 px-6">
                    <p className="text-sm text-agent-error text-center">{error}</p>
                    <Button variant="outline" size="sm" onClick={handleRetry}>
                      重试
                    </Button>
                  </div>
                )}

                {!loading && !error && activeTab === 'rules' && !hasRules && (
                  <div className="flex flex-col items-center justify-center h-full gap-2 px-6">
                    <FileText className="size-8 text-muted-foreground/50" />
                    <p className="text-sm font-medium text-foreground">
                      本次执行未提取到新规则
                    </p>
                    <p className="text-xs text-muted-foreground text-center max-w-xs">
                      执行过程中未检测到可归档的知识模式，可切换至"执行摘要"查看节点运行详情。
                    </p>
                  </div>
                )}

                {!loading && !error && activeTab === 'rules' && hasRules && (
                  <ExtractedRulesPanel
                    rules={rules}
                    selectedIds={selectedIds}
                    onToggleSelect={handleToggleSelect}
                    onSelectAll={handleSelectAll}
                    onDeselectAll={handleDeselectAll}
                  />
                )}

                {!loading && !error && activeTab === 'summary' && summaryData && (
                  <ExecutionSummaryPanel summary={summaryData} />
                )}
              </div>
            </div>

            {/* Right side — 45%: Assistant panel */}
            <div className="flex flex-col w-[45%] min-h-0">
              <KnowledgeAssistantPanel
                mode="archive"
                collapsible
                open
                executionContext={executionContext}
                ruleContent={
                  activeTab === 'rules' && hasRules
                    ? rules.map((r) => r.text).join('\n\n')
                    : undefined
                }
              />
            </div>
          </div>

          {/* Bottom bar */}
          <div className="flex items-center justify-between px-6 py-3 border-t border-agent-divider bg-agent-surface/30 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSkipConfirm(true)}
              disabled={saving || loading}
              className="gap-1.5 text-muted-foreground"
            >
              <SkipForward className="size-3.5" />
              跳过此次归档
            </Button>

            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || loading || selectedCount === 0}
              className="gap-1.5 bg-knowledge-primary hover:bg-knowledge-primary/90 text-white"
            >
              {saving ? (
                <Spinner className="size-3.5" />
              ) : (
                <Save className="size-3.5" />
              )}
              {saving
                ? '保存中...'
                : `保存选中规则 (${selectedCount} 条)`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Skip confirmation dialog */}
      <AlertDialog open={showSkipConfirm} onOpenChange={setShowSkipConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>跳过此次归档</AlertDialogTitle>
            <AlertDialogDescription>
              将不会保存本次执行提取的任何规则，此操作无法撤销。确定要跳过吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleSkip}>
              确认跳过
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
