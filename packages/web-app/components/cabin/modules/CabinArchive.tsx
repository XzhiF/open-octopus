'use client'

// S7 归档台（原型 wbArchive docs/cabin-design/index.html 1489-1498）：只读沉淀明细
// （arch-metrics + 知识落点 + open findings）+ 舱生命周期管理（休眠/封存/唤醒/重开）。
// 主体完成 / 沉淀进行中两阶段；编译可能在 done 后继续；裁决在主 chat。findings 读
// getCabinFindings（G4 读时 scoping），任务计数读 useCabinTasks，封存触发 G3 沉淀 hook。

import { useCallback, useEffect, useState } from 'react'
import { Archive, Loader2, Pause, Play, RefreshCw, Sparkle } from 'lucide-react'
import { toast } from 'sonner'
import {
  archiveCabin, dormantCabin, getCabinFindings, reopenCabin, wakeCabin,
} from '@/lib/cabin-api'
import type { KcFindingView } from '@/lib/knowledge/knowledge-center-api'
import { cn } from '@/lib/utils'
import { useCabinContext } from '../cabin-provider'
import { Empty, SBadge, WbH, WbNote, WbSec, useCabinTasks, taskDisplayStatus, type SBadgeColor } from './ui'

const FINDING_STATUS: Record<string, { label: string; color: SBadgeColor }> = {
  open: { label: '待裁决', color: 'purple' },
  resolved: { label: '已解决', color: 'green' },
  ignored: { label: '已忽略', color: 'dim' },
}

function findingDetail(f: KcFindingView): string {
  const d = f.detail as { old?: unknown; new?: unknown }
  if (typeof d.old === 'string' && typeof d.new === 'string') return `旧「${d.old}」→ 新「${d.new}」`
  return f.source ? `${f.kind} · ${f.source}` : f.kind
}

export function CabinArchive() {
  const { cabinId, cabin, view, refresh } = useCabinContext()
  const { tasks } = useCabinTasks(cabinId)
  const [findings, setFindings] = useState<KcFindingView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setFindings(await getCabinFindings(cabinId, 'open')) }
    catch { /* 保留旧值，不假装有数 */ }
  }, [cabinId])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const t = setInterval(() => void load(), 15_000); return () => clearInterval(t) }, [load])

  if (!cabin || !view) return null

  const doneCount = tasks.filter((t) => taskDisplayStatus(t) === 'done').length
  const archivingCount = tasks.filter((t) => t.status === 'archiving' || t.status === 'awaiting_archive').length
  const frozenCount = doneCount + archivingCount
  const openFindings = findings ?? []
  const personCount = view.attention.filter((a) => a.awaiting === 'person').length
  const canDormant = view.health.running === 0 && personCount === 0

  const runAction = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    if (busy) return
    setBusy(key)
    try { await fn(); toast.success(okMsg); await refresh(); await load() }
    catch (err) { toast.error(err instanceof Error ? err.message : '操作失败') }
    finally { setBusy(null) }
  }

  const lifeButton = (key: string, label: string, Icon: typeof Play, fn: () => Promise<unknown>, okMsg: string, primary = false, disabled = false) => (
    <button
      type="button"
      data-testid={`archive-action-${key}`}
      disabled={!!busy || disabled}
      onClick={() => void runAction(key, fn, okMsg)}
      className={cn(
        'flex items-center gap-1 rounded-md border-[1.5px] border-pop-bd px-2 py-1 text-[11px] font-bold transition-colors disabled:opacity-40',
        primary ? 'bg-pop-yellow text-pop-bg hover:opacity-90' : 'text-pop-dim hover:bg-accent hover:text-pop-ink',
      )}
    >
      {busy === key ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
      {label}
    </button>
  )

  return (
    <div data-testid="cabin-archive-body">
      <WbH icon={Archive} title="归档台" cap="沉淀明细 · 生命周期 · 裁决在主 chat" />

      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-pop-dim">舱生命周期</span>
        {cabin.status === 'active' && lifeButton('dormant', '休眠', Pause, () => dormantCabin(cabin.id), '舱已休眠 · 任意消息可唤醒', false, !canDormant)}
        {cabin.status === 'dormant' && lifeButton('wake', '唤醒', RefreshCw, () => wakeCabin(cabin.id), '舱已唤醒 · 工作树自愈', true)}
        {(cabin.status === 'active' || cabin.status === 'dormant') && lifeButton('archive', '封存', Archive, () => archiveCabin(cabin.id), '舱已软封存 · 知识沉淀进行中')}
        {cabin.status === 'archived' && lifeButton('reopen', '重开', Play, () => reopenCabin(cabin.id), '舱已重开 · 工作树自愈', true)}
        {cabin.status === 'active' && !canDormant && <span className="text-[9.5px] text-pop-dim">有运行 / 待人 · 不可休眠</span>}
        {cabin.status === 'archived' && <span className="text-[9.5px] text-pop-dim">软封存 · 任务/工作树/历史全保留 · 重开不重跑门禁</span>}
      </div>

      <div className="arch-metrics" style={{ marginBottom: 14 }} data-testid="archive-metrics">
        <div className="am"><b className="green">✓</b><span>git 同步</span></div>
        <div className="am"><b className="green">{doneCount}</b><span>反思决策</span></div>
        <div className="am"><b className="amber">{view.open_findings}</b><span>术语冲突</span></div>
        <div className="am"><b className="violet">{archivingCount > 0 ? '编译中' : '就绪'}</b><span>知识编译</span></div>
      </div>

      <WbSec>知识落点（沉淀）</WbSec>
      <div className="mb-2 flex items-center gap-2 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle px-2.5 py-2">
        <Sparkle className="size-3 shrink-0 text-pop-pink" />
        <span className="text-[12px] font-bold text-pop-ink">素材包</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-pop-dim">{frozenCount} 类一手素材 → raw/archives/</span>
        <SBadge color={frozenCount > 0 ? 'green' : 'dim'}>{frozenCount > 0 ? '已冻结' : '待沉淀'}</SBadge>
      </div>
      <div className="mb-2 flex items-center gap-2 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle px-2.5 py-2">
        <Sparkle className="size-3 shrink-0 text-pop-purple" />
        <span className="text-[12px] font-bold text-pop-ink">wiki 编译</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-pop-dim">enqueue archive-compile · 串行写队列</span>
        <SBadge color={archivingCount > 0 ? 'purple' : 'dim'} pulse={archivingCount > 0}>{archivingCount > 0 ? '进行中' : '就绪'}</SBadge>
      </div>

      <WbSec cap={`${openFindings.length} 条`}>open findings</WbSec>
      {findings === null ? (
        <Empty>读取沉淀 findings…</Empty>
      ) : openFindings.length === 0 ? (
        <Empty>暂无待裁决 finding · 舱面知识一致</Empty>
      ) : (
        <div data-testid="archive-findings">
          {openFindings.map((f) => {
            const st = FINDING_STATUS[f.status] ?? FINDING_STATUS.open
            return (
              <div key={f.id} className="mb-2 flex items-center gap-2 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle px-2.5 py-2" data-finding-id={f.id}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-bold text-pop-ink">{f.title}</span>
                  <span className="block truncate text-[10.5px] text-pop-dim">{findingDetail(f)}</span>
                </span>
                <SBadge color={st.color}>{st.label}</SBadge>
              </div>
            )
          })}
        </div>
      )}

      <WbNote className="mt-3">主体完成 / 沉淀进行中两阶段；编译可能在 done 后继续。裁决在主 chat · 封存触发舱级知识沉淀（G3）。</WbNote>
    </div>
  )
}