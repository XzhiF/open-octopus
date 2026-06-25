import { describe, it, expect } from "vitest"
import { SSEService } from "../services/sse"

describe("SSEService", () => {
  it("emits events to subscribers", () => {
    const sse = new SSEService()
    const events: unknown[] = []
    sse.subscribe("ws-1", (event) => { events.push(event) })
    sse.emit("ws-1", { event: "test", data: { x: 1 } })
    expect(events.length).toBe(1)
    expect(events[0]).toEqual({ event: "test", data: { x: 1 } })
  })

  it("does not leak events across workspaces", () => {
    const sse = new SSEService()
    const ws1Events: unknown[] = []
    const ws2Events: unknown[] = []
    sse.subscribe("ws-1", (e) => ws1Events.push(e))
    sse.subscribe("ws-2", (e) => ws2Events.push(e))
    sse.emit("ws-1", { event: "a", data: {} })
    expect(ws1Events.length).toBe(1)
    expect(ws2Events.length).toBe(0)
  })

  it("unsubscribe removes listener", () => {
    const sse = new SSEService()
    const events: unknown[] = []
    const unsub = sse.subscribe("ws-1", (e) => events.push(e))
    unsub()
    sse.emit("ws-1", { event: "test", data: {} })
    expect(events.length).toBe(0)
  })

  it("emitToAll broadcasts to all workspaces", () => {
    const sse = new SSEService()
    const ws1: unknown[] = []
    const ws2: unknown[] = []
    sse.subscribe("ws-1", (e) => ws1.push(e))
    sse.subscribe("ws-2", (e) => ws2.push(e))
    sse.emitToAll({ event: "global", data: {} })
    expect(ws1.length).toBe(1)
    expect(ws2.length).toBe(1)
  })

  it("multiple subscribers to same workspace both receive events", () => {
    const sse = new SSEService()
    const e1: unknown[] = []
    const e2: unknown[] = []
    sse.subscribe("ws-1", (e) => e1.push(e))
    sse.subscribe("ws-1", (e) => e2.push(e))
    sse.emit("ws-1", { event: "test", data: {} })
    expect(e1.length).toBe(1)
    expect(e2.length).toBe(1)
  })
})