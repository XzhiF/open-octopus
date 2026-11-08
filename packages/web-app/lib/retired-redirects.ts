export const KNOWLEDGE_CENTER = "/knowledge"
export const DASHBOARD = "/dashboard"

/**
 * 退役路径 ⇒ 落点。深链、书签和旧入口一律改道，不留 404：
 *  - /wiki、/experience：旧知识页并入知识中心
 *  - /workspaces：工作空间页已下线，落到「今日」
 * `query` 会随路径一并剥除。
 */
export const RETIRED_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["/wiki", KNOWLEDGE_CENTER],
  ["/experience", KNOWLEDGE_CENTER],
  ["/workspaces", DASHBOARD],
]

/** 退役路径 ⇒ 改道目标；旧深链的 query 一并剥除。 */
export function retiredRedirectTarget(pathname: string): string | null {
  for (const [prefix, target] of RETIRED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return target
    }
  }
  return null
}

/**
 * Query-dependent legacy links the old pages redirected client-side.
 * `/agent?tab=chat` was a route-level redirect to the chat desktop.
 */
export function queryRedirectTarget(pathname: string, search: string): string | null {
  if (pathname !== "/agent") return null
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  return params.get("tab") === "chat" ? "/" : null
}