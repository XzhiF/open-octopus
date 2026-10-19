"use client"

import type { KcArticle, KcTree } from "@/lib/knowledge/knowledge-center-api"

/**
 * 右栏三件套 — 知识中心改版（ADR-0033 · Obsidian 式阅读面）：
 * ① 本页目录（正文 H2 标题派生，锚点条目计数附带）；
 * ② 反向链接（tree entry.backlinks——服务端 links 倒排单源，判据与退役面同函数）；
 * ③ 实效账（P4 票07 实时段：被引/helpful 率；未测=诚实「未实测」不伪造）。
 * sticky 于正文右缘，宽屏才占位（窄窗随布局隐藏由父层断点决定）。
 */

export function WikiRail({
  article,
  tree,
  onOpenPage,
}: {
  article: KcArticle
  tree: KcTree
  onOpenPage: (id: string) => void
}) {
  const entries = tree.domains.flatMap(d => d.entries)
  const byId = new Map(entries.map(e => [e.id, e]))
  const headings = [...article.body.matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1])
  const backlinks = (byId.get(article.id)?.backlinks ?? [])
    .map(id => byId.get(id))
    .filter((e): e is NonNullable<typeof e> => !!e)
  const eff = article.effectiveness

  return (
    <aside data-testid="kc-rail" className="w-[220px] shrink-0 self-start sticky top-0 border-l-[1.5px] border-pop-bd px-4 py-6 text-[11.5px]">
      <div className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-pop-dim">本页目录</div>
      {headings.length === 0 ? (
        <div className="text-pop-dim">（无小节）</div>
      ) : (
        <ul className="mb-4 space-y-0.5">
          {headings.map(h => (
            <li key={h} className="truncate border-l-2 border-pop-bd pl-2 text-pop-dim">{h}</li>
          ))}
        </ul>
      )}
      {article.anchors.length > 0 && (
        <div className="mb-4 text-[10px] text-pop-dim">硬约束锚点 ×{article.anchors.length}</div>
      )}

      <div className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-pop-dim">反向链接 {backlinks.length}</div>
      {backlinks.length === 0 ? (
        <div className="mb-4 text-pop-dim">无入链</div>
      ) : (
        <ul data-testid="kc-rail-backlinks" className="mb-4 space-y-0.5">
          {backlinks.map(b => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => onOpenPage(b.id)}
                className="w-full truncate rounded border-l-2 border-pop-pink pl-2 text-left font-bold text-pop-ink hover:bg-pop-pink-soft"
                title={b.summary}
              >
                {b.title}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-pop-dim">实效账</div>
      <div className="text-pop-dim">
        {eff ? (
          <>
            被引 <b className="text-pop-ink">{eff.citedCount}</b> · helpful{" "}
            <b className="text-pop-ink">{eff.helpfulRate == null ? "—" : `${Math.round(eff.helpfulRate * 100)}%`}</b>
            {!eff.measured && <div className="mt-1 text-[10px]">样本未过闸 · confidence 为编译期初值</div>}
          </>
        ) : (
          "未实测（夜巡账目未回）"
        )}
      </div>
    </aside>
  )
}
