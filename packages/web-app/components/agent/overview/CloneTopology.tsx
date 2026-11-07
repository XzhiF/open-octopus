'use client'

import type { CloneInfo } from '@/lib/agent/types'
import { cn } from '@/lib/utils'

const MONOGRAMS: Record<string, string> = {
  workspace: 'WS',
  scheduler: 'SC',
  archive: 'AR',
  resource: 'RS',
  'task-author': 'TA',
  'task-doer': 'TD',
  'workflow-author': 'WA',
  'workflow-operator': 'WO',
}

export function cloneInitials(clone: Pick<CloneInfo, 'name'>): string {
  const known = MONOGRAMS[clone.name]
  if (known) return known
  return clone.name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '··'
}

const STATUS_LABEL: Record<string, string> = {
  active: '活跃',
  idle: '空闲',
  executing: '执行中',
}

const NODE_CLASS: Record<string, { circle: string; text: string }> = {
  active: { circle: 'fill-pop-green-soft stroke-pop-green/55', text: 'fill-pop-green' },
  executing: { circle: 'fill-pop-cyan-soft stroke-pop-cyan/65', text: 'fill-pop-cyan' },
  idle: { circle: 'fill-pop-idle stroke-pop-bd', text: 'fill-pop-dim' },
}

interface CloneTopologyProps {
  clones: CloneInfo[]
  onSelect: (name: string) => void
}

/** 主 Agent 与分身的双环拓扑：内环系统分身，外环用户分身。 */
export function CloneTopology({ clones, onSelect }: CloneTopologyProps) {
  const cx = 200
  const cy = 110
  const r1 = 66
  const r2 = 94

  const system = clones.filter((c) => c.type === 'built-in')
  const user = clones.filter((c) => c.type === 'user')

  const nodes = [
    ...system.map((clone, index) => {
      const angle = ((-90 + (360 / Math.max(system.length, 1)) * index) * Math.PI) / 180
      return {
        clone,
        x: cx + Math.cos(angle) * r1,
        y: cy + Math.sin(angle) * r1,
        live: clone.status === 'executing',
      }
    }),
    ...user.map((clone, index) => {
      const spread = Math.min(160, Math.max(30, 300 / Math.max(user.length, 1)))
      const angle = ((-20 - index * spread) * Math.PI) / 180
      return {
        clone,
        x: cx + Math.cos(angle) * r2,
        y: cy + Math.sin(angle) * r2,
        live: clone.status === 'executing',
      }
    }),
  ]

  return (
    <svg
      viewBox="0 0 400 220"
      className="block min-h-[180px] w-full"
      role="img"
      aria-label="主 Agent 与分身拓扑"
    >
      <circle cx={cx} cy={cy} r={r1} className="fill-none stroke-pop-ink/[0.055]" strokeDasharray="2 5" />
      <circle cx={cx} cy={cy} r={r2} className="fill-none stroke-pop-purple/[0.12]" strokeDasharray="2 5" />
      <text x={cx} y={cy - r1 - 8} className="fill-pop-dim text-[7px] tracking-[0.16em]" textAnchor="middle">
        SYSTEM
      </text>
      <text x={cx} y={cy + r2 + 14} className="fill-pop-dim text-[7px] tracking-[0.16em]" textAnchor="middle">
        USER
      </text>

      {nodes.map(({ clone, x, y, live }) => (
        <line
          key={`line-${clone.name}`}
          x1={cx}
          y1={cy}
          x2={x}
          y2={y}
          className={live ? 'stroke-pop-cyan/35' : 'stroke-pop-ink/[0.07]'}
          strokeWidth={1}
          strokeDasharray={live ? '2 4' : undefined}
        />
      ))}

      <g>
        <rect
          x={cx - 48}
          y={cy - 24}
          width={96}
          height={48}
          rx={12}
          className="fill-pop-purple-soft stroke-pop-purple/50"
          strokeWidth={1.5}
        />
        <text x={cx} y={cy - 2} textAnchor="middle" className="fill-pop-purple text-[11px] font-bold tracking-[0.1em]">
          MAIN
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="fill-pop-dim text-[7px] tracking-[0.14em]">
          主 Agent
        </text>
      </g>

      {nodes.map(({ clone, x, y }) => {
        const tone = NODE_CLASS[clone.status] ?? NODE_CLASS.idle
        return (
          <g
            key={clone.name}
            role="button"
            tabIndex={0}
            aria-label={clone.display_name}
            className="cursor-pointer focus:outline-none"
            onClick={() => onSelect(clone.name)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(clone.name)
              }
            }}
          >
            <circle
              cx={x}
              cy={y}
              r={11}
              strokeWidth={1.5}
              className={cn('transition-[filter] hover:brightness-125', tone.circle)}
            />
            <text
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              className={cn('pointer-events-none text-[8px] font-bold', tone.text)}
            >
              {cloneInitials(clone)}
            </text>
            <title>{`${clone.display_name} · ${STATUS_LABEL[clone.status] ?? clone.status}`}</title>
          </g>
        )
      })}
    </svg>
  )
}

export function CloneStatusDot({ status }: { status: CloneInfo['status'] }) {
  return (
    <i
      className={cn(
        'inline-block size-[5px] flex-none rounded-full',
        status === 'executing' && 'bg-pop-cyan',
        status === 'active' && 'bg-pop-green',
        status === 'idle' && 'bg-pop-dim',
      )}
    />
  )
}
