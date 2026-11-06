'use client'

// workflow-dev task kind (2026-11-06): the dock 「工作流」 window.
//
// Left side Monaco YAML (syntax highlighted), right side the DAG preview —
// the editor component already exists for workspace workflows; this window
// just swaps the storage backend to the task-home endpoint.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { TaskView } from '@/lib/tasks-api'
import {
  fetchWorkflowDev,
  saveWorkflowDev,
  type WorkflowDevSnapshot,
} from '@/lib/tasks-api'
import { WorkflowEditorTab } from '@/components/workspace/workflow-editor-tab'
import { cn } from '@/lib/utils'

function Badge({
  label,
  tone,
}: {
  label: string
  tone: 'ok' | 'bad' | 'idle' | 'stage'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-none',
        tone === 'ok' && 'bg-emerald-500/15 text-emerald-300',
        tone === 'bad' && 'bg-red-500/15 text-red-300',
        tone === 'idle' && 'bg-white/[0.06] text-pop-dim',
        tone === 'stage' && 'bg-sky-500/15 text-sky-300',
      )}
    >
      {label}
    </span>
  )
}

export function WorkflowDevWindow({
  task,
  onMutated,
}: {
  task: TaskView
  onMutated?: () => void
}) {
  const [snap, setSnap] = useState<WorkflowDevSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fetchWorkflowDev(task.id)
      .then((next) => {
        if (alive) setSnap(next)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [task.id, task.version])

  const handleSave = useCallback(
    async (_path: string, content: string) => {
      if (!snap) return
      setSaving(true)
      try {
        const next = await saveWorkflowDev(task.id, {
          content,
          originalContent: snap.content,
        })
        setSnap(next)
        toast.success('工作流已保存')
        onMutated?.()
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(
          (err as Error & { conflict?: boolean }).conflict
            ? '文件已被外部修改，请关闭重开后再保存'
            : message,
        )
      } finally {
        setSaving(false)
      }
    },
    [snap, task.id, onMutated],
  )

  const state = snap?.state
  const validation = state?.validation
  const simulation = state?.simulation

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflow-dev-window">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        {snap?.ref ? (
          <span className="truncate font-mono text-[11px] text-pop-ink/80">{snap.ref}</span>
        ) : (
          <span className="text-[11px] text-pop-dim">尚未生成工作流</span>
        )}
        {snap?.parsed && (
          <Badge
            tone="stage"
            label={`${snap.parsed.stage}${snap.parsed.version ? ` · v${snap.parsed.version}` : ''}`}
          />
        )}
        {validation && (
          <Badge
            tone={validation.valid ? 'ok' : 'bad'}
            label={validation.valid ? '校验通过' : '校验失败'}
          />
        )}
        {!validation && snap?.content && <Badge tone="idle" label="未校验" />}
        {simulation && (
          <Badge
            tone={simulation.passed ? 'ok' : 'bad'}
            label={simulation.passed ? '仿真通过' : '仿真失败'}
          />
        )}
        {!simulation && snap?.content && <Badge tone="idle" label="未仿真" />}
        <span className="ml-auto shrink-0 text-[10px] text-pop-dim">
          {saving ? '保存中…' : 'Ctrl/Cmd+S 保存'}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[11px] text-pop-dim">
            正在读取工作流…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-red-300">
            {error}
          </div>
        ) : !snap?.content ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <div className="text-[12px] text-pop-ink/80">还没有工作流</div>
            <div className="max-w-[420px] text-[11px] leading-relaxed text-pop-dim">
              在左侧对话里描述要开发的工作流。Agent 会先给出设计并等你确认，生成
              YAML 后会出现在这里，可查看 DAG、直接修改并保存。
            </div>
          </div>
        ) : (
          <WorkflowEditorTab
            filePath={snap.ref ?? 'workflow.yaml'}
            initialContent={snap.content}
            onSave={handleSave}
          />
        )}
      </div>
    </div>
  )
}
