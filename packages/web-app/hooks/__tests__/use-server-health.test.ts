import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }))

import { probeServerHealth, useServerHealth } from "../use-server-health"

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("probeServerHealth", () => {
  it("HTTP 200 → online", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }))
    await expect(probeServerHealth("http://localhost:3001")).resolves.toEqual({
      status: "online",
      detail: null,
    })
  })

  it("HTTP 5xx → degraded（服务在但未就绪）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503 }))
    await expect(probeServerHealth("http://localhost:3001")).resolves.toEqual({
      status: "degraded",
      detail: "服务端未就绪 (HTTP 503)",
    })
  })

  it("网络错误 → offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))
    await expect(probeServerHealth("http://localhost:3001")).resolves.toEqual({
      status: "offline",
      detail: "无法建立连接",
    })
  })

  it("超时 → offline 且说明超时秒数", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted")
            err.name = "AbortError"
            reject(err)
          })
        }),
      ),
    )
    await expect(probeServerHealth("http://localhost:3001", 1000)).resolves.toEqual({
      status: "offline",
      detail: "连接超时（1s）",
    })
  })
})

describe("useServerHealth", () => {
  it("在线 → 离线 → 恢复：状态翻转并各提示一次", async () => {
    let mode: "online" | "offline" = "online"
    const fetchMock = vi.fn(async () => {
      if (mode === "offline") throw new TypeError("fetch failed")
      return { status: 200 }
    })
    vi.stubGlobal("fetch", fetchMock)

    const { result, unmount } = renderHook(() =>
      useServerHealth({ intervalMs: 10, unhealthyIntervalMs: 10 }),
    )

    await waitFor(() => expect(result.current.status).toBe("online"))
    expect(result.current.lastOnlineAt).not.toBeNull()

    mode = "offline"
    await waitFor(() => expect(result.current.status).toBe("offline"))
    expect(result.current.failures).toBeGreaterThanOrEqual(1)
    expect(toastError).toHaveBeenCalledWith(
      "后端服务连接失败",
      expect.objectContaining({ id: "octopus-server-health" }),
    )

    mode = "online"
    await waitFor(() => expect(result.current.status).toBe("online"))
    expect(result.current.failures).toBe(0)
    expect(toastSuccess).toHaveBeenCalledWith(
      "后端服务已恢复",
      expect.objectContaining({ id: "octopus-server-health" }),
    )

    unmount()
  })

  it("retry 立刻重探，不等轮询间隔", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    vi.stubGlobal("fetch", fetchMock)

    const { result, unmount } = renderHook(() =>
      useServerHealth({ intervalMs: 60_000, unhealthyIntervalMs: 60_000 }),
    )
    await waitFor(() => expect(result.current.status).toBe("offline"))
    const callsBefore = fetchMock.mock.calls.length

    fetchMock.mockResolvedValue({ status: 200 })
    act(() => result.current.retry())

    await waitFor(() => expect(result.current.status).toBe("online"))
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1)

    unmount()
  })

  it("enabled=false 时不探测", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal("fetch", fetchMock)

    const { result, unmount } = renderHook(() => useServerHealth({ enabled: false }))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.status).toBe("checking")

    unmount()
  })
})
