import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ExpertMentionAutocomplete } from "../ExpertMentionAutocomplete"

describe("ExpertMentionAutocomplete", () => {
  it("opens on a single @ and filters by expert name", async () => {
    const onSelect = vi.fn()
    const { rerender } = render(<ExpertMentionAutocomplete inputValue="@" onSelect={onSelect} />)

    expect(screen.getByTestId("expert-mention-picker")).toBeDefined()
    expect(screen.getAllByTestId("expert-mention-item").length).toBeGreaterThan(5)

    rerender(<ExpertMentionAutocomplete inputValue="@审查" onSelect={onSelect} />)
    const items = screen.getAllByTestId("expert-mention-item")
    expect(items).toHaveLength(1)
    await userEvent.click(items[0])
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "engineering-code-reviewer", name: "代码审查员" }),
    )
  })

  it("does not open for @@ clone delegation", () => {
    render(<ExpertMentionAutocomplete inputValue="@@task-author" onSelect={vi.fn()} />)
    expect(screen.queryByTestId("expert-mention-picker")).toBeNull()
  })
})
