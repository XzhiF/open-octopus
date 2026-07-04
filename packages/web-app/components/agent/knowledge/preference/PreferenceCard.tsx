'use client'

/**
 * Single preference card — renders either the global scope or one org.
 *
 * States:
 *   - collapsed: title row + first-line preview only
 *   - expanded + view: markdown rendered + [编辑] button
 *   - expanded + edit: textarea + [保存][取消]
 *
 * Exposes imperative handle so the parent toolbar can drive
 * "全部收起 / 全部展开" without lifting state.
 */

import { useState, useEffect, useCallback, useImperativeHandle, forwardRef, useRef } from 'react'
import { ChevronDown, ChevronUp, Edit3, Save, X, Globe2, Building2, Loader2, FileText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentEmptyState } from '@/components/agent/shared/AgentEmptyState'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { getPreference, updatePreference } from '@/lib/knowledge/api'

export type PreferenceCardKind = 'global' | 'org'

export interface PreferenceCardProps {
  kind: PreferenceCardKind
  /** org name — required when kind === 'org', ignored when 'global' */
  orgName?: string
  /** initial expanded state (parent controls default) */
  defaultExpanded?: boolean
}

export interface PreferenceCardHandle {
  expand: () => void
  collapse: () => void
  isExpanded: () => boolean
}

export const PreferenceCard = forwardRef<PreferenceCardHandle, PreferenceCardProps>(
  function PreferenceCard({ kind, orgName, defaultExpanded = true }, ref) {
    const [expanded, setExpanded] = useState(defaultExpanded)
    const [isEditing, setIsEditing] = useState(false)
    const [content, setContent] = useState('')
    const [draft, setDraft] = useState('')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const initialLoadRef = useRef(true)

    const scope: 'global' | 'org' = kind === 'global' ? 'global' : 'org'
    const orgId = kind === 'org' ? orgName : undefined
    const stableKey = kind === 'global' ? '__global__' : `org:${orgName}`

    // Fetch on mount (and when identity changes — e.g. a parent re-renders
    // a new org into this slot).
    useEffect(() => {
      let cancelled = false
      setLoading(true)
      setIsEditing(false)
      getPreference(scope, orgId)
        .then((res) => {
          if (cancelled) return
          const text = res.content ?? ''
          setContent(text)
          if (initialLoadRef.current) {
            initialLoadRef.current = false
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
          toast.error(err instanceof Error ? err.message : '加载偏好失败')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stableKey])

    useImperativeHandle(
      ref,
      () => ({
        expand: () => setExpanded(true),
        collapse: () => {
          setExpanded(false)
          // Auto-cancel edit when collapsing to avoid hidden unsaved state.
          setIsEditing(false)
          setDraft('')
        },
        isExpanded: () => expanded,
      }),
      [expanded],
    )

    const startEditing = useCallback(() => {
      setDraft(content)
      setIsEditing(true)
    }, [content])

    const cancelEditing = useCallback(() => {
      setIsEditing(false)
      setDraft('')
    }, [])

    const handleSave = useCallback(async () => {
      try {
        setSaving(true)
        await updatePreference(scope, draft, orgId)
        setContent(draft)
        setIsEditing(false)
        toast.success('偏好已保存')
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : '保存失败')
      } finally {
        setSaving(false)
      }
    }, [scope, draft, orgId])

    // ── Presentation ────────────────────────────────────────────────

    const Icon = kind === 'global' ? Globe2 : Building2
    const accentClass =
      kind === 'global'
        ? 'border-l-knowledge-primary'
        : 'border-l-sky-500 dark:border-l-sky-400'
    const title = kind === 'global' ? '全局偏好' : orgName ?? '组织偏好'
    const preview = content
      ? content.split('\n').find((l) => l.trim())?.slice(0, 80) ?? ''
      : ''
    const charCount = content.length

    return (
      <section
        aria-label={title}
        className={cn(
          'rounded-lg border border-agent-divider bg-agent-surface overflow-hidden',
          'border-l-[3px]',
          accentClass,
          'transition-shadow duration-200',
          expanded && 'shadow-sm',
        )}
      >
        {/* Header row — always visible */}
        <header
          className={cn(
            'flex items-center gap-3 px-4 py-3 cursor-pointer select-none',
            'hover:bg-agent-surface/60 transition-colors',
          )}
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon className="size-4 text-knowledge-primary shrink-0" aria-hidden="true" />
          <span className="font-medium text-sm text-foreground truncate">
            {title}
          </span>
          {!loading && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {charCount === 0 ? '空' : `${charCount} 字符`}
            </span>
          )}
          {loading && <Skeleton className="h-3 w-12" />}
          <span className="flex-1" aria-hidden="true" />
          {!expanded && preview && !loading && (
            <span className="text-xs text-muted-foreground truncate max-w-[40%] hidden md:inline">
              {preview}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
            aria-label={expanded ? '收起' : '展开'}
          >
            {expanded ? (
              <ChevronUp className="size-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-4" aria-hidden="true" />
            )}
          </Button>
        </header>

        {/* Body — only rendered when expanded */}
        {expanded && (
          <div className="px-4 pb-4 pt-1 border-t border-agent-divider">
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            ) : isEditing ? (
              <div className="space-y-3">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="在此编辑 Markdown 格式的偏好配置…"
                  className="min-h-[240px] font-mono text-sm"
                  autoFocus
                />
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelEditing}
                    disabled={saving}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                    取消
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={saving}
                    className="bg-knowledge-primary hover:bg-knowledge-primary-hover text-knowledge-primary-foreground"
                  >
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Save className="size-3.5" aria-hidden="true" />
                    )}
                    保存
                  </Button>
                </div>
              </div>
            ) : content ? (
              <div className="space-y-3">
                <article className="preference-prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {content}
                  </ReactMarkdown>
                </article>
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={startEditing}>
                    <Edit3 className="size-3.5" aria-hidden="true" />
                    编辑
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <AgentEmptyState
                  icon={FileText}
                  title="暂无偏好配置"
                  description="点击下方“编辑”添加此范围的偏好内容。偏好会以 Markdown 形式注入到 agent 的 system prompt 中。"
                />
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={startEditing}>
                    <Edit3 className="size-3.5" aria-hidden="true" />
                    编辑
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    )
  },
)
