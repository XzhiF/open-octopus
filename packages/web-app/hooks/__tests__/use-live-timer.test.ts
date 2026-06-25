import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useLiveTimer } from "../use-live-timer"

describe("useLiveTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns undefined when startedAt is undefined", () => {
    const { result } = renderHook(() => useLiveTimer(undefined))
    expect(result.current).toBeUndefined()
  })

  it("returns 0 when startedAt is current time", () => {
    const now = new Date().toISOString()
    const { result } = renderHook(() => useLiveTimer(now))
    expect(result.current).toBe(0)
  })

  it("returns elapsed seconds after 1 second", () => {
    const start = new Date(Date.now() - 0).toISOString()
    const { result } = renderHook(() => useLiveTimer(start))
    expect(result.current).toBe(0)

    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current).toBeCloseTo(1, 0)

    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current).toBeCloseTo(3, 0)
  })

  it("stops updating when startedAt becomes undefined", () => {
    const start = new Date().toISOString()
    const { result, rerender } = renderHook(
      ({ startedAt }: { startedAt?: string | null }) => useLiveTimer(startedAt ?? undefined),
      { initialProps: { startedAt: start } as { startedAt?: string | null } }
    )
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current).toBeCloseTo(1, 0)

    rerender({ startedAt: undefined })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current).toBeUndefined()
  })
})