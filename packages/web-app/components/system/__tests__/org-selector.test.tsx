import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { OrgSelector } from "../org-selector"

// Mock useOrgs hook
vi.mock("@/hooks/useOrgs", () => ({
  useOrgs: vi.fn(),
}))

import { useOrgs } from "@/hooks/useOrgs"

const mockUseOrgs = vi.mocked(useOrgs)

describe("OrgSelector", () => {
  it("renders loading state", () => {
    mockUseOrgs.mockReturnValue({
      orgs: [],
      loading: true,
      error: null,
    })

    render(<OrgSelector value="" onChange={() => {}} />)
    expect(screen.getByText("加载中...")).toBeDefined()
  })

  it("renders error state", () => {
    mockUseOrgs.mockReturnValue({
      orgs: [],
      loading: false,
      error: "Network error",
    })

    render(<OrgSelector value="" onChange={() => {}} />)
    expect(screen.getByText("Network error")).toBeDefined()
  })

  it("renders empty state when no orgs", () => {
    mockUseOrgs.mockReturnValue({
      orgs: [],
      loading: false,
      error: null,
    })

    render(<OrgSelector value="" onChange={() => {}} />)
    expect(screen.getByText("暂无组织")).toBeDefined()
  })

  it("renders org options", () => {
    mockUseOrgs.mockReturnValue({
      orgs: [
        { id: 1, name: "org-a", path: "/path/a" },
        { id: 2, name: "org-b", path: "/path/b" },
      ],
      loading: false,
      error: null,
    })

    render(<OrgSelector value="org-a" onChange={() => {}} />)

    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select.value).toBe("org-a")
    expect(select.options).toHaveLength(2)
  })

  it("calls onChange when selection changes", () => {
    const onChange = vi.fn()
    mockUseOrgs.mockReturnValue({
      orgs: [
        { id: 1, name: "org-a", path: "/path/a" },
        { id: 2, name: "org-b", path: "/path/b" },
      ],
      loading: false,
      error: null,
    })

    render(<OrgSelector value="org-a" onChange={onChange} />)

    const select = screen.getByRole("combobox")
    fireEvent.change(select, { target: { value: "org-b" } })

    expect(onChange).toHaveBeenCalledWith("org-b")
  })
})
