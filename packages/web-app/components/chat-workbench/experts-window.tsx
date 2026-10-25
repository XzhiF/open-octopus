'use client'

import { useCallback, useEffect, useState } from 'react'
import { Pencil, Users } from 'lucide-react'
import { toast } from 'sonner'
import { EXPERT_ROLES, expertLabel } from '@/lib/expert-roles'
import { getTask, updateTask, type TaskDetail, type TaskView } from '@/lib/tasks-api'
import { CloseLightGlyph } from '@/components/ui/close-light'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

interface ExpertsWindowProps {
  task: TaskView
  onMutated?: () => void
}

/** Per-phase fixed expert roster. Editable while drafting, read-only after enqueue. */
export function ExpertsWindow({ task, onMutated }: ExpertsWindowProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [editingPhase, setEditingPhase] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setDetail(await getTask(task.id))
    } catch {
      /* keep last */
    }
  }, [task.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const phases = detail?.task_spec?.phases ?? []
  const editable = task.status === 'draft'
  const editing = phases.find((phase) => phase.index === editingPhase) ?? null

  const openEditor = (phaseIndex: number) => {
    const phase = phases.find((p) => p.index === phaseIndex)
    setSelected(new Set(phase?.experts ?? []))
    setEditingPhase(phaseIndex)
  }

  const save = async () => {
    if (!detail || !editing) return
    setBusy(true)
    try {
      const nextPhases = phases.map((phase) =>
        phase.index === editing.index
          ? { ...phase, experts: selected.size > 0 ? [...selected] : undefined }
          : phase,
      )
      const updated = await updateTask(
        task.id,
        { task_spec: { ...detail.task_spec, phases: nextPhases } },
        detail.version,
      )
      setDetail({ ...detail, ...updated, task_spec: updated.task_spec })
      setEditingPhase(null)
      toast.success('专家计划已保存')
      onMutated?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存专家失败')
    } finally {
      setBusy(false)
    }
  }

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-pop-dim" />
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-pop-bg">
      <div className="mx-auto w-full max-w-2xl px-5 py-5">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-pop-purple" strokeWidth={1.8} />
          <h2 className="text-[14px] font-semibold text-pop-ink">固定专家</h2>
          <span className="text-[10.5px] text-pop-dim">
            {editable ? '入队后锁定' : '已锁定 · 只读'}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-pop-dim">
          每个 phase 可以绑定一位或多位专家；执行时作为该阶段的固定角色上下文。
        </p>

        {phases.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-white/[0.08] px-4 py-8 text-center text-[11.5px] text-pop-dim">
            还没有 phases。先在对话里让 task-author 拆阶段，再回来配置专家。
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {phases.map((phase) => {
              const experts = phase.experts ?? []
              return (
                <div
                  key={phase.index}
                  className="rounded-[10px] border border-white/[0.07] bg-white/[0.02] px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-pop-dim">P{phase.index}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-pop-ink">
                      {phase.name}
                    </span>
                    {editable && (
                      <button
                        type="button"
                        onClick={() => openEditor(phase.index)}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-pop-dim transition-colors hover:bg-white/[0.06] hover:text-pop-ink"
                      >
                        <Pencil className="size-3" /> 编辑
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {experts.length === 0 ? (
                      <span className="text-[10.5px] text-pop-dim/60">未指定专家</span>
                    ) : (
                      experts.map((name) => (
                        <span
                          key={name}
                          className="rounded-full border border-pop-purple/30 bg-pop-purple-soft/60 px-2 py-0.5 text-[10.5px] text-pop-purple"
                        >
                          {expertLabel(name)}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditingPhase(null) }}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="ui-font max-w-[480px] gap-0 overflow-hidden rounded-2xl border border-white/[0.10] bg-pop-bg p-0 sm:max-w-[480px]"
        >
          <DialogTitle className="sr-only">选择 Phase 专家</DialogTitle>
          <div className="flex h-12 items-center gap-3 border-b border-white/[0.06] px-3">
            <button
              type="button"
              aria-label="关闭专家选择"
              onClick={() => setEditingPhase(null)}
              className="grid size-6 shrink-0 place-items-center rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-pop-yellow"
            >
              <CloseLightGlyph />
            </button>
            <div>
              <div className="text-[13px] font-semibold text-pop-ink">Phase 专家</div>
              <div className="text-[10.5px] text-pop-dim">{editing?.name ?? ''} · 可多选</div>
            </div>
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-3">
            <div className="space-y-1">
              {EXPERT_ROLES.map((role) => {
                const on = selected.has(role.id)
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => {
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(role.id)) next.delete(role.id)
                        else next.add(role.id)
                        return next
                      })
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-[8px] px-2.5 py-2 text-left transition-colors',
                      on ? 'bg-pop-purple-soft/70' : 'hover:bg-white/[0.04]',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border',
                        on ? 'border-pop-purple bg-pop-purple text-pop-bg' : 'border-white/20',
                      )}
                    >
                      {on && <span className="text-[9px] font-bold">✓</span>}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-medium text-pop-ink">
                        {role.label}
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-[10.5px] text-pop-dim">
                        {role.desc}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
            <Button size="sm" variant="ghost" onClick={() => setEditingPhase(null)} disabled={busy}>
              取消
            </Button>
            <Button size="sm" variant="pop" onClick={() => void save()} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
