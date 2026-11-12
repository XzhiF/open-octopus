'use client'

// S3 座舱 = 原型 wbOverview：wb-h（name · 座舱 + attention-first cap）+ 四 stat
// （运行中/需要你/并行工作树/累计消耗）+ 舱生命周期条 + 「需要你」attention 列表
// （服务端 deriveCabinView 已 person-first + priority 排序，K3 只渲染不重派生）
// + 迭代线（进度派生自成员任务）。点 attention → 对话底座定位任务 / 知识窗。
// 累计消耗 = C7 舱级聚合（chat+任务+子代理，grand 口径），10s 轮询。

import { useEffect, useState } from 'react'
import { Archive, ChevronRight, LayoutGrid, Loader2, Play, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { CabinAttentionItem } from '@octopus/shared'
import {
  archiveCabin, getCabinUsage, initCabin, listCabinWorktrees, reopenCabin, wakeCabin,
} from '@/lib/cabin-api'
import { formatCost } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import { cn } from '@/lib/utils'
import { useCabinContext } from './cabin-provider'
import {
  ATTENTION_AWAITING_META, ATTENTION_STAGE_META, CABIN_STATUS_META,
} from './cabin-meta'

const ITERATION_STATUS_LABEL: Record<string, string> = {
  pending: '待启动',
  active: '进行中',
  done: '已完成',
}

export function CabinOverview() {
  const { cabinId, cabin, view, refresh, openModule } = useCabinContext()
  const currency = useBillingCurrency()
  const [busy, setBusy] = useState<string | null>(null)
  const [worktreeStats, setWorktreeStats] = useState<{ trees: number; repos: number } | null>(null)
  const [grandCost, setGrandCost] = useState<{ usd: number | null; complete: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    listCabinWorktrees(cabinId)
      .then((groups) => {
        if (!alive) return
        setWorktreeStats({
          trees: groups.reduce((n, g) => n + g.worktrees.length, 0),
          repos: groups.length,
        })
      })
      .catch(() => { if (alive) setWorktreeStats(null) })
    return () => { alive = false }
  }, [cabinId, cabin?.status])

  useEffect(() => {
    let alive = true
    const load = () => {
      getCabinUsage(cabinId)
        .then((u) => { if (alive) setGrandCost(u.grand.totals.cost) })
        .catch(() => { /* 保留旧值，不假装有数 */ })
    }
    load()
    const timer = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(timer) }
  }, [cabinId])

  if (!cabin || !view) return null

  const runAction = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    if (busy) return
    setBusy(key)
    try {
      await fn()
      toast.success(okMsg)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const openAttention = (item: CabinAttentionItem) => {
    if (item.deep_link?.startsWith('finding:')) {
      openModule('knowledge')
      return
    }
    if (item.task_id) {
      window.dispatchEvent(new CustomEvent('octopus:open-task', {
        detail: { taskId: item.task_id, ...(item.stage === 'review' ? { view: 'acceptance' } : {}) },
      }))
    }
  }

  const personCount = view.attention.filter((a) => a.awaiting === 'person').length
  const meta = CABIN_STATUS_META[cabin.status]

  const lifeButton = (key: string, label: string, Icon: typeof Play, fn: () => Promise<unknown>, okMsg: string, primary = false) => (
    <button
      type="button"
      data-testid={`cabin-action-${key}`}
      disabled={!!busy}
      onClick={() => void runAction(key, fn, okMsg)}
      className={cn(
        'flex items-center gap-1 rounded-md border-[1.5px] border-pop-bd px-2 py-1 text-[11px] font-bold transition-colors disabled:opacity-50',
        primary ? 'bg-pop-yellow text-pop-bg hover:opacity-90' : 'text-pop-dim hover:bg-accent hover:text-pop-ink',
      )}
    >
      {busy === key ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
      {label}
    </button>
  )

  return (
    <div className="flex flex-col gap-3.5" data-testid="cabin-overview">
      <div className="flex items-center gap-2">
        <LayoutGrid className="size-4 shrink-0 text-pop-dim" />
        <h3 className="min-w-0 truncate text-[14px] font-semibold text-pop-ink">{cabin.name} · 座舱</h3>
        <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[9.5px] font-bold', meta.badge)} data-testid="cabin-status-badge">
          {meta.label}
        </span>
        <span className="ml-auto shrink-0 text-[10.5px] text-pop-dim">attention-first · 只呈现需要人的</span>
      </div>

      <div className="grid grid-cols-4 gap-2.5 max-[900px]:grid-cols-2" data-testid="cabin-statgrid">
        <div className="rounded-lg border-[1.5px] border-pop-bd bg-white/[0.02] px-2.5 py-2">
          <div className="mb-1 text-[10.5px] text-pop-dim">运行中</div>
          <div className="text-[18px] font-black text-pop-purple" data-testid="cabin-health-running">{view.health.running}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[9.5px] text-pop-dim">
            <span className={cn('size-1.5 rounded-full', view.health.running > 0 ? 'bg-pop-green animate-pulse' : 'bg-pop-dim/50')} />
            <span data-testid="cabin-health-workers">{view.health.workers}/{view.health.max}</span> 执行器
          </div>
        </div>
        <div className="rounded-lg border-[1.5px] border-pop-bd bg-white/[0.02] px-2.5 py-2">
          <div className="mb-1 text-[10.5px] text-pop-dim">需要你</div>
          <div className="text-[18px] font-black text-pop-amber" data-testid="cabin-stat-attention">{view.attention.length}</div>
          <div className="mt-0.5 text-[9.5px] text-pop-dim">按「等谁」分级</div>
        </div>
        <div className="rounded-lg border-[1.5px] border-pop-bd bg-white/[0.02] px-2.5 py-2">
          <div className="mb-1 text-[10.5px] text-pop-dim">并行工作树</div>
          <div className="text-[18px] font-black text-pop-cyan" data-testid="cabin-stat-worktrees">{worktreeStats?.trees ?? '—'}</div>
          <div className="mt-0.5 text-[9.5px] text-pop-dim">{worktreeStats ? `${worktreeStats.repos} 仓库` : '读取中'}</div>
        </div>
        <div className="rounded-lg border-[1.5px] border-pop-bd bg-white/[0.02] px-2.5 py-2">
          <div className="mb-1 text-[10.5px] text-pop-dim">累计消耗</div>
          <div className="text-[18px] font-black text-pop-ink" data-testid="cabin-stat-cost">
            {grandCost ? formatCost(grandCost.usd, grandCost.complete, currency) : '—'}
          </div>
          <div className="mt-0.5 text-[9.5px] text-pop-dim">chat+任务+子代理</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-pop-dim">舱生命周期</span>
        {cabin.status === 'draft' && lifeButton('init', '开始初始化', Play, () => initCabin(cabin.id), '初始化已启动', true)}
        {cabin.status === 'initializing' && <span className="text-[10px] text-pop-amber">门禁进行中…</span>}
        {cabin.status === 'dormant' && lifeButton('wake', '唤醒', RefreshCw, () => wakeCabin(cabin.id), '舱已唤醒', true)}
        {cabin.status === 'dormant' && <span className="text-[10px] text-pop-dim">无活任务 · 任意消息可唤醒</span>}
        {(cabin.status === 'active' || cabin.status === 'dormant') && lifeButton('archive', '封存', Archive, () => archiveCabin(cabin.id), '舱已封存（可重开）')}
        {cabin.status === 'archived' && lifeButton('reopen', '重开', Play, () => reopenCabin(cabin.id), '舱已重开', true)}
        {cabin.status === 'archived' && (
          <span className="text-[10px] text-pop-dim">软封存 · 任务/工作树/历史全保留，重开不重跑门禁</span>
        )}
      </div>

      <section>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] font-bold text-pop-ink">需要你</span>
          <span className="text-[10px] text-pop-dim">{view.attention.length} 项</span>
          {personCount > 0 && (
            <span className="rounded-full bg-pop-yellow px-1.5 text-[9.5px] font-black text-pop-bg" data-testid="cabin-person-count">
              {personCount} 等你
            </span>
          )}
        </div>
        {view.attention.length === 0 ? (
          <div className="rounded-lg border-[1.5px] border-pop-bd bg-white/[0.02] px-3 py-4 text-center text-[12px] text-pop-dim" data-testid="cabin-attention-empty">
            没有需要你的事。舱在自主推进。
          </div>
        ) : (
          <ul className="space-y-1.5" data-testid="cabin-attention-queue">
            {view.attention.map((item, index) => {
              const stage = ATTENTION_STAGE_META[item.stage]
              const awaiting = ATTENTION_AWAITING_META[item.awaiting]
              const focused = index === 0 && item.awaiting === 'person'
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    data-attention-id={item.id}
                    data-focused={focused ? 'true' : undefined}
                    onClick={() => openAttention(item)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg border-[1.5px] px-2.5 py-2 text-left transition-colors hover:bg-accent/60',
                      focused ? 'border-pop-yellow/60 bg-pop-yellow/[0.06]' : 'border-pop-bd bg-white/[0.02]',
                    )}
                  >
                    <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[9.5px] font-bold', stage.tone)}>{stage.label}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-bold text-pop-ink">{item.title}</span>
                      {(item.question || item.detail || item.repo) && (
                        <span className="block truncate text-[10.5px] text-pop-dim">
                          {item.question ?? item.detail}
                          {item.repo ? ` · ${item.repo}` : ''}{item.wt ? ` / ${item.wt}` : ''}
                        </span>
                      )}
                    </span>
                    <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold', awaiting.tone)}>{awaiting.label}</span>
                    {item.priority > 0 && <span className="shrink-0 text-[9.5px] font-bold text-pop-dim">P{item.priority}</span>}
                    <ChevronRight className="size-3 shrink-0 text-pop-dim" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-1.5 text-[11px] font-bold text-pop-ink">迭代</div>
        {view.iterations.length === 0 ? (
          <div className="rounded-lg border-[1.5px] border-pop-bd bg-white/[0.02] px-3 py-3 text-[11.5px] text-pop-dim">
            还没有迭代 · 初始化第 7 项门禁会提案 M1
          </div>
        ) : (
          <ul className="space-y-1.5" data-testid="cabin-iteration-line">
            {view.iterations.map((it) => (
              <li
                key={it.id}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border-[1.5px] px-2.5 py-2',
                  it.status === 'active' ? 'border-pop-yellow/50 bg-pop-yellow/[0.05]' : 'border-pop-bd bg-white/[0.02]',
                )}
                data-iteration-code={it.code}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-pop-cyan/15 font-mono text-[10.5px] font-black text-pop-cyan">
                  {it.code}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-bold text-pop-ink">{it.name}</span>
                  <span className="block text-[9.5px] text-pop-dim">
                    {it.task_count ?? 0} 任务 · {ITERATION_STATUS_LABEL[it.status] ?? it.status}
                  </span>
                </span>
                <span className="w-24 shrink-0">
                  <span className="block text-right font-mono text-[9.5px] text-pop-dim">{it.progress ?? 0}%</span>
                  <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <span
                      className={cn('block h-full rounded-full', it.status === 'active' ? 'bg-pop-yellow' : 'bg-pop-cyan')}
                      style={{ width: `${Math.min(100, Math.max(0, it.progress ?? 0))}%` }}
                      data-testid={`cabin-iteration-progress-${it.code}`}
                    />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}