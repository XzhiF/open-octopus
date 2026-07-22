import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { useState } from "react"
import { ExecuteNodeDialog } from "./execute-node-dialog"
import * as apiClient from "@/lib/api-client"

vi.mock("@/lib/api-client", () => ({
  fetchWorkflows: vi.fn(),
}))

vi.mock("@/hooks/use-persisted-state", () => ({
  usePersistedState: (_key: string, initial: any) => {
    const [state, setState] = useState(initial)
    const clear = vi.fn()
    return [state, setState, clear]
  },
}))

beforeEach(() => {
  vi.mocked(apiClient.fetchWorkflows).mockResolvedValue([] as any)
})

afterEach(() => {
  vi.resetAllMocks()
})

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  mode: "execute" as const,
  nodeId: "node-1",
  workspaceId: "ws-1",
  workflowName: "test-wf",
  workflowRef: "test-wf.yaml",
  workflowOptions: [],
  initialInputValues: {},
  initialRollbackOnError: false,
  onConfirm: vi.fn(),
}

describe("ExecuteNodeDialog sync checkbox", () => {
  it("shows sync checkbox when hasGitProjects=true", () => {
    render(<ExecuteNodeDialog {...baseProps} hasGitProjects={true} />)
    const switchLabel = screen.getByText("同步主分支")
    expect(switchLabel).toBeDefined()
  })

  it("hides sync checkbox when hasGitProjects=false", () => {
    render(<ExecuteNodeDialog {...baseProps} hasGitProjects={false} />)
    expect(screen.queryByText("同步主分支")).toBeNull()
  })

  it("sync checkbox is checked by default", () => {
    render(<ExecuteNodeDialog {...baseProps} hasGitProjects={true} />)
    const syncSwitch = screen.getByRole("switch", { name: /同步主分支/ })
    expect(syncSwitch.getAttribute("aria-checked")).toBe("true")
  })

  it("onConfirm passes syncMainBranch=true by default", () => {
    const onConfirm = vi.fn()
    render(<ExecuteNodeDialog {...baseProps} hasGitProjects={true} onConfirm={onConfirm} />)
    const confirmBtn = screen.getByRole("button", { name: "确认" })
    fireEvent.click(confirmBtn)
    expect(onConfirm).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ syncMainBranch: true }),
    )
  })

  it("unchecking sync passes syncMainBranch=false", () => {
    const onConfirm = vi.fn()
    render(<ExecuteNodeDialog {...baseProps} hasGitProjects={true} onConfirm={onConfirm} />)
    const syncSwitch = screen.getByRole("switch", { name: /同步主分支/ })
    fireEvent.click(syncSwitch)
    const confirmBtn = screen.getByRole("button", { name: "确认" })
    fireEvent.click(confirmBtn)
    expect(onConfirm).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ syncMainBranch: false }),
    )
  })
})
