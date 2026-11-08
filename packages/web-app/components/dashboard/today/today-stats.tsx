"use client"

import type { ReactNode } from "react"
import type { TodayDigest } from "@/lib/today"

/**
 * 今日统计小结 —— 全部是统计量，不用 LLM 生成叙述。
 * 四格紧凑两行：第一行「标签 + 数字（+ 关键计数）」，第二行分布明细（单行，超长省略）。
 */

function Stat({ label, value, unit, extra, detail, title }: {
  label: string
  value: string
  unit?: string
  extra?: ReactNode
  detail: ReactNode
  title?: string
}) {
  return (
    <div className="min-w-0 border-l border-pop-bd px-3 py-1.5 first:border-l-0 first:pl-0 last:pr-0">
      <div className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="text-[8.5px] uppercase tracking-[0.1em] text-pop-dim">{label}</span>
        <span className="text-[14px] font-black leading-none tracking-[-0.02em]">
          {value}
          {unit && <em className="ml-1 text-[9px] font-bold not-italic tracking-normal text-pop-dim">{unit}</em>}
        </span>
        {extra && <span className="text-[9px] text-pop-dim">{extra}</span>}
      </div>
      <div title={title} className="mt-0.5 truncate text-[9px] leading-[1.3] text-pop-dim">
        {detail}
      </div>
    </div>
  )
}

export function TodayStats({ stats }: { stats: TodayDigest["stats"] }) {
  const { tasks, chats, clones, knowledge } = stats
  const cloneParts = [
    clones.version > 0 ? `版本 ${clones.version}` : null,
    clones.skill > 0 ? `技能 ${clones.skill}` : null,
    clones.memory > 0 ? `记忆 ${clones.memory}` : null,
    clones.file > 0 ? `文件 ${clones.file}` : null,
  ].filter(Boolean) as string[]
  const cloneDetail = cloneParts.length > 0 ? cloneParts.join(" · ") : "版本 0 · 技能 0 · 记忆 0 · 文件 0"
  const taskDetail = tasks.breakdown.map((row) => `${row.label} ${row.count}`).join(" · ")

  return (
    <section className="mt-2.5 grid grid-cols-4 border-y-[1.5px] border-pop-bd" aria-label="今日统计">
      <Stat
        label="任务"
        value={String(tasks.changed)}
        unit="个流转"
        detail={tasks.breakdown.length === 0 ? "今天还没有任务流转" : taskDetail}
        title={taskDetail}
      />
      <Stat
        label="对话"
        value={String(chats.sessions)}
        unit="段"
        detail={`${chats.converted} 段转成任务 · ${chats.running} 段在跑`}
      />
      <Stat
        label="分身"
        value={String(clones.total)}
        unit="个"
        extra={`变更 ${clones.changed}`}
        detail={cloneDetail}
        title={cloneDetail}
      />
      <Stat
        label="知识库"
        value={knowledge.available ? `+${knowledge.added + knowledge.updated}` : "—"}
        unit="页"
        detail={
          knowledge.available
            ? `新增 ${knowledge.added} · 更新 ${knowledge.updated} · 编译 ${knowledge.compiles} 次`
            : "wiki 仓库尚未初始化"
        }
      />
    </section>
  )
}