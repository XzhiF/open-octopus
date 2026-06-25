import { describe, it, expect, beforeEach } from "vitest"
import { MessageBus } from "../executors/swarm/message-bus"
import type { Message } from "../executors/swarm/swarm-types"

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    from: "expert-a",
    to: "expert-b",
    round: 1,
    content: "hello",
    timestamp: 1000,
    ...overrides,
  }
}

describe("MessageBus", () => {
  let bus: MessageBus

  beforeEach(() => {
    bus = new MessageBus()
  })

  it("sends and retrieves a message", () => {
    const msg = makeMsg()
    bus.send(msg)
    expect(bus.getAll()).toHaveLength(1)
    expect(bus.getAll()[0]).toEqual(msg)
  })

  it("returns messages sorted by timestamp", () => {
    bus.send(makeMsg({ timestamp: 3000, content: "third" }))
    bus.send(makeMsg({ timestamp: 1000, content: "first" }))
    bus.send(makeMsg({ timestamp: 2000, content: "second" }))

    const all = bus.getAll()
    expect(all[0].content).toBe("first")
    expect(all[1].content).toBe("second")
    expect(all[2].content).toBe("third")
  })

  describe("getThread filter", () => {
    beforeEach(() => {
      bus.send(makeMsg({ from: "a", to: "b", round: 1, timestamp: 1 }))
      bus.send(makeMsg({ from: "a", to: "c", round: 1, timestamp: 2 }))
      bus.send(makeMsg({ from: "b", to: "a", round: 2, timestamp: 3 }))
      bus.send(makeMsg({ from: "a", to: "*", round: 2, timestamp: 4, content: "broadcast" }))
    })

    it("filters by from", () => {
      const thread = bus.getThread({ from: "a" })
      expect(thread).toHaveLength(3)
      expect(thread.every(m => m.from === "a")).toBe(true)
    })

    it("filters by to", () => {
      const thread = bus.getThread({ to: "b" })
      expect(thread).toHaveLength(2) // direct to b + broadcast "*"
      expect(thread.map(m => m.from)).toEqual(["a", "a"])
    })

    it("filters by round", () => {
      const thread = bus.getThread({ round: 2 })
      expect(thread).toHaveLength(2)
    })

    it("combines from + round", () => {
      const thread = bus.getThread({ from: "a", round: 1 })
      expect(thread).toHaveLength(2)
    })

    it("broadcast messages match any to filter", () => {
      const thread = bus.getThread({ to: "c" })
      // "to: c" matches direct msg + broadcast
      expect(thread).toHaveLength(2)
    })
  })

  it("clears all messages", () => {
    bus.send(makeMsg())
    bus.send(makeMsg())
    expect(bus.getAll()).toHaveLength(2)

    bus.clear()
    expect(bus.getAll()).toHaveLength(0)
  })

  it("loads from checkpoint", () => {
    const checkpointMsgs: Message[] = [
      makeMsg({ from: "x", to: "y", round: 1, timestamp: 100, content: "restored-1" }),
      makeMsg({ from: "y", to: "x", round: 1, timestamp: 200, content: "restored-2" }),
    ]

    bus.loadFromCheckpoint(checkpointMsgs)
    const all = bus.getAll()
    expect(all).toHaveLength(2)
    expect(all[0].content).toBe("restored-1")
    expect(all[1].content).toBe("restored-2")
  })

  it("getThread returns sorted results", () => {
    bus.send(makeMsg({ from: "a", to: "b", timestamp: 500 }))
    bus.send(makeMsg({ from: "a", to: "b", timestamp: 100 }))
    bus.send(makeMsg({ from: "a", to: "b", timestamp: 300 }))

    const thread = bus.getThread({ from: "a" })
    expect(thread[0].timestamp).toBe(100)
    expect(thread[1].timestamp).toBe(300)
    expect(thread[2].timestamp).toBe(500)
  })
})
