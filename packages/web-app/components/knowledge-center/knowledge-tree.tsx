"use client"

import { cn } from "@/lib/utils"
import type { KcTree, KcTreeEntry } from "@/lib/knowledge/knowledge-center-api"

/**
 * INDEX 五类树 — 票11（原型 Tab④ 浏览模式 .wside 同构）。
 * 分组 = 必读 / Entities / Concepts / Topics / Sources / Cases / System。
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

interface KcKnowledgeTreeProps {
  tree: KcTree
  selectedPageId: string | null
  selectedView: "preference" | "log" | null
  onSelectPage: (id: string) => void
  onSelectPreference: () => void
  onSelectLog: () => void
}

export function KcKnowledgeTree({
  tree,
  selectedPageId,
  selectedView,
  onSelectPage,
  onSelectPreference,
  onSelectLog,
}: KcKnowledgeTreeProps) {
  const buckets = new Map<KcPageType, KcTreeEntry[]>()
  for (const g of tree.domains) {
    const bucket = bucketOfPageType(g.name)
    if (!bucket) continue
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), ...g.entries])
  }

  return (
    <nav aria-label="知识导航树" className="space-y-3">
      {/* 必读组（INDEX 必读节承接；user_preference = 人工文件区） */}
      <div data-testid="kc-group-must-read">
        <div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">必读</div>
        <button
          type="button"
          onClick={onSelectPreference}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-bold text-pop-ink hover:bg-accent",
            selectedView === "preference" && "bg-pop-pink-soft",
          )}
        >
          <span className="flex-1 truncate">⚙ user_preference</span>
          <span className="shrink-0 text-[9px] text-pop-dim">人工</span>
        </button>
      </div>

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
                  selectedView !== "log" && selectedView !== "preference" && selectedPageId === e.id && "bg-pop-pink-soft",
                )}
              >
                <span className="truncate flex-1">▸ {e.title}</span>
                {e.ruleCount > 0 && <span className="shrink-0 text-[9px] text-pop-dim">约束×{e.ruleCount}</span>}
              </button>
            ))}
          </div>
        )
      })}

      {/* System 组：LOG.md 时间线（体检报告=findings 视图属票13） */}
      <div>
        <div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">System</div>
        <button
          type="button"
          onClick={onSelectLog}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-bold text-pop-ink hover:bg-accent",
            selectedView === "log" && "bg-pop-pink-soft",
          )}
        >
          📜 LOG.md 时间线
        </button>
      </div>
    </nav>
  )
}
