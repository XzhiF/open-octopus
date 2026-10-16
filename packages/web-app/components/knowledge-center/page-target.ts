import type { KcTree } from "@/lib/knowledge/knowledge-center-api"

/**
 * 页目标解析单源（票11 page.resolveLink 与票12 chat-column 两律合一——
 * 知识中心改版 code-review S1：id 直配 → path 直配 → 剥 wiki/ 前缀与 .md 后缀 →
 * 尾段配。宿主（page.tsx 正文链/抽屉卡引用/药丸）共用，判据永不分叉。
 * 配不上 = 断链返回 null（调用方显形不跳）。
 */
export function resolveKcPageTarget(tree: KcTree | null, target: string): string | null {
  if (!tree) return null
  const entries = tree.domains.flatMap(d => d.entries)
  const t = target.replace(/^wiki\//, "").replace(/\.md$/, "")
  const hit =
    entries.find(e => e.id === target) ??
    entries.find(e => e.path === target || e.path === `${target}.md`) ??
    entries.find(e => e.path.replace(/\.md$/, "") === t || e.path.endsWith(`/${t}`))
  return hit?.id ?? null
}
