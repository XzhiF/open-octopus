'use client'

// 变更窗（原型 wbChanges）：任务总账 · 跨仓聚合（round-diff scope=task，现有
// round-evidence-service 零改动）。phase 明细下钻 → 任务级 ChangesWindow。

import { useCallback, useEffect, useState } from 'react'
import { Folder, GitCompare } from 'lucide-react'
import { getCabinChanges, type CabinChangesSummary } from '@/lib/cabin-api'
import { useCabinContext } from '../cabin-provider'
import { Empty, SBadge, WbH, WbNote, WbSec, openTaskInChat } from './ui'

export function CabinChanges() {
  const { cabinId } = useCabinContext()
  const [data, setData] = useState<CabinChangesSummary | null>(null)
  const [tab, setTab] = useState<'task' | 'phase'>('task')

  const load = useCallback(async () => {
    try {
      setData(await getCabinChanges(cabinId))
    } catch {
      setData(null)
    }
  }, [cabinId])

  useEffect(() => { void load() }, [load])

  const tot = data?.totals ?? { commits: 0, additions: 0, dels: 0, files: 0 }

  return (
    <div data-testid="cabin-changes-body">
      <WbH icon={GitCompare} title="变更" cap="任务总账 · 跨仓聚合" />
      <div className="mb-3 flex gap-1 border-b-[1.5px] border-pop-bd">
        {([['task', '任务总账'], ['phase', 'phase 总账']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-[1.5px] border-b-2 px-3 py-1.5 text-[12px] ${
              tab === key ? 'border-pop-pink font-semibold text-pop-ink' : 'border-transparent text-pop-dim hover:text-pop-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {!data ? (
        <Empty>读取变更总账…</Empty>
      ) : tab === 'task' ? (
        <>
          <div className="my-2.5 grid grid-cols-4 gap-2">
            <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5 text-center">
              <b className="block text-[18px] text-pop-ink">{tot.commits}</b>
              <span className="text-[9.5px] text-pop-dim">commits</span>
            </div>
            <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5 text-center">
              <b className="block text-[18px] text-pop-green">+{tot.additions}</b>
              <span className="text-[9.5px] text-pop-dim">新增</span>
            </div>
            <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5 text-center">
              <b className="block text-[18px] text-pop-red">−{tot.dels}</b>
              <span className="text-[9.5px] text-pop-dim">删除</span>
            </div>
            <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5 text-center">
              <b className="block text-[18px] text-pop-ink">{tot.files}</b>
              <span className="text-[9.5px] text-pop-dim">文件</span>
            </div>
          </div>
          <WbSec>按仓库</WbSec>
          {data.repos.length === 0 ? (
            <WbNote>暂无跨仓变更</WbNote>
          ) : data.repos.map((r) => (
            <div key={r.name} className="mt-2 flex items-center gap-3 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-paper px-3 py-2">
              <span className="flex items-center gap-1.5 text-[11.5px] text-pop-cyan">
                <Folder className="size-3" />{r.name}
              </span>
              <span className="flex-1 text-[10.5px] text-pop-dim">{r.tasks} 任务</span>
              <SBadge color="dim">{r.commits} commits</SBadge>
            </div>
          ))}
          <WbNote className="mt-2.5">per-repo 聚合 · expired 降级 · 锚定 start..end commit。</WbNote>
        </>
      ) : (
        <>
          {data.tasks.length === 0 ? (
            <Empty>暂无任务变更</Empty>
          ) : data.tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              data-changes-task={t.id}
              onClick={() => openTaskInChat(t.id, 'changes')}
              className="mt-2 flex w-full items-center gap-3 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-paper px-3 py-2 text-left hover:border-pop-pink"
            >
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-pop-ink">{t.name}</span>
              <span className="text-[10.5px] text-pop-dim">
                {t.available ? `${t.commits} commits · +${t.additions} −${t.dels}` : '无轮次证据'}
              </span>
              <SBadge color={t.available ? 'cyan' : 'dim'}>{t.available ? 'phase 明细' : '—'}</SBadge>
            </button>
          ))}
          <WbNote className="mt-2.5">点任务行 → 任务级变更窗（phase 两轮总账 + 实物 diff）。</WbNote>
        </>
      )}
    </div>
  )
}
