// Regression: messages.tool_calls can arrive as a non-array. The column
// historically held a bare wrapper object (all-empty rows serialized as "{}"),
// and the transcript UI iterates it — `.find`/`.map` on an object threw
// mid-render and blanked the whole app on mount. Both renderers must treat a
// non-array as "no tools" and still draw the message body.

import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { ChatBubble } from "../ChatBubble"
import { TuiMessage } from "../TuiTranscript"
import type { AgentMessage } from "@/lib/agent/types"

const junkMessage = {
  id: "m-junk",
  session_id: "s-junk",
  role: "assistant",
  content: "hello body",
  created_at: "2026-01-01T00:00:00.000Z",
  is_summary: false,
  is_compressed: false,
  is_edited: false,
  tool_calls: {} as unknown as AgentMessage["tool_calls"],
} as AgentMessage

describe("junk tool_calls (legacy \"{}\" rows) never blank the transcript", () => {
  it("ChatBubble ignores the object and renders the body", () => {
    const { container } = render(<ChatBubble message={junkMessage} />)
    expect(container.textContent).toContain("hello body")
  })

  it("TuiMessage ignores the object (with a tool timeline entry) and renders the body", () => {
    const withTimeline = {
      ...junkMessage,
      timeline: [{ kind: "tool", id: "tc-missing" }],
    } as AgentMessage
    const { container } = render(<TuiMessage message={withTimeline} />)
    expect(container.textContent).toContain("hello body")
  })
})
