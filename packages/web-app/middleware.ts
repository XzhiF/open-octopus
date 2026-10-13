import { NextResponse, type NextRequest } from "next/server"

/**
 * 票09 · 旧链接处置 —— /wiki 与 /experience 路由已物理删除（不留半死页，
 * spec 故事 38「旧链接得到明确处置」）；owner 裁决取「重定向 /knowledge」形态：
 * 知识中心是知识唯一入口（票11），两个旧页的读者全部改道。
 *
 * 纯函数 `retiredRedirectTarget` 独立导出供 S4 单测（vitest 直接喂 NextRequest）。
 * 307 Temporary Redirect：不缓存永久态（回滚故事要求旧路径可随时恢复原页）。
 * 旧页深链语义（/wiki/<entry>、/experience?sub=…）在新世界无一对一对应，
 * 统一落到 /knowledge 且剥除 query，避免把 ?org=/?sub= 半死参数带进新页。
 */
export const RETIRED_PREFIXES = ["/wiki", "/experience"] as const
export const KNOWLEDGE_CENTER = "/knowledge"

/** 命中退役路径 ⇒ 返回重定向目标（"/knowledge"），否则 null。纯函数，测试缝。 */
export function retiredRedirectTarget(pathname: string): string | null {
  for (const prefix of RETIRED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return KNOWLEDGE_CENTER
    }
  }
  return null
}

export function middleware(request: NextRequest): NextResponse {
  const target = retiredRedirectTarget(request.nextUrl.pathname)
  if (!target) return NextResponse.next()
  // new URL(target, request.url)：只换 pathname，query 天然剥除
  return NextResponse.redirect(new URL(target, request.url), 307)
}

export const config = {
  matcher: ["/wiki/:path*", "/experience/:path*"],
}
