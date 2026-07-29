'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Pencil, X, GitCompare, Save, RotateCcw, Search } from 'lucide-react'
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
  loading?: boolean
  onRefresh: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Fuzzy match: returns matched character indices, or null if no match */
function fuzzyMatch(text: string, query: string): number[] | null {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const indices: number[] = []
  let qi = 0
  for (let ti = 0; ti < lower.length && qi < q.length; ti++) {
    if (lower[ti] === q[qi]) {
      indices.push(ti)
      qi++
    }
  }
  return qi === q.length ? indices : null
}

const sourceLabels: Record<string, { label: string; className: string }> = {
  local_evolved: { label: '进化版', className: 'bg-agent-accent-light text-agent-accent border-agent-accent/20' },
  builtin: { label: '内置版', className: 'bg-muted text-muted-foreground' },
  prod: { label: '生产版', className: 'bg-agent-success-light text-agent-success-foreground border-agent-success/20' },
}

export function SkillDetailView({ skills, loading: skillsLoading, onRefresh }: SkillDetailViewProps) {
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
  const [searchQuery, setSearchQuery] = useState('')

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

  // Fuzzy filtered skills
  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills.map((s) => ({ skill: s, matchIndices: null as number[] | null }))
    return skills
      .map((s) => ({ skill: s, matchIndices: fuzzyMatch(s.name, searchQuery) }))
      .filter((r) => r.matchIndices !== null)
  }, [skills, searchQuery])

  // Render skill name with matched characters highlighted
  function renderHighlighted(name: string, indices: number[]) {
    const set = new Set(indices)
    const parts: { text: string; highlight: boolean }[] = []
    let current = ''
    let currentHighlight = set.has(0)

    for (let i = 0; i < name.length; i++) {
      const isHighlight = set.has(i)
      if (isHighlight !== currentHighlight) {
        if (current) parts.push({ text: current, highlight: currentHighlight })
        current = name[i]
        currentHighlight = isHighlight
      } else {
        current += name[i]
      }
    }
    if (current) parts.push({ text: current, highlight: currentHighlight })

    return parts.map((part, i) =>
      part.highlight
        ? <span key={i} className="text-red-500">{part.text}</span>
        : <span key={i}>{part.text}</span>
    )
  }

  // Show loading skeleton while skills are being fetched
  if (skillsLoading) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-agent-divider bg-agent-surface-raised">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-16" />
        </div>
        <ResizablePanelGroup direction="horizontal" className="flex-1">
          <ResizablePanel defaultSize={20} minSize={10} maxSize={35}>
            <div className="p-2 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle className="border-agent-divider" />
          <ResizablePanel defaultSize={80} minSize={20}>
            <div className="p-6 space-y-3">
              <Skeleton className="h-6 w-1/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/6" />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    )
  }

  // Empty state when no skills
  if (skills.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <p className="text-sm">暂无 SKILL</p>
          <p className="text-xs mt-1">SKILL 会在日常使用中自动积累</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-agent-divider bg-agent-surface-raised">
        <div className="flex items-center gap-2">
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
          <div className="h-full flex flex-col border-r border-agent-divider">
            {/* Search input */}
            <div className="p-2 border-b border-agent-divider">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索 SKILL..."
                  className="w-full pl-8 pr-8 py-1.5 rounded-md text-xs border border-agent-divider bg-agent-surface-inset focus:outline-none focus:ring-1 focus:ring-agent-primary/50 placeholder:text-muted-foreground/60"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {searchQuery && (
                <div className="text-[10px] text-muted-foreground mt-1 px-1">
                  {filteredSkills.length} / {skills.length} 个匹配
                </div>
              )}
            </div>
            {/* Skill list */}
            <div className="flex-1 overflow-auto p-2 space-y-1">
              {filteredSkills.map(({ skill, matchIndices }) => {
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
                    <div className="font-mono text-xs truncate">
                      {matchIndices ? (
                        renderHighlighted(skill.name, matchIndices)
                      ) : (
                        skill.name
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="outline" className={cn('text-[10px] px-1', srcInfo.className)}>
                        {srcInfo.label}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{formatSize(skill.file_size ?? 0)}</span>
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
