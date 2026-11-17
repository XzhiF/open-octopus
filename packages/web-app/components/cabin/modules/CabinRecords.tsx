'use client'

// classic-v3 记录窗：归档 / 通信 Trace 两个标签（合并原「归档」与「Trace」两扇窗）。
// 两个面板都是只读；写操作仍在主对话或验收台。

import { useState } from 'react'
import { Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WbH } from './ui'
import { CabinArchive } from './CabinArchive'
import { CabinTrace } from './CabinTrace'

const TABS = [
  { key: 'archive', label: '归档' },
  { key: 'trace', label: '通信 Trace' },
] as const

export function CabinRecords() {
  const [tab, setTab] = useState<'archive' | 'trace'>('archive')

  return (
    <div data-testid="cabin-records-body">
      <WbH icon={Archive} title="记录" cap="只读 · 操作都在对话里" />
      <div className="mb-3 flex gap-1 border-b-[1.5px] border-pop-bd" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            data-testid={`cabin-records-tab-${t.key}`}
            onClick={() => setTab(t.key)}
            className={cn(
              '-mb-[1.5px] border-b-2 px-3 py-1.5 text-[12px] transition-colors',
              tab === t.key
                ? 'border-pop-pink font-semibold text-pop-ink'
                : 'border-transparent text-pop-dim hover:text-pop-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'archive' ? <CabinArchive embedded /> : <CabinTrace embedded />}
    </div>
  )
}
