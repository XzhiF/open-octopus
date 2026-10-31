export const RETIRED_PREFIXES = ["/wiki", "/experience"] as const
export const KNOWLEDGE_CENTER = "/knowledge"

/** 退役路径 ⇒ 知识中心；旧深链的 query 一并剥除。 */
export function retiredRedirectTarget(pathname: string): string | null {
  for (const prefix of RETIRED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return KNOWLEDGE_CENTER
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
