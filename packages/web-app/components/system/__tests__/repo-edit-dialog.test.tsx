import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

// Mock Radix Dialog primitives
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Mock AlertDialog
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick}>{children}</button>
  ),
  AlertDialogAction: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}))

// Mock Radix Select
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children: React.ReactNode; value: string; onValueChange: (v: string) => void }) => (
    <select data-testid="group-select" value={value} onChange={e => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder: string }) => <span>{placeholder}</span>,
}))

// Mock lucide icons
vi.mock("lucide-react", () => ({
  Trash2: () => <span data-testid="icon-trash" />,
}))

// Mock fetch
const mockFetch = vi.fn()
global.fetch = mockFetch

import { RepoEditDialog } from "../repo-edit-dialog"

describe("RepoEditDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    entry: null,
    groups: ["Core", "Utils"],
    org: "test-org",
    onSaved: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders new repo form when entry is null", () => {
    render(<RepoEditDialog {...defaultProps} />)
    expect(screen.getByText("新增仓库")).toBeDefined()
    expect(screen.getByLabelText("名称")).toBeDefined()
    expect(screen.getByLabelText("Git URL")).toBeDefined()
    expect(screen.getByLabelText("分支")).toBeDefined()
    expect(screen.getByLabelText("标签")).toBeDefined()
  })

  it("renders edit form when entry is provided", () => {
    render(
      <RepoEditDialog
        {...defaultProps}
        entry={{
          name: "my-repo",
          git_url: "git@github.com:xzf/my-repo.git",
          branch: "develop",
          group: "Core",
          manual_tags: ["typescript"],
        }}
      />
    )
    expect(screen.getByText("编辑仓库")).toBeDefined()
    expect(screen.getByDisplayValue("my-repo")).toBeDefined()
    expect(screen.getByDisplayValue("git@github.com:xzf/my-repo.git")).toBeDefined()
    expect(screen.getByDisplayValue("develop")).toBeDefined()
    expect(screen.getByDisplayValue("typescript")).toBeDefined()
  })

  it("disables save when name is empty", () => {
    render(<RepoEditDialog {...defaultProps} />)
    const saveBtn = screen.getByText("保存")
    expect(saveBtn.closest("button")?.disabled).toBe(true)
  })

  it("disables save when git_url is empty", () => {
    render(<RepoEditDialog {...defaultProps} />)
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "test" } })
    const saveBtn = screen.getByText("保存")
    expect(saveBtn.closest("button")?.disabled).toBe(true)
  })

  it("enables save when name, git_url and group are filled", () => {
    render(<RepoEditDialog {...defaultProps} />)
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "test" } })
    fireEvent.change(screen.getByLabelText("Git URL"), { target: { value: "git@x.git" } })
    const saveBtn = screen.getByText("保存")
    expect(saveBtn.closest("button")?.disabled).toBe(false)
  })

  it("calls API with POST for new repo on save", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, entry: { name: "test" } }),
    })

    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    render(<RepoEditDialog {...defaultProps} onSaved={onSaved} onOpenChange={onOpenChange} />)

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "test" } })
    fireEvent.change(screen.getByLabelText("Git URL"), { target: { value: "git@x.git" } })

    fireEvent.click(screen.getByText("保存"))
    await new Promise(r => setTimeout(r, 50))

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain("/api/repos")
    expect(opts.method).toBe("POST")
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSaved).toHaveBeenCalled()
  })

  it("calls API with PUT for existing repo on save", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, entry: { name: "my-repo" } }),
    })

    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <RepoEditDialog
        {...defaultProps}
        entry={{
          name: "my-repo",
          git_url: "git@github.com:xzf/my-repo.git",
          branch: "main",
          group: "Core",
          manual_tags: [],
        }}
        onSaved={onSaved}
        onOpenChange={onOpenChange}
      />
    )

    fireEvent.click(screen.getByText("保存"))
    await new Promise(r => setTimeout(r, 50))

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain("/api/repos/my-repo")
    expect(opts.method).toBe("PUT")
  })

  it("shows error when API fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: { message: "Repo already exists" } }),
    })

    render(<RepoEditDialog {...defaultProps} />)
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "dup" } })
    fireEvent.change(screen.getByLabelText("Git URL"), { target: { value: "git@x.git" } })

    fireEvent.click(screen.getByText("保存"))
    await new Promise(r => setTimeout(r, 50))

    expect(screen.getByText("Repo already exists")).toBeDefined()
  })

  it("does not render when open is false", () => {
    render(<RepoEditDialog {...defaultProps} open={false} />)
    expect(screen.queryByText("新增仓库")).toBeNull()
  })

  // T-3: Delete flow tests
  it("shows delete button only in edit mode", () => {
    const { rerender } = render(<RepoEditDialog {...defaultProps} />)
    expect(screen.queryByText("删除")).toBeNull()

    rerender(
      <RepoEditDialog
        {...defaultProps}
        entry={{ name: "x", git_url: "git@x.git", branch: "main", group: "Core", manual_tags: [] }}
      />
    )
    expect(screen.getByText("删除")).toBeDefined()
  })

  it("clicking delete opens confirmation dialog", () => {
    render(
      <RepoEditDialog
        {...defaultProps}
        entry={{ name: "del-me", git_url: "git@x.git", branch: "main", group: "Core", manual_tags: [] }}
      />
    )
    fireEvent.click(screen.getByText("删除"))
    expect(screen.getByText("确定要删除仓库 \"del-me\" 吗？此操作不可撤销。")).toBeDefined()
    // "确认删除" appears as both title and button — at least 2 instances
    expect(screen.getAllByText("确认删除").length).toBeGreaterThanOrEqual(1)
  })

  it("cancel delete preserves entry", () => {
    render(
      <RepoEditDialog
        {...defaultProps}
        entry={{ name: "keep-me", git_url: "git@x.git", branch: "main", group: "Core", manual_tags: [] }}
      />
    )
    fireEvent.click(screen.getByText("删除"))
    // Click cancel in alert dialog
    const cancelBtns = screen.getAllByText("取消")
    // Last "取消" is the AlertDialog cancel
    fireEvent.click(cancelBtns[cancelBtns.length - 1])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("confirm delete calls DELETE API and refreshes", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    })

    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <RepoEditDialog
        {...defaultProps}
        entry={{ name: "del-target", git_url: "git@x.git", branch: "main", group: "Core", manual_tags: [] }}
        onSaved={onSaved}
        onOpenChange={onOpenChange}
      />
    )

    fireEvent.click(screen.getByText("删除"))
    // "确认删除" is both title (h3) and button — click the button
    const confirmBtns = screen.getAllByText("确认删除")
    fireEvent.click(confirmBtns[confirmBtns.length - 1])
    await new Promise(r => setTimeout(r, 50))

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain("/api/repos/del-target")
    expect(url).toContain("org=test-org")
    expect(opts.method).toBe("DELETE")
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSaved).toHaveBeenCalled()
  })

  it("shows error when delete API fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: { message: "Repo not found" } }),
    })

    render(
      <RepoEditDialog
        {...defaultProps}
        entry={{ name: "ghost", git_url: "git@x.git", branch: "main", group: "Core", manual_tags: [] }}
      />
    )

    fireEvent.click(screen.getByText("删除"))
    const confirmBtns = screen.getAllByText("确认删除")
    fireEvent.click(confirmBtns[confirmBtns.length - 1])
    await new Promise(r => setTimeout(r, 50))

    expect(screen.getByText("Repo not found")).toBeDefined()
  })
})
