import { describe, it, expect } from "vitest"
import { reduceCloneEvent, type CloneMessage } from "../clone-chat"

function user(id: string, content: string): CloneMessage {
  return { id, role: "user", kind: "text", content }
}
function text(id: string, content: string): CloneMessage {
  return { id, role: "assistant", kind: "text", content }
}

describe("reduceCloneEvent — text_delta (clone protocol: full accumulator, NOT delta)", () => {
  it("creates an assistant text message on first text_delta using the accumulator", () => {
    const prev = [user("u1", "加 OAuth 登录")]
    const out = reduceCloneEvent(prev, "text_delta", { delta: "Hel", content: "Hel" })
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ role: "assistant", kind: "text", content: "Hel" })
  })

  it("REPLACES (not appends) text content — content is the full accumulator", () => {
    // The clone route sends content = full text so far each tick. Appending would
    // duplicate ("Hel" + "Hello" = "HelHello"). This is the protocol fidelity test.
    const prev = [user("u1", "加 OAuth 登录")]
    let out = reduceCloneEvent(prev, "text_delta", { delta: "Hel", content: "Hel" })
    out = reduceCloneEvent(out, "text_delta", { delta: "lo", content: "Hello" })
    out = reduceCloneEvent(out, "text_delta", { delta: " world", content: "Hello world" })
    expect(out[1].content).toBe("Hello world")
    expect(out).toHaveLength(2)
  })

  it("does NOT clobber a prior turn's text message (turn-scoped to last user msg)", () => {
    const prev = [user("u1", "old q"), text("u1-text", "old answer"), user("u2", "new q")]
    const out = reduceCloneEvent(prev, "text_delta", { delta: "new", content: "new ans" })
    // prior turn text untouched; new assistant text appended for the current turn
    expect(out[1].content).toBe("old answer")
    expect(out[3].content).toBe("new ans")
    expect(out[3].id).toBe("u2-text")
  })
})

describe("reduceCloneEvent — thinking stream", () => {
  it("appends thinking deltas then finalizes on thinking_done", () => {
    const prev = [user("u1", "q")]
    let out = reduceCloneEvent(prev, "thinking_start", {})
    out = reduceCloneEvent(out, "thinking", { delta: "abc" })
    out = reduceCloneEvent(out, "thinking", { delta: "def" })
    out = reduceCloneEvent(out, "thinking_done", {})
    const thinking = out.find((m) => m.kind === "thinking")
    expect(thinking?.content).toBe("abcdef")
  })
})

describe("reduceCloneEvent — tool_call lifecycle", () => {
  it("tracks start → input → result (success) on one tool message", () => {
    const prev = [user("u1", "q")]
    let out = reduceCloneEvent(prev, "tool_call", {
      type: "start", tool_call_id: "t1", tool_name: "curl",
    })
    out = reduceCloneEvent(out, "tool_call", {
      type: "input", tool_call_id: "t1", tool_name: "curl", input: { url: "/jobs" },
    })
    out = reduceCloneEvent(out, "tool_call", {
      type: "result", tool_call_id: "t1", content: "201 created", is_error: false,
    })
    const tool = out.find((m) => m.id === "tool-t1")
    expect(tool).toMatchObject({
      kind: "tool_call", toolName: "curl", toolStatus: "done", toolResult: "201 created",
    })
  })

  it("marks a failed tool result as error", () => {
    const prev = [user("u1", "q")]
    let out = reduceCloneEvent(prev, "tool_call", {
      type: "start", tool_call_id: "t9", tool_name: "curl",
    })
    out = reduceCloneEvent(out, "tool_call", {
      type: "result", tool_call_id: "t9", content: "boom", is_error: true,
    })
    const tool = out.find((m) => m.id === "tool-t9")
    expect(tool?.toolStatus).toBe("error")
    expect(tool?.toolResult).toBe("boom")
  })
})

describe("reduceCloneEvent — irrelevant / terminal events", () => {
  it("returns the SAME array reference for status / done / unknown events (no mutation)", () => {
    const prev = [user("u1", "q")]
    expect(reduceCloneEvent(prev, "status", { status: "requesting" })).toBe(prev)
    expect(reduceCloneEvent(prev, "done", { session_id: "s1" })).toBe(prev)
    expect(reduceCloneEvent(prev, "something_unknown", { foo: 1 })).toBe(prev)
  })
})
