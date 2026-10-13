// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"
import type { NextRequest } from "next/server"
import { middleware, retiredRedirectTarget, KNOWLEDGE_CENTER } from "./middleware"

/**
 * 票09 · S4 缝 — 旧链接处置（AC7/S4：旧路由 404/重定向断言）。
 * 处置拍板 = 重定向 /knowledge（不留半死页）。node 环境（next/server 需
 * 原生 Response；jsdom 无）。
 */

function req(url: string): NextRequest {
  const u = new URL(url)
  return {
    url,
    nextUrl: { pathname: u.pathname, search: u.search },
  } as unknown as NextRequest
}

describe("票09 S4 — 旧路由退役重定向（/wiki、/experience → /knowledge）", () => {
  it("重定向目标判定：退役前缀命中，新世界路径放行", () => {
    expect(retiredRedirectTarget("/wiki")).toBe(KNOWLEDGE_CENTER)
    expect(retiredRedirectTarget("/experience")).toBe(KNOWLEDGE_CENTER)
    expect(retiredRedirectTarget("/wiki/prj-octopus")).toBe(KNOWLEDGE_CENTER)
    expect(retiredRedirectTarget("/experience/review")).toBe(KNOWLEDGE_CENTER)
    // 新世界与邻路不误伤
    expect(retiredRedirectTarget("/knowledge")).toBeNull()
    expect(retiredRedirectTarget("/wikixy")).toBeNull()
    expect(retiredRedirectTarget("/workspaces/12")).toBeNull()
    expect(retiredRedirectTarget("/agent")).toBeNull()
  })

  it("middleware 对旧链接返回 307 Location=/knowledge 且剥除 query", () => {
    const res = middleware(req("http://localhost:3000/wiki/prj-octopus?org=xzf-dev"))
    expect(res.status).toBe(307)
    const loc = new URL(res.headers.get("location")!)
    expect(loc.pathname).toBe("/knowledge")
    expect(loc.search).toBe("")
  })

  it("middleware 对 /experience 旧深链同样重定向；活路由透传不改写", () => {
    const res = middleware(req("http://localhost:3000/experience?sub=review"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/knowledge")

    const passthrough = middleware(req("http://localhost:3000/knowledge"))
    expect(passthrough.headers.get("location")).toBeNull()
  })

  it("路由目录已物理删除（app/wiki、app/experience 不存在——404 兜底面前置）", () => {
    const root = process.cwd()
    expect(fs.existsSync(path.join(root, "app", "wiki"))).toBe(false)
    expect(fs.existsSync(path.join(root, "app", "experience"))).toBe(false)
  })
})
