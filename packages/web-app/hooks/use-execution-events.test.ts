import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useExecutionEvents } from "./use-execution-events"
import { fetchAgentEvents } from "@/lib/api-client"

vi.mock("@/lib/api-client", () => ({
  fetchAgentEvents: vi.fn(),
}))

const mockedFetch = vi.mocked(fetchAgentEvents)

function makeEvents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    event: "bash_log",
    nodeId: "node-1",
    line: `line ${i}`,
    timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }))
}

describe("useExecutionEvents", () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it("returns all events when count < 100", async () => {
    mockedFetch.mockResolvedValueOnce({
      events: makeEvents(50),
      loopIterations: {},
    } as any)

    const { result } = renderHook(() => useExecutionEvents("ws", "exec", "completed"))

    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 2000 })

    expect(result.current.totalCount).toBe(50)
    expect(result.current.isTrimmed).toBe(false)
    expect(result.current.events.length).toBe(50)
  })

  it("trims to 100 latest when count > 100", async () => {
    const all = makeEvents(250)
    mockedFetch.mockResolvedValueOnce({
      events: all,
      loopIterations: {},
    } as any)

    const { result } = renderHook(() => useExecutionEvents("ws", "exec", "completed"))

    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 2000 })

    expect(result.current.totalCount).toBe(250)
    expect(result.current.isTrimmed).toBe(true)
    expect(result.current.events.length).toBe(100)
    // Should keep the latest 100 (indices 150-249)
    expect(result.current.events[0].line).toBe("line 150")
    expect(result.current.events[99].line).toBe("line 249")
  })

  it("preserves totalCount across trims", async () => {
    const all = makeEvents(300)
    mockedFetch.mockResolvedValueOnce({
      events: all,
      loopIterations: {},
    } as any)

    const { result } = renderHook(() => useExecutionEvents("ws", "exec", "completed"))

    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 2000 })

    expect(result.current.totalCount).toBe(300)
    // Groups should be based on trimmed events
    const totalGroupEvents = result.current.groups.reduce((sum, g) => sum + g.events.length, 0)
    expect(totalGroupEvents).toBeLessThanOrEqual(100)
  })

  it("groups do not exceed 100 events when trimmed", async () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      event: "bash_log",
      nodeId: `node-${i % 5}`,
      line: `line ${i}`,
      timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }))
    mockedFetch.mockResolvedValueOnce({
      events,
      loopIterations: {},
    } as any)

    const { result } = renderHook(() => useExecutionEvents("ws", "exec", "completed"))

    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 2000 })

    const totalInGroups = result.current.groups.reduce((sum, g) => sum + g.events.length, 0)
    expect(totalInGroups).toBeLessThanOrEqual(100)
  })
})
