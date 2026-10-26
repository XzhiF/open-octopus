import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { listClones } = vi.hoisted(() => ({ listClones: vi.fn() }))
vi.mock("@/lib/agent/api", () => ({ listClones }))

import { MentionAutocomplete } from "../MentionAutocomplete"

const CLONES = [
  {
    name: "workspace",
    display_name: "全栈开发助手",
    type: "built-in",
    persona: "# 全栈开发助手…",
    skills: [],
    memory_scope: "shared",
    status: "active",
  },
  {
    name: "archive",
    display_name: "工程分析师",
    type: "built-in",
    persona: "# Archive…",
    skills: ["octo-wiki"],
    memory_scope: "shared",
    status: "idle",
  },
  {
    name: "main-agent",
    display_name: "Octopus Agent",
    type: "built-in",
    persona: "…",
    skills: [],
    memory_scope: "shared",
    status: "active",
  },
]

beforeEach(() => {
  listClones.mockReset().mockResolvedValue({ clones: CLONES, total: CLONES.length })
})

describe("MentionAutocomplete（@/@@ 分身 picker）", () => {
  it("opens on single @ and lists clones (main-agent excluded)", async () => {
    render(<MentionAutocomplete inputValue="@" onSelect={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId("clone-mention-picker")).toBeDefined()
    })
    await waitFor(() => {
      expect(screen.getAllByTestId("clone-mention-item").length).toBe(2)
    })
    expect(screen.getByText("全栈开发助手")).toBeDefined()
    expect(screen.queryByText("Octopus Agent")).toBeNull()
  })

  it("filters by display name and by skill", async () => {
    const { rerender } = render(<MentionAutocomplete inputValue="@分析" onSelect={vi.fn()} />)
    await waitFor(() => {
      const items = screen.getAllByTestId("clone-mention-item")
      expect(items).toHaveLength(1)
      expect(items[0].getAttribute("data-clone-name")).toBe("archive")
    })

    rerender(<MentionAutocomplete inputValue="@octo-wiki" onSelect={vi.fn()} />)
    await waitFor(() => {
      const items = screen.getAllByTestId("clone-mention-item")
      expect(items).toHaveLength(1)
      expect(items[0].getAttribute("data-clone-name")).toBe("archive")
    })
  })

  it("also opens on @@ (same roster, one syntax)", async () => {
    render(<MentionAutocomplete inputValue="hello @@" onSelect={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId("clone-mention-picker")).toBeDefined()
    })
  })
})