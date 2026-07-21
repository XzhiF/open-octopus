import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => "/system/repos",
  redirect: vi.fn(),
}))

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

// Mock sonner Toaster (requires window.matchMedia)
vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}))

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// Mock RepoEditDialog (Radix primitives need DOM env)
vi.mock("@/components/system/repo-edit-dialog", () => ({
  RepoEditDialog: ({ open }: { open: boolean }) => open ? <div data-testid="repo-edit-dialog" /> : null,
}))

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Boxes: () => <span data-testid="icon-boxes" />,
  Database: () => <span data-testid="icon-database" />,
  Plus: () => <span data-testid="icon-plus" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
  Download: () => <span data-testid="icon-download" />,
  FileText: () => <span data-testid="icon-filetext" />,
  Loader2: () => <span data-testid="icon-loader" />,
  ChevronRight: () => <span data-testid="icon-chevron" />,
}))

import SystemLayout from "../layout"
import SystemReposPage from "../repos/page"

describe("SystemLayout", () => {
  it("renders both menu items", () => {
    render(
      <SystemLayout>
        <div>Content</div>
      </SystemLayout>
    )

    expect(screen.getByText("模型管理")).toBeDefined()
    expect(screen.getByText("仓库管理")).toBeDefined()
  })

  it("renders correct navigation links", () => {
    render(
      <SystemLayout>
        <div>Content</div>
      </SystemLayout>
    )

    const links = screen.getAllByRole("link")
    const hrefs = links.map(l => l.getAttribute("href"))
    expect(hrefs).toContain("/system/models")
    expect(hrefs).toContain("/system/repos")
  })

  it("renders children in content area", () => {
    render(
      <SystemLayout>
        <div data-testid="child-content">Child Content</div>
      </SystemLayout>
    )

    expect(screen.getByTestId("child-content")).toBeDefined()
    expect(screen.getByText("Child Content")).toBeDefined()
  })
})

describe("SystemReposPage", () => {
  it("renders empty state with guidance text", () => {
    render(<SystemReposPage />)

    expect(screen.getByText("仓库管理")).toBeDefined()
    expect(screen.getByText("暂无仓库记录")).toBeDefined()
  })

  it("renders action buttons", () => {
    render(<SystemReposPage />)

    expect(screen.getByText("Pull All")).toBeDefined()
    expect(screen.getByText("Clone Missing")).toBeDefined()
    expect(screen.getByText("Rebuild")).toBeDefined()
    expect(screen.getByText("新增")).toBeDefined()
  })
})
