// packages/web-app/components/tasks/files-tab/__tests__/use-round-diff-feed.test.tsx
//
// 票03 刷新动线（spec 故事9）：执行中「≡ 变更」半实时 = SSE 事件触发 + 节流，
// 兜底轮询保证新 commit ≤10s 出现。seam = hook 的返回状态 + tasks-api 调用次数，
// fake timers 把时间线钉成字面值（advanceTimersByTimeAsync 同时冲刷微任务队列）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

const { mockGetRoundDiff } = vi.hoisted(() => ({ mockGetRoundDiff: vi.fn() }))
vi.mock("@/lib/tasks-api", () => ({
  getRoundDiff: mockGetRoundDiff,
  TaskApiError: class extends Error {
    constructor(msg: string, public status = 0) { super(msg) }
  },
}))

import { useRoundDiffFeed } from "../use-round-diff-feed"
import type { RoundDiffPayload } from "@/lib/tasks-api"

const payload = (commits: number): RoundDiffPayload => ({
  available: true,
  aggregate: { commits, additions: 0, dels: 0, files: 0 },
  interventions: null,
  repos: [],
})

const settle = async (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.useFakeTimers()
  mockGetRoundDiff.mockReset()
  mockGetRoundDiff.mockResolvedValue(payload(1))
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useRoundDiffFeed", () => {
  it("enabled → 立即首发一次；disabled → 20 秒一趟都不拉", async () => {
    const { result, unmount } = renderHook(() => useRoundDiffFeed("t1", true, 0))
    await settle()
    expect(result.current.data).not.toBeNull()
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(1)
    expect(mockGetRoundDiff).toHaveBeenCalledWith("t1", "round")
    expect(result.current.error).toBeNull()
    unmount()

    mockGetRoundDiff.mockClear()
    const off = renderHook(() => useRoundDiffFeed("t1", false, 0))
    await settle(20_000)
    expect(mockGetRoundDiff).not.toHaveBeenCalled()
    expect(off.result.current.loading).toBe(false)
    off.unmount()
  })

  it("兜底轮询：10 秒内必再拉一次（新 commit ≤10s 出现的观测口径）", async () => {
    const { result, unmount } = renderHook(() => useRoundDiffFeed("t1", true, 0))
    await settle()
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(1)
    await settle(10_000)
    expect(mockGetRoundDiff.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(result.current.nonce).toBeGreaterThanOrEqual(2) // nonce=成功次数 —— 累计口径跟同一节拍
    unmount()
  })

  it("事件信号：够间隔立即补拉；间隔内/在飞时连发合并，绝不双倍打端点", async () => {
    const { rerender, unmount } = renderHook(
      ({ sig }: { sig: number }) => useRoundDiffFeed("t1", true, sig),
      { initialProps: { sig: 0 } },
    )
    await settle()
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(1)
    await settle(2_000) // 越过事件最小间隔
    rerender({ sig: 1 })
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(2) // 够间隔 → 立即
    rerender({ sig: 2 }) // 第二个事件同帧到 —— 在飞/未到间隔，不许再打
    rerender({ sig: 3 })
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(2)
    await settle(1_500) // 合并成恰好一次 trailing
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(3)
    unmount()
  })

  it("409（无轮可供）→ error 面 + 保留旧数据不闪空；恢复后回绿", async () => {
    const { result, unmount } = renderHook(() => useRoundDiffFeed("t1", true, 0))
    await settle()
    const firstData = result.current.data
    mockGetRoundDiff.mockRejectedValueOnce(Object.assign(new Error("当前无待验收 round — 验货台只对 awaiting_review 的轮次供货"), { status: 409 }))
    await settle(10_000) // 轮询撞上 409
    expect(result.current.error).toContain("当前无待验收 round")
    expect(result.current.data).toEqual(firstData) // 诚实降级：不清屏
    await settle(10_000) // 下一拍恢复
    expect(result.current.error).toBeNull()
    expect(result.current.data!.aggregate.commits).toBe(1)
    unmount()
  })

  it("retry()：绕过节流立即重拉（错误态下的人工出口）", async () => {
    mockGetRoundDiff.mockRejectedValueOnce(Object.assign(new Error("网络断了"), { status: 500 }))
    const { result, unmount } = renderHook(() => useRoundDiffFeed("t1", true, 0))
    await settle()
    expect(result.current.error).toContain("网络断了")
    act(() => { result.current.retry() }) // 首发失败刚落地 <1500ms —— retry 不受节流
    await settle()
    expect(result.current.error).toBeNull()
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(2)
    unmount()
  })

  it("换任务 id → 清旧数据重新首发（任务间不串页签数据）", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ id }: { id: string }) => useRoundDiffFeed(id, true, 0),
      { initialProps: { id: "t1" } },
    )
    await settle()
    expect(result.current.data).not.toBeNull()
    rerender({ id: "t2" })
    expect(result.current.data).toBeNull()
    await settle()
    expect(mockGetRoundDiff).toHaveBeenLastCalledWith("t2", "round")
    unmount()
  })
})
