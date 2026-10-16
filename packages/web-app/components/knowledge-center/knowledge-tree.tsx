"use client"

import { cn } from "@/lib/utils"
import type { KcTree, KcTreeEntry } from "@/lib/knowledge/knowledge-center-api"

/**
 * 知识导航树 — wiki 主场左栏（知识中心改版 ADR-0033；原「INDEX 五类树」升级）。
 * 分组 = Entities / Concepts / Topics / Sources / Cases / System。
 * System 三件：INDEX 总览（在盘导航层只读呈现——树是交互地图，INDEX 是策展文本，
 * 两者并存）、LOG 时间线、原料库 raw（不可变层盘点大门；不平铺进树——
 * 目录树的价值是知识地图，raw 是仓库货箱，分层共存）。
 * 原「必读」偏好组已随概念删除（ADR-0033）。
 * 数据源 = tree API（org 已钉 global，票03）；v3 类型值组直接入组，
 * v2 域值行按 shared WIKI_DOMAIN_TO_PAGE_TYPE 同表映射并入类（重蒸馏票07 前混存实况）——
 * 这里是显示层镜像（服务端 /health 的分桶单源在 shared，客户端不引运行时值避免 barrel 拖 node 依赖）。
 */

const V3_TYPES = ["entity", "concept", "topic", "source", "case"] as const
type KcPageType = (typeof V3_TYPES)[number]

const GROUP_LABELS: Record<KcPageType, string> = {
  entity: "Entities",
  concept: "Concepts",
  topic: "Topics",
  source: "Sources",
  case: "Cases",
}

/** v2 域值 → v3 桶（镜像 shared WIKI_DOMAIN_TO_PAGE_TYPE；projects/workflows→topic 等）。 */
const V2_DOMAIN_TO_BUCKET: Record<string, KcPageType> = {
  projects: "topic",
  workflows: "topic",
  business: "concept",
  research: "concept",
  cases: "case",
}

export function bucketOfPageType(domainName: string): KcPageType | null {
  if ((V3_TYPES as readonly string[]).includes(domainName)) return domainName as KcPageType
  return V2_DOMAIN_TO_BUCKET[domainName] ?? null
}

/** 特殊视图选中态（页以外的正文区形态）。 */
export type KcSpecialView = "index" | "log" | "rawlib" | null

interface KcKnowledgeTreeProps {
  tree: KcTree
  selectedPageId: string | null
  selectedView: KcSpecialView
  onSelectPage: (id: string) => void
  onSelectIndex: () => void
  onSelectLog: () => void
  onSelectRawLib: () => void
}

export function KcKnowledgeTree({
  tree,
  selectedPageId,
  selectedView,
  onSelectPage,
  onSelectIndex,
  onSelectLog,
  onSelectRawLib,
}: KcKnowledgeTreeProps) {
  const buckets = new Map<KcPageType, KcTreeEntry[]>()
  for (const g of tree.domains) {
    const bucket = bucketOfPageType(g.name)
    if (!bucket) continue
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), ...g.entries])
  }

  const sysBtn = (label: string, active: boolean, onClick: () => void, testid: string) => (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-bold text-pop-ink hover:bg-accent",
        active && "bg-pop-pink-soft",
      )}
    >
      {label}
    </button>
  )

  return (
    <nav aria-label="知识导航树" className="space-y-3">
      {/* 五类组（组恒出现——票面分组含 Sources/Cases；空组计数 0） */}
      {V3_TYPES.map(type => {
        const entries = buckets.get(type) ?? []
        return (
          <div key={type} data-testid={`kc-group-${type}`}>
            <div className="flex items-center justify-between px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">
              <span>{GROUP_LABELS[type]}</span>
              <span>{entries.length}</span>
            </div>
            {entries.map(e => (
              <button
                key={e.id}
                type="button"
                onClick={() => onSelectPage(e.id)}
                title={e.path}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-bold text-pop-ink hover:bg-accent",
                  selectedView === null && selectedPageId === e.id && "bg-pop-pink-soft",
                )}
              >
                <span className="truncate flex-1">▸ {e.title}</span>
                {e.ruleCount > 0 && <span className="shrink-0 text-[9px] text-pop-dim">约束×{e.ruleCount}</span>}
              </button>
            ))}
          </div>
        )
      })}

      {/* System 组：INDEX 总览 / LOG 时间线 / 原料库（体检报告=findings 视图属票13，走健康弹层） */}
      <div data-testid="kc-group-system">
        <div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">System</div>
        {sysBtn("🗂 INDEX 总览", selectedView === "index", onSelectIndex, "kc-select-index")}
        {sysBtn("📜 LOG.md 时间线", selectedView === "log", onSelectLog, "kc-select-log")}
        {sysBtn("📥 原料库 raw", selectedView === "rawlib", onSelectRawLib, "kc-select-rawlib")}
      </div>
    </nav>
  )
}
