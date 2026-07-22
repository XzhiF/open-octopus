import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { ExecutionLogViewer } from "./execution-log-viewer"
import { useExecutionEvents } from "@/hooks/use-execution-events"

vi.mock("@/hooks/use-execution-events")
const mockedHook = vi.mocked(useExecutionEvents)

afterEach(() => {
  vi.resetAllMocks()
})

describe("ExecutionLogViewer engine_init rendering", () => {
  it("renders engine_init_warning in yellow style", () => {
    mockedHook.mockReturnValue({
      events: [
        {
          event: "engine_init_warning",
          projectName: "proj-1",
          errorMessage: "merge failed",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ] as any,
      loopIterations: {},
      groups: [
        {
          key: "engine_init",
          nodeId: "engine_init",
          events: [
            { event: "engine_init_warning", projectName: "proj-1", errorMessage: "merge failed" } as any,
          ],
        },
      ],
      totalCount: 1,
      isTrimmed: false,
      loading: false,
      error: null,
    })

    render(<ExecutionLogViewer workspaceId="ws" executionId="exec" executionStatus="completed" />)
    // Should show the warning label with yellow color class
    const warningText = screen.getByText(/同步警告/)
    expect(warningText.className).toContain("text-yellow-400")
  })

  it("renders engine_init_info in blue style", () => {
    mockedHook.mockReturnValue({
      events: [
        { event: "engine_init_info", projectName: "proj-feat", message: "on feature branch", timestamp: "2026-01-01T00:00:00.000Z" } as any,
      ] as any,
      loopIterations: {},
      groups: [
        {
          key: "engine_init",
          nodeId: "engine_init",
          events: [{ event: "engine_init_info", projectName: "proj-feat", message: "on feature branch" } as any],
        },
      ],
      totalCount: 1,
      isTrimmed: false,
      loading: false,
      error: null,
    })

    render(<ExecutionLogViewer workspaceId="ws" executionId="exec" executionStatus="completed" />)
    const infoText = screen.getByText(/同步信息/)
    expect(infoText.className).toContain("text-blue-400")
  })

  it("shows trimming banner when isTrimmed=true", () => {
    mockedHook.mockReturnValue({
      events: [{ event: "engine_init_complete", timestamp: "2026-01-01T00:00:00.000Z" } as any],
      loopIterations: {},
      groups: [
        {
          key: "engine_init",
          nodeId: "engine_init",
          events: [{ event: "engine_init_complete" } as any],
        },
      ],
      totalCount: 250,
      isTrimmed: true,
      loading: false,
      error: null,
    })

    render(<ExecutionLogViewer workspaceId="ws" executionId="exec" executionStatus="completed" />)
    expect(screen.getByText(/显示最新 100 \/ 共 250 条事件/)).toBeDefined()
  })

  it("no trimming banner when isTrimmed=false", () => {
    mockedHook.mockReturnValue({
      events: [{ event: "engine_init_complete", timestamp: "2026-01-01T00:00:00.000Z" } as any],
      loopIterations: {},
      groups: [
        {
          key: "engine_init",
          nodeId: "engine_init",
          events: [{ event: "engine_init_complete" } as any],
        },
      ],
      totalCount: 50,
      isTrimmed: false,
      loading: false,
      error: null,
    })

    render(<ExecutionLogViewer workspaceId="ws" executionId="exec" executionStatus="completed" />)
    expect(screen.queryByText(/显示最新 100/)).toBeNull()
  })
})
