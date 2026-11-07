"use client"

import { useMemo, useState } from "react"
import { CHANGE_CAT_LABEL, type TodayChangeCat, type TodayChangeItem } from "@/lib/today"

/**
 * 变动追踪 —— 同样是精选（服务端已截断），左侧按类目过滤。
 * 四类：任务 / AGENT / 分身 / 知识库；分身只记资产变更（版本/技能/记忆/文件）。
 */

const CAT_STYLE: Record<TodayChangeCat, string> = {
  task: "var(--pop-amber)",
  agent: "var(--pop-cyan)",
  clone: "var(--pop-purple)",
  know: "var(--pop-green)",
}

const CAT_ORDER: TodayChangeCat[] = ["task", "agent", "clone", "know"]

function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "--:--"
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export function TodayChanges({ items }: { items: TodayChangeItem[] }) {
  const [active, setActive] = useState<"all" | TodayChangeCat>("all")

  const counts = useMemo(() => {
    const map: Record<TodayChangeCat, number> = { task: 0, agent: 0, clone: 0, know: 0 }
    for (const item of items) map[item.cat] += 1
    return map
  }, [items])

  const visible = active === "all" ? items : items.filter((item) => item.cat === active)

  return (
    <aside aria-label="今日变动">
      <div className="mb-2.5 flex items-baseline gap-2.5 border-b-[1.5px] border-pop-bd pb-2">
        <h2 className="text-[11px] font-black uppercase tracking-[0.1em]">变动</h2>
        <span className="ml-auto text-[9.5px] text-pop-dim">精选 {items.length} 条</span>
      </div>

      <div className="mb-1 flex flex-wrap gap-[5px]">
        <button
          type="button"
          onClick={() => setActive("all")}
          className={`h-[21px] rounded-full border px-2.5 text-[9px] font-bold transition-colors ${
            active === "all"
              ? "border-pop-ink bg-pop-ink text-pop-bg"
              : "border-pop-bd text-pop-dim hover:text-pop-ink"
          }`}
        >
          全部<b className="ml-1 font-black opacity-65">{items.length}</b>
        </button>
        {CAT_ORDER.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActive(cat)}
            className={`h-[21px] rounded-full border px-2.5 text-[9px] font-bold transition-colors ${
              active === cat
                ? "border-pop-ink bg-pop-ink text-pop-bg"
                : "border-pop-bd text-pop-dim hover:text-pop-ink"
            }`}
          >
            {CHANGE_CAT_LABEL[cat]}
            <b className="ml-1 font-black opacity-65">{counts[cat]}</b>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-[11px] text-pop-dim">
          {active === "all" ? "今天还没有值得记录的变动。" : "这个类目今天没有值得记录的变动。"}
        </p>
      ) : (
        <div className="mt-0.5">
          {visible.map((item, i) => (
            <div
              key={`${item.ts}-${i}`}
              className="grid grid-cols-[38px_10px_minmax(0,1fr)] items-start gap-[9px] border-b border-pop-bd/45 py-[5px] last:border-b-0"
            >
              <time className="pt-0.5 text-[9.5px] text-pop-dim">{clock(item.ts)}</time>
              <span
                className="mt-[5px] h-1.5 w-1.5 rounded-[2px]"
                style={{ background: CAT_STYLE[item.cat] }}
              />
              <div className="min-w-0">
                <div className="text-[11px] leading-normal">
                  <span
                    className="mr-1.5 text-[8px] font-black tracking-[0.06em]"
                    style={{ color: CAT_STYLE[item.cat] }}
                  >
                    {CHANGE_CAT_LABEL[item.cat]}
                  </span>
                  {item.title}
                </div>
                {item.meta && <div className="mt-px text-[9px] text-pop-dim">{item.meta}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}