'use client'

/**
 * Traceability: P-04 × US-32 × TC-043
 * Workflow knowledge flat list with expand/collapse rule details
 */

import { useState, useEffect, useCallback } from 'react'
import { GitBranch, FileText, Eye, Edit3 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentEmptyState } from '@/components/agent/shared/AgentEmptyState'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { KnowledgeFile, KnowledgeFileDetail } from '@/lib/knowledge/types'
import { getKnowledgeFiles, getKnowledgeFile } from '@/lib/knowledge/api'

export function WorkflowKnowledgeList() {
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileDetail, setFileDetail] = useState<KnowledgeFileDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)

  // Fetch workflow knowledge files on mount
  const fetchFiles = useCallback(async () => {
    try {
      setLoading(true)
      const res = await getKnowledgeFiles('workflow')
      setFiles(Array.isArray(res) ? res : [])
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '加载工作流知识失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchFiles()
  }, [fetchFiles])

  // View file detail
  const handleViewFile = useCallback(
    async (filePath: string) => {
      if (selectedFile === filePath && fileDetail) {
        // Toggle off
        setSelectedFile(null)
        setFileDetail(null)
        return
      }

      try {
        setDetailLoading(true)
        setSelectedFile(filePath)
        const res = await getKnowledgeFile(filePath)
        setFileDetail(res)
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : '加载文件详情失败')
        setSelectedFile(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [selectedFile, fileDetail],
  )

  // Loading skeleton
  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-md" />
        ))}
      </div>
    )
  }

  // Empty state
  if (files.length === 0) {
    return (
      <AgentEmptyState
        icon={GitBranch}
        title="暂无工作流知识"
        description="同一工作流在不同项目上执行的经验会自动提取到这里。"
      />
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-2">
        {files.map((file) => {
          const isSelected = selectedFile === file.name
          const detailRules = isSelected ? fileDetail?.rules : undefined
          const itemActiveRules = isSelected
            ? detailRules?.filter((r) => r.status === 'active') ?? []
            : []
          const itemRetiredRules = isSelected
            ? detailRules?.filter((r) => r.status === 'retired') ?? []
            : []

          return (
            <div
              key={file.name}
              className={cn(
                'rounded-lg border transition-colors',
                isSelected
                  ? 'border-knowledge-primary/30 bg-knowledge-primary-light/30'
                  : 'border-agent-divider bg-agent-surface',
              )}
            >
              {/* File row */}
              <div className="flex items-center gap-3 px-4 py-3">
                <FileText className="h-4 w-4 text-knowledge-primary shrink-0" />
                <span className="font-medium text-sm truncate flex-1">
                  {file.name}
                </span>
                <Badge variant="secondary" className="text-xs shrink-0">
                  {file.ruleCount} 条规则
                </Badge>
                {file.retiredCount > 0 && (
                  <Badge
                    variant="outline"
                    className="text-xs shrink-0 text-muted-foreground"
                  >
                    {file.retiredCount} 已退休
                  </Badge>
                )}
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={() => handleViewFile(file.name)}
                    disabled={detailLoading}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    查看
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    disabled
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    编辑
                  </Button>
                </div>
              </div>

              {/* Expanded rules detail */}
              {isSelected && (
                <div className="border-t border-agent-divider px-4 py-3 space-y-3">
                  {detailLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-14 w-full" />
                      <Skeleton className="h-14 w-full" />
                    </div>
                  ) : fileDetail ? (
                    <>
                      {/* Active rules */}
                      {itemActiveRules.length > 0 && (
                        <div className="space-y-2">
                          {itemActiveRules.map((rule) => (
                            <div
                              key={rule.id}
                              className="rounded-md border border-agent-divider bg-background p-3"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-sm leading-relaxed flex-1">
                                  {rule.text}
                                </p>
                                <Badge
                                  variant="secondary"
                                  className="text-xs shrink-0 bg-knowledge-primary-light text-knowledge-primary border-0"
                                >
                                  生效中
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1.5">
                                {rule.id} &middot; {rule.source} &middot;{' '}
                                {rule.date}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Retired rules */}
                      {itemRetiredRules.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground font-medium">
                            已退休 ({itemRetiredRules.length})
                          </p>
                          {itemRetiredRules.map((rule) => (
                            <div
                              key={rule.id}
                              className="rounded-md border border-agent-divider bg-background p-3"
                            >
                              <p className="text-sm leading-relaxed text-muted-foreground line-through">
                                {rule.text}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1.5">
                                {rule.id} &middot; {rule.source} &middot;{' '}
                                {rule.date}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* No rules */}
                      {itemActiveRules.length === 0 &&
                        itemRetiredRules.length === 0 && (
                          <p className="text-sm text-muted-foreground py-2 text-center">
                            此文件暂无规则
                          </p>
                        )}
                    </>
                  ) : null}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
