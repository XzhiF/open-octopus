'use client'

import { useState } from 'react'
import { GitMerge, Trash2 } from 'lucide-react'
import type { CloneInfo } from '@/lib/agent/types'
import { cn } from '@/lib/utils'
import { CloneConfigPane } from './CloneConfigPane'
import { CloneFilesPane } from './CloneFilesPane'
import { cloneInitials } from '../overview/CloneTopology'

const TYPE_LABEL: Record<string, string> = {
  'built-in': '系统',
  user: '用户',
}

const STATUS_LABEL: Record<string, string> = {
  active: '活跃',
  idle: '空闲',
  executing: '执行中',
}

const MEMORY_LABEL: Record<string, string> = {
  shared: '共享记忆',
  isolated: '独立记忆',
}

type CloneTab = 'config' | 'files'

interface CloneDetailWindowProps {
  clone: CloneInfo
  onMerge: () => void
  onDelete: () => void
  onRefresh: () => void
}

export function CloneDetailWindow({ clone, onMerge, onDelete, onRefresh }: CloneDetailWindowProps) {
  const [tab, setTab] = useState<CloneTab>('config')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="flex h-9 flex-none items-center gap-2 border-b border-pop-bd bg-pop-paper px-3">
        <span
          className={cn(
            'grid size-5 flex-none place-items-center rounded-[5px] border text-[8px] font-bold',
            clone.status === 'executing'
              ? 'border-pop-cyan/50 bg-pop-cyan-soft text-pop-cyan'
              : clone.status === 'active'
                ? 'border-pop-green/40 bg-pop-green-soft text-pop-green'
                : 'border-pop-bd bg-pop-idle text-pop-dim',
          )}
        >
          {cloneInitials(clone)}
        </span>
        <h2 className="m-0 min-w-0 shrink truncate text-[12.5px] font-bold leading-none">{clone.display_name}</h2>
        <span className="min-w-0 truncate font-mono text-[9px] text-pop-dim">{clone.name}</span>
        <span className="flex-none rounded-[5px] border border-pop-bd bg-pop-idle px-1.5 py-px text-[9px] text-pop-dim">
          {TYPE_LABEL[clone.type] ?? clone.type}
        </span>
        <span
          className={cn(
            'flex-none rounded-[5px] border px-1.5 py-px text-[9px]',
            clone.status === 'executing'
              ? 'border-pop-cyan/35 bg-pop-cyan-soft text-pop-cyan'
              : clone.status === 'active'
                ? 'border-pop-green/35 bg-pop-green-soft text-pop-green'
                : 'border-pop-bd bg-pop-idle text-pop-dim',
          )}
        >
          {STATUS_LABEL[clone.status] ?? clone.status}
        </span>
        <span className="flex-none rounded-[5px] border border-pop-bd bg-pop-idle px-1.5 py-px text-[9px] text-pop-dim">
          {MEMORY_LABEL[clone.memory_scope] ?? clone.memory_scope}
        </span>
        <div className="ml-auto flex flex-none items-center gap-1.5">
          <button
            type="button"
            onClick={onMerge}
            className="inline-flex h-6 items-center gap-1 rounded-[6px] border-[1.5px] border-pop-bd bg-pop-idle px-2 text-[9.5px] font-bold text-pop-ink transition-colors hover:border-pop-purple/45"
          >
            <GitMerge className="size-2.5" />
            合并
          </button>
          {clone.type === 'user' && (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex h-6 items-center gap-1 rounded-[6px] border-[1.5px] border-pop-red/35 bg-pop-pink-soft px-2 text-[9.5px] font-bold text-pop-red transition-colors hover:bg-pop-red/15"
            >
              <Trash2 className="size-2.5" />
              删除
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-none items-center gap-0.5 border-b border-pop-bd bg-pop-paper px-3" role="tablist">
        {([
          ['config', '配置'],
          ['files', '文件'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              '-mb-[1.5px] border-b-[1.5px] px-3 py-1.5 text-[10.5px] transition-colors',
              tab === id
                ? 'border-pop-yellow font-bold text-pop-ink'
                : 'border-transparent text-pop-dim hover:text-pop-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'config' ? (
          <CloneConfigPane clone={clone} onSaved={onRefresh} />
        ) : (
          <CloneFilesPane clone={clone} />
        )}
      </div>
    </div>
  )
}
