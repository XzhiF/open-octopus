'use client'

import { useEffect, useState } from 'react'
import { Cpu, Command, Brain } from 'lucide-react'
import { useRouter } from '@/lib/app-navigation'
import { useAgentClones } from '@/hooks/useAgentClones'
import { listMainAgentVersions } from '@/lib/agent/api'
import type { AgentConfig } from '@/lib/agent/types'
import { CloneTopology } from './CloneTopology'
import { PaneHead } from '../shared/agent-ui'

interface OverviewPaneProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
}

export function OverviewPane({ config }: OverviewPaneProps) {
  const router = useRouter()
  const { clones } = useAgentClones()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    listMainAgentVersions()
      .then((res) => {
        const latest = res.versions?.[0]
        setVersion(latest?.version ?? null)
      })
      .catch(() => setVersion(null))
  }, [])

  const openClone = (name: string) => {
    router.push(`/clones?clone=${encodeURIComponent(name)}`)
  }

  const retention = config?.memory?.session_retention_days ?? 90
  const refine = config?.memory?.long_term_refine_trigger_days ?? 7
  const compress = config?.memory?.session_compress_threshold_messages ?? 50
  const maxClones = config?.max_clones ?? 5
  const model = config?.model ?? '—'

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3">
      <PaneHead
        title="概览"
        description="独立配置与分身拓扑"
        actions={
          version && (
            <span className="rounded-[6px] border border-pop-bd bg-pop-idle px-2 py-1 text-[9px] font-bold text-pop-dim">
              v{version}
            </span>
          )
        }
      />

      <section
        className="mb-3 overflow-hidden rounded-[12px] border border-pop-bd"
        style={{
          background:
            'radial-gradient(340px 190px at 50% 48%, rgba(210,168,255,.07), transparent 72%), var(--pop-paper)',
        }}
      >
        <div className="flex items-center gap-2 px-[13px] pt-[11px]">
          <h3 className="m-0 text-[12px] font-semibold">分身拓扑</h3>
          <span className="text-[8.5px] text-pop-dim">点击节点 → 跳到分身详情</span>
          <div className="ml-auto flex items-center gap-[9px] text-[8.5px] text-pop-dim">
            <span className="flex items-center">
              <i className="mr-1 inline-block size-[5px] rounded-full bg-pop-green" />
              活跃
            </span>
            <span className="flex items-center">
              <i className="mr-1 inline-block size-[5px] rounded-full bg-pop-cyan" />
              执行中
            </span>
            <span className="flex items-center">
              <i className="mr-1 inline-block size-[5px] rounded-full bg-pop-dim" />
              空闲
            </span>
          </div>
        </div>
        <CloneTopology clones={clones} onSelect={openClone} />
        <div className="flex justify-between px-[13px] pb-2.5 text-[8.5px] tracking-[0.04em] text-pop-dim">
          <span>MAIN → {clones.length} 个分身</span>
        </div>
      </section>

      <div className="grid grid-cols-3 gap-[9px]">
        <Metric icon={<Cpu className="size-[11px]" />} label="模型" value={model} hint="主 Agent 运行时模型" />
        <Metric
          icon={<Command className="size-[11px]" />}
          label="分身预算"
          value={String(maxClones)}
          hint={`同时最多 ${maxClones} 个分身`}
        />
        <Metric
          icon={<Brain className="size-[11px]" />}
          label="记忆"
          value={`${retention} 天`}
          hint={`${refine} 天精炼 · ${compress} 条压缩`}
        />
      </div>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="min-w-0 rounded-[10px] border border-pop-bd bg-pop-paper px-[11px] py-2.5">
      <div className="flex items-center gap-1.5 text-[8.5px] tracking-[0.08em] text-pop-dim">
        {icon}
        {label}
      </div>
      <b className="mt-1 block truncate text-[15px] font-bold leading-tight tracking-[-0.01em]">{value}</b>
      <small className="mt-0.5 block text-[9.5px] text-pop-dim">{hint}</small>
    </div>
  )
}
