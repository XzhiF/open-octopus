'use client'

/**
 * Traceability: P-03 × US-23, US-30, US-31 × TC-030, TC-031, TC-041
 * Project knowledge tree browser with Accordion, retired rules, compact trigger
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentEmptyState } from '@/components/agent/shared/AgentEmptyState'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { KnowledgeFile, KnowledgeFileDetail } from '@/lib/knowledge/types'
import {
  getKnowledgeFiles,
  getKnowledgeFile,
  compactKnowledge,
  restoreRule,
} from '@/lib/knowledge/api'
import { BookOpen, FolderOpen, Eye, RotateCcw, Edit3, Trash2 } from 'lucide-react'

export function KnowledgeTree() {
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileDetail, setFileDetail] = useState<KnowledgeFileDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [expandedItems, setExpandedItems] = useState<string[]>([])

  // Fetch project knowledge files on mount
  const fetchFiles = useCallback(async () => {
    try {
      setLoading(true)
      const res = await getKnowledgeFiles('project')
      setFiles(Array.isArray(res) ? res : [])
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '加载项目知识失败')
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
        // Expand the accordion item
        setExpandedItems((prev) =>
          prev.includes(filePath) ? prev : [...prev, filePath],
        )
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : '加载文件详情失败')
        setSelectedFile(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [selectedFile, fileDetail],
  )

  // Compact knowledge
  const handleCompact = useCallback(async (file: KnowledgeFile) => {
    try {
      await compactKnowledge(file.scope === 'org' ? 'org' : 'global', file.name)
      toast.success('整理结果已提交审核')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '整理失败')
    }
  }, [])

  // Restore retired rule
  const handleRestore = useCallback(
    async (ruleId: string) => {
      try {
        await restoreRule(ruleId)
        toast.success('规则已恢复')
        // Refetch the current file detail
        if (selectedFile) {
          const res = await getKnowledgeFile(selectedFile)
          setFileDetail(res)
        }
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : '恢复失败')
      }
    },
    [selectedFile],
  )

  // Loading skeleton (tree-shaped with indented lines)
  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-10 w-full rounded-md" />
            <div className="pl-6 space-y-2">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Empty state
  if (files.length === 0) {
    return (
      <AgentEmptyState
        icon={BookOpen}
        title="暂无项目知识"
        description="执行工作流后将自动提取规则"
      />
    )
  }

  const activeRules =
    fileDetail?.rules.filter((r) => r.status === 'active') ?? []
  const retiredRules =
    fileDetail?.rules.filter((r) => r.status === 'retired') ?? []

  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <Accordion
          type="multiple"
          value={expandedItems}
          onValueChange={setExpandedItems}
          className="space-y-2"
        >
          {files.map((file) => (
            <AccordionItem
              key={file.name}
              value={file.name}
              className="border border-agent-divider rounded-lg px-4"
            >
              <AccordionTrigger className="hover:no-underline py-3">
                <div className="flex items-center gap-3 w-full min-w-0">
                  <FolderOpen className="h-4 w-4 text-knowledge-primary shrink-0" />
                  <span className="font-medium text-sm truncate">
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
                  {file.compactNeeded && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-xs shrink-0',
                        'border-amber-300 text-amber-600 bg-amber-50',
                        'dark:bg-amber-950/30 dark:border-amber-700 dark:text-amber-400',
                      )}
                    >
                      超 {file.lineCount} 行
                    </Badge>
                  )}
                </div>
              </AccordionTrigger>

              <AccordionContent>
                {/* Action buttons */}
                <div className="flex items-center gap-2 mb-3">
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
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={() => handleCompact(file)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    整理
                  </Button>
                </div>

                {/* Rules list (when this file is selected) */}
                {selectedFile === file.name && fileDetail && (
                  <div className="space-y-3">
                    {/* Active rules */}
                    {activeRules.length > 0 && (
                      <div className="space-y-2">
                        {activeRules.map((rule) => (
                          <div
                            key={rule.id}
                            className="rounded-md border border-agent-divider bg-agent-surface p-3"
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
                    {retiredRules.length > 0 && (
                      <Accordion
                        type="single"
                        collapsible
                        className="mt-4"
                      >
                        <AccordionItem
                          value="retired"
                          className="border-0"
                        >
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
                                      onClick={() =>
                                        handleRestore(rule.id)
                                      }
                                    >
                                      <RotateCcw className="h-3 w-3" />
                                      恢复
                                    </Button>
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-1.5">
                                    {rule.id} &middot; {rule.source}{' '}
                                    &middot; {rule.date}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    )}

                    {/* No rules in file */}
                    {activeRules.length === 0 &&
                      retiredRules.length === 0 && (
                        <p className="text-sm text-muted-foreground py-4 text-center">
                          此文件暂无规则
                        </p>
                      )}
                  </div>
                )}

                {/* Detail loading indicator */}
                {selectedFile === file.name && detailLoading && (
                  <div className="space-y-2 py-2">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </ScrollArea>
  )
}
