import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/agent/api", () => ({
  getSessionRole: vi.fn(),
  setSessionRole: vi.fn(),
  getCloneSessionRole: vi.fn(),
  setCloneSessionRole: vi.fn(),
}))
vi.mock("@/lib/tasks-api", () => ({
  getTaskChatRole: vi.fn(),
  setTaskChatRole: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import * as agentApi from "@/lib/agent/api"
import { ExpertIdentityChip } from "../expert-identity-chip"

const SRE = {
  session_id: "s1",
  active_expert: "engineering-sre",
  expert: { id: "engineering-sre", name: "SRE", label: "🛠️ SRE", desc: "可靠性" },
  revision: 1,
  delivered_revision: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agentApi.getSessionRole).mockResolvedValue(SRE as never)
})

describe("ExpertIdentityChip", () => {
  it("loads and displays the currently active expert", async () => {
    render(<ExpertIdentityChip kind="agent" sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId("expert-identity-chip").textContent).toContain("SRE")
    })
    expect(agentApi.getSessionRole).toHaveBeenCalledWith("s1")
  })
})
