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
