// 票08 — 草稿期会话全史只读回放的取数层回归。
// seam = getAuthorSessionReplay(sessionId)：与草稿工作台同端点
// （GET /api/clones/task-author/sessions/:id，metadata JSON 由同模块
// parseMessageMetadata 解析成 timeline/thinking/tool_calls —— 折叠 meta 形制的
// 数据源），before 游标自新向旧翻页合并成全量正序；上限之外截断并如实标注；
// 会话不存在/已清理 → 带 status=404 抛错（组件据此落「草稿期会话不存在」空态）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))

import { getAuthorSessionReplay, SESSION_REPLAY_MAX } from "../api"

/** 服务端 clone 路由的原始行形（metadata 是 JSON 字符串；布尔为 0/1）。 */
function row(id: string, role: string, created_at: string, over: Record<string, unknown> = {}) {
  return {
    id, session_id: "sess-1", role, content: `内容-${id}`, created_at,
    is_summary: 0, is_compressed: 0, is_edited: 0, type: "text", source: null,
    tool_calls: null, ...over,
  }
}
function page(messages: unknown[], has_more: boolean, next_cursor: string | null) {
  return { session: { id: "sess-1", clone_name: "task-author" }, messages, has_more, next_cursor }
}
function ok(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response
}
function notFound(): Response {
  return {
    ok: false, status: 404, headers: new Headers(),
    json: async () => ({ error: { code: "NOT_FOUND", message: "Session sess-1 not found" } }),
  } as unknown as Response
}
const urls = (): string[] => (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))

beforeEach(() => { vi.stubGlobal("fetch", vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe("getAuthorSessionReplay — 单页全量（无更早消息）", () => {
  it("has_more=false 时只请求一次；返回正序消息且 metadata JSON 解析进 thinking/timeline/tool_calls（折叠 meta 形制白拿）", async () => {
    const tool = { id: "tc-1", name: "Write", input: { file_path: "a.ts" }, status: "success", result: "ok" }
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(page([
      row("m1", "user", "2026-10-01T00:00:01Z"),
      row("m2", "assistant", "2026-10-01T00:00:02Z", {
        metadata: JSON.stringify({
          thinking: "先读票面",
          tool_calls: [tool],
          timeline: [{ kind: "thinking", text: "先读票面" }, { kind: "tool", id: "tc-1" }, { kind: "text", text: "内容-m2" }],
        }),
      }),
    ], false, null)))

    const res = await getAuthorSessionReplay("sess-1")

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(urls()[0]).toContain("/api/clones/task-author/sessions/sess-1?")
    expect(res.truncated).toBe(false)
    expect(res.items.map((m) => m.id)).toEqual(["m1", "m2"])
    const assistant = res.items[1]!
    expect(assistant.thinking).toBe("先读票面")
    expect(assistant.tool_calls).toHaveLength(1)
    expect(assistant.timeline).toHaveLength(3)
    expect(assistant.is_summary).toBe(false) // 0/1 → 布尔（parseMessageMetadata 同源纪律）
  })
})

describe("getAuthorSessionReplay — before 游标翻全量", () => {
  it("has_more=true → 用 next_cursor 作 before 翻向更早；页页拼接后整体正序（新页在前=更早）", async () => {
    // 页1 = 最新 2 条；页2 = 更早 2 条。期望最终 [更早…, 最新…] 全量正序。
    ;(fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ok(page([
        row("m3", "user", "2026-10-01T00:02:00Z"),
        row("m4", "assistant", "2026-10-01T00:03:00Z"),
      ], true, "2026-10-01T00:02:00Z")))
      .mockResolvedValueOnce(ok(page([
        row("m1", "user", "2026-10-01T00:00:00Z"),
        row("m2", "assistant", "2026-10-01T00:01:00Z"),
      ], false, null)))

    const res = await getAuthorSessionReplay("sess-1")

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(urls()[0]).not.toContain("before=")
    expect(urls()[1]).toContain("before=2026-10-01T00%3A02%3A00Z") // 页1 最旧 created_at
    expect(res.items.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"])
    expect(res.truncated).toBe(false)
  })

  it("累计达上限即止：truncated=true，装载保留**最近** SESSION_REPLAY_MAX 条（尾部切片）", async () => {
    const n = SESSION_REPLAY_MAX / 2 // 每页 500 —— 让页数少、循环快，语义等价
    // 覆写分页尺寸不可行（常量固化），改为两页各 n 条：page1=最新 n 条(has_more)，page2=更早 n 条(has_more)。
    const mk = (base: number, newestFirst: boolean) =>
      Array.from({ length: n }, (_, i) => {
        const idx = newestFirst ? base - i : base + i
        return row(`m${idx}`, idx % 2 === 0 ? "user" : "assistant", `2026-10-0${Math.floor(idx / 3600) + 1}T00:00:00Z`)
      })
    // 页1（最新）：m1000..m499 降序入列 → reverse 前已是正序？—— 直接给正序数组，游标取首元素 created_at。
    const p1 = mk(999, false).slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    const p2 = mk(499, false).sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    ;(fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ok(page(p1, true, p1[0]!.created_at)))
      .mockResolvedValueOnce(ok(page(p2, true, p2[0]!.created_at)))

    const res = await getAuthorSessionReplay("sess-1")

    expect(res.truncated).toBe(true)
    expect(res.items).toHaveLength(SESSION_REPLAY_MAX)
    // 保留的是最近的一批：页1 末条仍在尾部，页2 头部（更早）被挤掉。
    expect(res.items[res.items.length - 1]!.id).toBe(p1[p1.length - 1]!.id)
    expect(res.items[0]!.id).toBe(p2[p2.length - p1.length]!.id)
    expect(urls()).toHaveLength(2) // 达上限即止，不再翻第三页
  })
})

describe("getAuthorSessionReplay — 会话不可得", () => {
  it("404（会话已清理）→ 抛错带 status=404 与 code（组件据此落「草稿期会话不存在」）", async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(notFound())
    await expect(getAuthorSessionReplay("sess-1")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })
  })

  it("网络层失败 → 原样抛（组件落读取失败话术，不伪装成空会话）", async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("fetch failed"))
    await expect(getAuthorSessionReplay("sess-1")).rejects.toThrow("fetch failed")
  })
})
