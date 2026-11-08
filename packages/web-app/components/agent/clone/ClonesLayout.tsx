'use client'

import { useCallback, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from '@/lib/app-navigation'
import { Plus, Search, Users } from 'lucide-react'
import { useAgentClones } from '@/hooks/useAgentClones'
import type { CloneInfo } from '@/lib/agent/types'
import { CloneCreateWizard } from './CloneCreateWizard'
import { CloneDeleteDialog } from './CloneDeleteDialog'
import { CloneMergeDialog } from './CloneMergeDialog'
import { CloneDetailWindow } from './CloneDetailWindow'
import { CloneStatusDot, cloneInitials } from '../overview/CloneTopology'
import { cn } from '@/lib/utils'

const MEMORY_LABEL: Record<string, string> = {
  shared: '共享记忆',
  isolated: '独立记忆',
}

type CloneFilter = 'all' | 'built-in' | 'user'

export function ClonesLayout() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { clones, loading, error, refetch } = useAgentClones()

  const [filter, setFilter] = useState<CloneFilter>('all')
  const [query, setQuery] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<CloneInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CloneInfo | null>(null)

  const selectedName = searchParams.get('clone')
  const selected = clones.find((clone) => clone.name === selectedName) ?? null

  const select = useCallback((name: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (name) params.set('clone', name)
    else params.delete('clone')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
  }, [pathname, router, searchParams])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return clones.filter((clone) => {
      if (filter !== 'all' && clone.type !== filter) return false
      if (!q) return true
      return (
        clone.name.toLowerCase().includes(q)
        || clone.display_name.toLowerCase().includes(q)
      )
    })
  }, [clones, filter, query])

  const system = visible.filter((clone) => clone.type === 'built-in')
  const user = visible.filter((clone) => clone.type === 'user')
  const systemCount = clones.filter((clone) => clone.type === 'built-in').length
  const userCount = clones.filter((clone) => clone.type === 'user').length

  return (
    <div className="flex h-full min-h-0 bg-pop-bg">
      {/* ── 左：分身列表 ─────────────────────────────────────────── */}
      <aside className="flex w-[236px] flex-none flex-col border-r border-pop-bd bg-pop-idle">
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          <h2 className="m-0 text-[13px] font-bold">分身</h2>
          <span className="rounded-[5px] border border-pop-bd bg-pop-paper px-1.5 py-px text-[9px] font-bold text-pop-dim">
            {clones.length}
          </span>
          <button
            type="button"
            title="新建分身"
            onClick={() => setWizardOpen(true)}
            className="ml-auto grid size-6 place-items-center rounded-[6px] border-[1.5px] border-pop-bd bg-pop-paper text-pop-dim transition-colors hover:text-pop-ink"
          >
            <Plus className="size-3" />
          </button>
        </div>

        <label className="mx-2.5 mb-2 flex items-center gap-1.5 rounded-[7px] border-[1.5px] border-pop-bd bg-pop-inset px-2 py-1.5">
          <Search className="size-3 text-pop-dim" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索分身…"
            className="min-w-0 flex-1 bg-transparent text-[10.5px] text-pop-ink outline-none placeholder:text-pop-dim/70"
          />
        </label>

        <div className="mb-2 flex gap-1 px-2.5">
          {([
            ['all', `全部 ${clones.length}`],
            ['built-in', `系统 ${systemCount}`],
            ['user', `用户 ${userCount}`],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                'rounded-[5px] border px-1.5 py-0.5 text-[9px] font-bold transition-colors',
                filter === id
                  ? 'border-pop-purple/40 bg-pop-purple-soft text-pop-purple'
                  : 'border-transparent text-pop-dim hover:text-pop-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
          {loading && clones.length === 0 && (
            <div className="px-2 py-3 text-[10px] text-pop-dim">加载中…</div>
          )}
          {!loading && visible.length === 0 && (
            <div className="px-2 py-3 text-center text-[10px] text-pop-dim">没有匹配的分身</div>
          )}
          {system.length > 0 && (
            <ListGroup label="系统分身" count={system.length}>
              {system.map((clone) => (
                <CloneListItem
                  key={clone.name}
                  clone={clone}
                  selected={clone.name === selectedName}
                  onSelect={() => select(clone.name)}
                />
              ))}
            </ListGroup>
          )}
          {user.length > 0 && (
            <ListGroup label="用户分身" count={user.length}>
              {user.map((clone) => (
                <CloneListItem
                  key={clone.name}
                  clone={clone}
                  selected={clone.name === selectedName}
                  onSelect={() => select(clone.name)}
                />
              ))}
            </ListGroup>
          )}
        </div>

        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          className="m-2 flex items-center justify-center gap-1.5 rounded-[7px] border-[1.5px] border-dashed border-pop-bd py-1.5 text-[10px] font-bold text-pop-dim transition-colors hover:border-pop-purple/40 hover:text-pop-purple"
        >
          <Plus className="size-3" />
          新建分身
        </button>
      </aside>

      {/* ── 右：分身详情 ─────────────────────────────────────────── */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error && (
          <div className="mx-3 mt-2 rounded-[8px] border border-pop-red/30 bg-pop-pink-soft px-3 py-2 text-[10px] text-pop-red">
            {error}
          </div>
        )}
        {selected ? (
          <CloneDetailWindow
            key={selected.name}
            clone={selected}
            onMerge={() => setMergeTarget(selected)}
            onDelete={() => setDeleteTarget(selected)}
            onRefresh={refetch}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-pop-dim">
            <Users className="size-7 opacity-40" />
            <p className="m-0 text-[11px]">
              {clones.length === 0 ? '还没有分身' : '从左侧选择一个分身'}
            </p>
          </div>
        )}
      </main>

      {wizardOpen && (
        <CloneCreateWizard
          onClose={() => setWizardOpen(false)}
          onCreated={() => {
            setWizardOpen(false)
            refetch()
          }}
        />
      )}
      <CloneMergeDialog
        clone={mergeTarget}
        onClose={() => setMergeTarget(null)}
        onMerged={() => {
          setMergeTarget(null)
          select(null)
          refetch()
        }}
      />
      <CloneDeleteDialog
        clone={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null)
          select(null)
          refetch()
        }}
      />
    </div>
  )
}

function ListGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[8.5px] uppercase tracking-[0.08em] text-pop-dim">
        {label}
        <span className="font-mono text-[8px] opacity-70">{count}</span>
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

function CloneListItem({
  clone,
  selected,
  onSelect,
}: {
  clone: CloneInfo
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-[7px] border px-2 py-1.5 text-left transition-colors',
        selected
          ? 'border-pop-purple/40 bg-pop-purple-soft'
          : 'border-transparent hover:bg-pop-ink/5',
      )}
    >
      <span
        className={cn(
          'grid size-6 flex-none place-items-center rounded-[6px] border text-[8.5px] font-bold',
          clone.status === 'executing'
            ? 'border-pop-cyan/50 bg-pop-cyan-soft text-pop-cyan'
            : clone.status === 'active'
              ? 'border-pop-green/40 bg-pop-green-soft text-pop-green'
              : 'border-pop-bd bg-pop-paper text-pop-dim',
        )}
      >
        {cloneInitials(clone)}
      </span>
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[10.5px] font-semibold text-pop-ink">{clone.display_name}</b>
        <small className="block truncate font-mono text-[8.5px] text-pop-dim">
          {clone.name} · {MEMORY_LABEL[clone.memory_scope] ?? clone.memory_scope}
        </small>
      </span>
      <span className="flex flex-none items-center gap-1 text-[8px] text-pop-dim">
        <CloneStatusDot status={clone.status} />
        {clone.status === 'executing' ? '执行中' : clone.status === 'active' ? '活跃' : '空闲'}
      </span>
    </button>
  )
}
