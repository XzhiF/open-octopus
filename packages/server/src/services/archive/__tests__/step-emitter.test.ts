import { describe, it, expect, vi } from "vitest"
import { createStepEmitter, createNullEmitter } from "../step-emitter"

describe("StepEmitter", () => {
  it("stepStart emits step event with running status", async () => {
    const events: Array<{ event: string; data: string }> = []
    const mockStream = {
      writeSSE: vi.fn((e: { event: string; data: string }) => { events.push(e) }),
    }
    const emitter = createStepEmitter(mockStream as any)
    await emitter.stepStart("archive_executions", "归档 12 条执行记录...")
    expect(events).toHaveLength(1)
    const parsed = JSON.parse(events[0].data)
    expect(parsed.step).toBe("archive_executions")
    expect(parsed.status).toBe("running")
    expect(parsed.detail).toBe("归档 12 条执行记录...")
  })

  it("stepDone emits step event with done status", async () => {
    const events: Array<{ event: string; data: string }> = []
    const mockStream = {
      writeSSE: vi.fn((e: { event: string; data: string }) => { events.push(e) }),
    }
    const emitter = createStepEmitter(mockStream as any)
    await emitter.stepDone("archive_executions", { count: 12 })
    const parsed = JSON.parse(events[0].data)
    expect(parsed.status).toBe("done")
    expect(parsed.data.count).toBe(12)
  })

  it("log emits log event", async () => {
    const events: Array<{ event: string; data: string }> = []
    const mockStream = {
      writeSSE: vi.fn((e: { event: string; data: string }) => { events.push(e) }),
    }
    const emitter = createStepEmitter(mockStream as any)
    await emitter.log("Archiving execution abc-123")
    expect(events[0].event).toBe("log")
    const parsed = JSON.parse(events[0].data)
    expect(parsed.message).toBe("Archiving execution abc-123")
  })

  it("complete emits complete event", async () => {
    const events: Array<{ event: string; data: string }> = []
    const mockStream = {
      writeSSE: vi.fn((e: { event: string; data: string }) => { events.push(e) }),
    }
    const emitter = createStepEmitter(mockStream as any)
    await emitter.complete({ success: true, archivedExecutions: 12 })
    expect(events[0].event).toBe("complete")
  })

  it("nullEmitter methods are no-ops", async () => {
    const emitter = createNullEmitter()
    await emitter.stepStart("test", "detail")
    await emitter.stepDone("test")
    await emitter.log("msg")
    await emitter.complete({})
    // No errors = pass
  })
})
