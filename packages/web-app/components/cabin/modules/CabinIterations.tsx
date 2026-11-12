'use client'

// S6 迭代窗（原型 wbIterations）：里程碑线 + 成员 tcard。成员/进度派生自
// tasks.iteration_id + deriveTaskView（K3），不存 taskIds/progress。
// P4：人 curate 的 CRUD —— 新建/改名/计划态/重排/删除（删除自动解绑成员任务）。

import { useState } from 'react'
import { Layers, Plus, ChevronUp, ChevronDown, Pencil, X, Check } from 'lucide-react'
import { toast } from 'sonner'
import type { CabinIteration } from '@octopus/shared'
import { createCabinIteration, patchCabinIteration, deleteCabinIteration } from '@/lib/cabin-api'
import { useCabinContext } from '../cabin-provider'
import { useCabinTasks, taskDisplayStatus, IterLine, TCard, WbH, WbNote, WBtn, SBadge, Empty, openTaskInChat, type SBadgeColor } from './ui'

const ITER_STATUS: Record<string, { label: string; color: SBadgeColor }> = {
  pending: { label: '待启动', color: 'dim' },
  active: { label: '进行中', color: 'violet' },
  done: { label: '已完成', color: 'green' },
}

export function CabinIterations() {
  const { cabinId, view, refresh } = useCabinContext()
  const { tasks, loading } = useCabinTasks(cabinId)
  const iterations = view?.iterations ?? []

  const [creating, setCreating] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      await refresh()
      if (okMsg) toast.success(okMsg)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const submitCreate = () => {
    const c = code.trim()
    const n = name.trim()
    if (!c || !n) { toast.error('代号与名称都要填'); return }
    void run(async () => {
      await createCabinIteration(cabinId, { code: c, name: n, sort_order: iterations.length })
      setCreating(false)
      setCode('')
      setName('')
    }, `已建迭代 ${c}`)
  }

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= iterations.length) return
    const next = [...iterations]
    const [item] = next.splice(idx, 1)
    next.splice(target, 0, item)
    void run(async () => {
      for (let i = 0; i < next.length; i++) {
        if (next[i].sort_order !== i) {
          await patchCabinIteration(cabinId, next[i].id, { sort_order: i })
        }
      }
    })
  }

  return (
    <div data-testid="cabin-iterations-body">
      <WbH icon={Layers} title="迭代" cap="里程碑 · 成员/进度派生自任务">
        <WBtn pri testId="iter-new" onClick={() => setCreating((v) => !v)} title="新建迭代">
          <Plus className="size-3" />新建迭代
        </WBtn>
      </WbH>
      <WbNote className="mb-3">
        迭代只存里程碑身份（code/name/计划态）；成员与进度<b className="text-pop-ink">派生</b>自任务
        （tasks.iteration_id 单写者 + deriveTaskView），不在此存储 taskIds/progress。
      </WbNote>

      {creating && (
        <div className="mb-3 flex items-center gap-2 rounded-[9px] border-[1.5px] border-pop-pink/50 bg-pop-idle px-3 py-2.5" data-testid="iter-create-form">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="M2"
            aria-label="迭代代号"
            className="ui-font w-[64px] rounded-md border border-pop-bd bg-pop-bg px-2 py-1 text-[11px] text-pop-ink outline-none focus:border-pop-pink"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="里程碑名称，如「渠道接入」"
            aria-label="迭代名称"
            onKeyDown={(e) => { if (e.key === 'Enter') submitCreate() }}
            className="ui-font flex-1 rounded-md border border-pop-bd bg-pop-bg px-2 py-1 text-[11px] text-pop-ink outline-none focus:border-pop-pink"
          />
          <WBtn pri testId="iter-create-submit" onClick={submitCreate} disabled={busy}>
            <Check className="size-3" />创建
          </WBtn>
          <WBtn onClick={() => setCreating(false)}>取消</WBtn>
        </div>
      )}

      {iterations.length === 0 && !creating ? (
        <Empty>暂无迭代 · 点「新建迭代」或在主对话让调度者规划里程碑</Empty>
      ) : iterations.map((it, idx) => {
        const members = tasks.filter((t) => t.iteration_id === it.id)
        const st = ITER_STATUS[it.status] ?? ITER_STATUS.pending
        return (
          <div key={it.id} data-iteration-block={it.code}>
            <IterLine
              code={it.code}
              name={it.name}
              meta={`${members.length} 任务 · ${it.progress ?? 0}%`}
              pct={it.progress ?? 0}
              active={it.status === 'active'}
            />
            <div className="mb-2 mt-1 flex flex-wrap items-center gap-1.5" data-testid={`iter-controls-${it.code}`}>
              <SBadge color={st.color}>{st.label}</SBadge>
              <select
                value={it.status}
                aria-label={`${it.code} 计划态`}
                data-testid={`iter-status-${it.code}`}
                disabled={busy}
                onChange={(e) => {
                  const status = e.target.value as CabinIteration['status']
                  void run(() => patchCabinIteration(cabinId, it.id, { status }), `${it.code} → ${ITER_STATUS[status].label}`)
                }}
                className="ui-font rounded-md border border-pop-bd bg-pop-idle px-1.5 py-[3px] text-[10.5px] text-pop-dim outline-none focus:border-pop-pink"
              >
                <option value="pending">待启动</option>
                <option value="active">进行中</option>
                <option value="done">已完成</option>
              </select>
              <WBtn title="上移" testId={`iter-up-${it.code}`} onClick={() => move(idx, -1)} disabled={busy || idx === 0}>
                <ChevronUp className="size-3" />
              </WBtn>
              <WBtn title="下移" testId={`iter-down-${it.code}`} onClick={() => move(idx, 1)} disabled={busy || idx === iterations.length - 1}>
                <ChevronDown className="size-3" />
              </WBtn>
              <WBtn title="改名" testId={`iter-rename-${it.code}`} onClick={() => { setRenamingId(it.id); setRenameDraft(it.name) }}>
                <Pencil className="size-3" />
              </WBtn>
              {confirmDeleteId === it.id ? (
                <>
                  <WBtn pri testId={`iter-delete-confirm-${it.code}`} disabled={busy} onClick={() => {
                    void run(async () => {
                      const res = await deleteCabinIteration(cabinId, it.id)
                      setConfirmDeleteId(null)
                      if (res.unbound > 0) toast.success(`已删 ${it.code} · ${res.unbound} 个任务解绑`)
                    }, `已删迭代 ${it.code}`)
                  }}>
                    <X className="size-3" />确认删除
                  </WBtn>
                  <WBtn onClick={() => setConfirmDeleteId(null)}>取消</WBtn>
                </>
              ) : (
                <WBtn title="删除迭代（成员任务自动解绑）" testId={`iter-delete-${it.code}`} onClick={() => setConfirmDeleteId(it.id)}>
                  <X className="size-3" />
                </WBtn>
              )}
              {renamingId === it.id && (
                <span className="flex items-center gap-1.5">
                  <input
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    aria-label="新名称"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && renameDraft.trim()) {
                        void run(async () => {
                          await patchCabinIteration(cabinId, it.id, { name: renameDraft.trim() })
                          setRenamingId(null)
                        }, '已改名')
                      }
                    }}
                    className="ui-font w-[180px] rounded-md border border-pop-bd bg-pop-bg px-2 py-1 text-[11px] text-pop-ink outline-none focus:border-pop-pink"
                  />
                  <WBtn pri disabled={busy || !renameDraft.trim()} onClick={() => {
                    void run(async () => {
                      await patchCabinIteration(cabinId, it.id, { name: renameDraft.trim() })
                      setRenamingId(null)
                    }, '已改名')
                  }}>
                    <Check className="size-3" />
                  </WBtn>
                </span>
              )}
            </div>
            {members.length > 0 && (
              <div className="mb-4 mt-2 grid grid-cols-3 gap-2">
                {members.map((t) => (
                  <TCard key={t.id} task={t} onClick={() => openTaskInChat(t.id)} />
                ))}
              </div>
            )}
            {members.length === 0 && !loading && (
              <WbNote className="mb-3">该迭代暂无成员任务 · 派发任务时指定 iteration_id 即入列</WbNote>
            )}
          </div>
        )
      })}
      {loading && iterations.length === 0 && <Empty>读取任务…</Empty>}
      {tasks.length > 0 && iterations.length > 0 && (
        <WbNote className="mt-2">
          {tasks.filter((t) => !t.iteration_id).length} 个任务未归属迭代 · {tasks.filter((t) => taskDisplayStatus(t) === 'done').length} 完成
        </WbNote>
      )}
    </div>
  )
}