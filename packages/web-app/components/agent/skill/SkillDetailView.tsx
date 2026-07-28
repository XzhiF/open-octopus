'use client'

import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Pencil, Check, X, GitCompare, Save, RotateCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import * as api from '@/lib/agent/api'
import type { SkillInfo, SkillSource } from '@/lib/agent/types'

interface SkillDetailViewProps {
  skills: SkillInfo[]
  onBack: () => void
  onRefresh: () => void
}

const sourceLabels: Record<string, { label: string; className: string }> = {
  local_evolved: { label: '进化版', className: 'bg-agent-accent-light text-agent-accent border-agent-accent/20' },
  builtin: { label: '内置版', className: 'bg-muted text-muted-foreground' },
  prod: { label: '生产版', className: 'bg-agent-success-light text-agent-success-foreground border-agent-success/20' },
}

export function SkillDetailView({ skills, onBack, onRefresh }: SkillDetailViewProps) {
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [skillSource, setSkillSource] = useState<SkillSource>('builtin')

  // Load skill content when selected
  const loadSkillContent = useCallback(async (name: string) => {
    setLoading(true)
    try {
      const res = await api.getSkill(name)
      setContent(res.content)
      setSkillSource(res.source as SkillSource)
    } catch {
      setContent(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Auto-select first skill
  useEffect(() => {
    if (!selectedSkill && skills.length > 0) {
      setSelectedSkill(skills[0].name)
    }
  }, [skills, selectedSkill])

  useEffect(() => {
    if (selectedSkill) {
      loadSkillContent(selectedSkill)
      setIsEditing(false)
      setShowDiff(false)
    }
  }, [selectedSkill, loadSkillContent])

  // Load diff
  const loadDiff = useCallback(async () => {
    if (!selectedSkill) return
    setDiffLoading(true)
    try {
      const res = await api.getSkillDiff(selectedSkill)
      setDiff(res.diff)
    } catch {
      setDiff(null)
    } finally {
      setDiffLoading(false)
    }
  }, [selectedSkill])

  useEffect(() => {
    if (showDiff && selectedSkill) {
      loadDiff()
    }
  }, [showDiff, selectedSkill, loadDiff])

  // Save
  const handleSave = async () => {
    if (!selectedSkill || !editContent) return
    setSaving(true)
    try {
      await api.saveSkill(selectedSkill, editContent)
      setContent(editContent)
      setIsEditing(false)
      toast.success('SKILL 已保存')
      onRefresh()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // Revert
  const handleRevert = async () => {
    if (!selectedSkill) return
    try {
      await api.revertToBuiltin(selectedSkill)
      await loadSkillContent(selectedSkill)
      toast.success('已回退到内置版本')
      onRefresh()
    } catch {
      toast.error('回退失败')
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-agent-divider bg-agent-surface-raised">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回列表
          </Button>
          {selectedSkill && (
            <span className="text-sm font-medium font-mono">{selectedSkill}</span>
          )}
          {selectedSkill && (
            <Badge variant="outline" className={cn('text-xs', sourceLabels[skillSource]?.className ?? sourceLabels.builtin.className)}>
              {sourceLabels[skillSource]?.label ?? '内置版'}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {selectedSkill && !isEditing && (
            <>
              <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => { setEditContent(content ?? ''); setIsEditing(true) }}>
                <Pencil className="h-3.5 w-3.5" />
                编辑
              </Button>
              <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setShowDiff(!showDiff)}>
                <GitCompare className={cn('h-3.5 w-3.5', showDiff && 'text-agent-info')} />
                对比
              </Button>
              {skillSource === 'local_evolved' && (
                <Button variant="ghost" size="sm" className="gap-1 text-xs text-agent-warn" onClick={handleRevert}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  回退
                </Button>
              )}
            </>
          )}
          {isEditing && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} disabled={saving}>
                <X className="h-3.5 w-3.5 mr-1" />
                取消
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
                <Save className="h-3.5 w-3.5" />
                {saving ? '保存中...' : '保存'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Resizable three-column layout */}
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Skill List Panel */}
        <ResizablePanel defaultSize={20} minSize={10} maxSize={35} collapsible collapsedSize={0}>
          <div className="h-full overflow-auto border-r border-agent-divider">
            <div className="p-2 space-y-1">
              {skills.map((skill) => {
                const srcInfo = sourceLabels[skill.source] ?? sourceLabels.builtin
                return (
                  <button
                    key={skill.name}
                    onClick={() => setSelectedSkill(skill.name)}
                    className={cn(
                      'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                      selectedSkill === skill.name
                        ? 'bg-agent-primary-light text-agent-primary'
                        : 'hover:bg-accent text-foreground'
                    )}
                  >
                    <div className="font-mono text-xs truncate">{skill.name}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="outline" className={cn('text-[10px] px-1', srcInfo.className)}>
                        {srcInfo.label}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{skill.token_count}t</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle className="border-agent-divider" />

        {/* Content Panel */}
        <ResizablePanel defaultSize={showDiff ? 45 : 80} minSize={20}>
          <div className="h-full overflow-auto p-6">
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-4/6" />
              </div>
            ) : isEditing ? (
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full h-full min-h-[60vh] rounded-lg border border-agent-divider bg-agent-surface-inset p-4 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-agent-primary/50"
              />
            ) : content ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">
                选择一个 SKILL 查看内容
              </p>
            )}
          </div>
        </ResizablePanel>

        {/* Diff Panel */}
        {showDiff && (
          <>
            <ResizableHandle withHandle className="border-agent-divider" />
            <ResizablePanel defaultSize={35} minSize={20} maxSize={60}>
              <div className="h-full overflow-auto p-4">
                <div className="flex items-center gap-2 mb-3">
                  <GitCompare className="h-4 w-4 text-agent-info" />
                  <span className="text-sm font-medium">Diff: 本地 vs 内置</span>
                </div>
                {diffLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-5/6" />
                  </div>
                ) : diff ? (
                  <div className="rounded-lg bg-agent-surface-inset border border-agent-divider p-3 font-mono text-xs leading-relaxed">
                    {diff.split('\n').map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.startsWith('+') ? 'text-agent-success bg-agent-success-light/30' :
                          line.startsWith('-') ? 'text-agent-error bg-agent-error-light/30' :
                          line.startsWith('@@') ? 'text-agent-info' :
                          'text-muted-foreground'
                        }
                      >
                        <span className="inline-block w-6 text-right mr-2 text-muted-foreground/50 select-none">{i + 1}</span>
                        {line}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    本地版本与内置版本一致，无差异
                  </p>
                )}
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}
