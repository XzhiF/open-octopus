import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { fetchSessionLLMCalls } = vi.hoisted(() => ({ fetchSessionLLMCalls: vi.fn() }))
vi.mock("@/lib/observability-api", () => ({ fetchSessionLLMCalls }))

import { useSessionUsage } from "../useSessionUsage"

const EMPTY = {
  totalCalls: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  totals: { tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null },
  modelBreakdown: {},
}

const USAGE = {
  totalCalls: 2,
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 },
  totals: { tokens: 180, cost: { usd: 0.01, complete: true }, cacheHitRate: 0.5 },
  modelBreakdown: {},
}

describe("useSessionUsage", () => {
  beforeEach(() => {
    fetchSessionLLMCalls.mockReset()
  })

  it("轮次收尾（streaming true→false）后重拉账本", async () => {
    fetchSessionLLMCalls
      .mockResolvedValueOnce({ data: [], aggregates: EMPTY })
      .mockResolvedValueOnce({ data: [], aggregates: USAGE })

    const { result, rerender } = renderHook(
      ({ streaming }) => useSessionUsage("s-1", streaming),
      { initialProps: { streaming: false } },
    )

    await waitFor(() => expect(fetchSessionLLMCalls).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current?.totalCalls).toBe(0))

    rerender({ streaming: true })
    await waitFor(() => expect(fetchSessionLLMCalls).toHaveBeenCalledTimes(1))
    rerender({ streaming: false })

    await waitFor(() => expect(fetchSessionLLMCalls).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current?.totalCalls).toBe(2))
  })
})
