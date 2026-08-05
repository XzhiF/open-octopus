import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// Mock the hook
vi.mock("@/hooks/use-harness-config", () => ({
  useHarnessConfig: vi.fn(),
}))

// Mock the Monaco editor to avoid loading it in tests
vi.mock("@/components/workspace/workflow-yaml-editor", () => ({
  WorkflowYamlEditor: ({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave?: () => void }) => (
    <div data-testid="yaml-editor">
      <textarea
        data-testid="yaml-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {onSave && (
        <button data-testid="editor-save-btn" onClick={onSave}>
          Editor Save
        </button>
      )}
    </div>
  ),
}))

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

import { HarnessConfigPage } from "../harness-config-page"
import { useHarnessConfig } from "@/hooks/use-harness-config"
import { toast } from "sonner"

const mockUseHarnessConfig = vi.mocked(useHarnessConfig)
const mockToast = vi.mocked(toast)

function makeHookReturn(overrides: Partial<ReturnType<typeof useHarnessConfig>> = {}) {
  return {
    content: "detectors:\n  stupid_retry:\n    enabled: true\n",
    savedContent: "detectors:\n  stupid_retry:\n    enabled: true\n",
    version: 3,
    source: "db" as const,
    loading: false,
    saving: false,
    loadError: null,
    validationErrors: [],
    isDirty: false,
    setContent: vi.fn(),
    save: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    resetToDefaults: vi.fn(),
    ...overrides,
  }
}

describe("HarnessConfigPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Loading state ──────────────────────────────────────────────

  it("shows loading spinner when loading", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn({ loading: true }))

    const { container } = render(<HarnessConfigPage />)

    // The Loader2 component renders an SVG with animate-spin class
    const spinner = container.querySelector(".animate-spin")
    expect(spinner).toBeDefined()
  })

  // ── Error state ────────────────────────────────────────────────

  it("shows error card when loadError is set", () => {
    mockUseHarnessConfig.mockReturnValue(
      makeHookReturn({ loadError: "Connection refused" })
    )

    render(<HarnessConfigPage />)

    expect(screen.getByText("加载失败")).toBeDefined()
    expect(screen.getByText("Connection refused")).toBeDefined()
    expect(screen.getByText("重试")).toBeDefined()
  })

  // ── Main UI ────────────────────────────────────────────────────

  it("renders toolbar with title and version", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn())

    render(<HarnessConfigPage />)

    expect(screen.getByText("Harness 配置")).toBeDefined()
    expect(screen.getByText("v3")).toBeDefined()
  })

  it("shows source badge as '自定义' when source is db", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn({ source: "db" }))

    render(<HarnessConfigPage />)

    expect(screen.getByText("自定义")).toBeDefined()
  })

  it("shows source badge as '内置默认' when source is defaults", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn({ source: "defaults" }))

    render(<HarnessConfigPage />)

    expect(screen.getByText("内置默认")).toBeDefined()
  })

  // ── Save button ────────────────────────────────────────────────

  it("save button is disabled when not dirty", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn({ isDirty: false }))

    render(<HarnessConfigPage />)

    const saveButton = screen.getByText("保存")
    expect(saveButton.closest("button")?.disabled).toBe(true)
  })

  it("save button is enabled when dirty", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn({ isDirty: true }))

    render(<HarnessConfigPage />)

    const saveButton = screen.getByText("保存")
    expect(saveButton.closest("button")?.disabled).toBe(false)
  })

  it("calls save and shows success toast on save click", async () => {
    const mockSave = vi.fn().mockResolvedValue(true)
    mockUseHarnessConfig.mockReturnValue(
      makeHookReturn({ isDirty: true, save: mockSave, validationErrors: [] })
    )

    render(<HarnessConfigPage />)

    const saveButton = screen.getByText("保存")
    fireEvent.click(saveButton.closest("button")!)

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalled()
    })

    expect(mockToast.success).toHaveBeenCalledWith(
      "Harness 配置已保存，新执行将使用新配置"
    )
  })

  it("shows error toast when save fails with validation errors", async () => {
    const mockSave = vi.fn().mockResolvedValue(false)
    mockUseHarnessConfig.mockReturnValue(
      makeHookReturn({
        isDirty: true,
        save: mockSave,
        validationErrors: [
          { path: "detectors", message: "Invalid", code: "invalid" },
        ],
      })
    )

    render(<HarnessConfigPage />)

    const saveButton = screen.getByText("保存")
    fireEvent.click(saveButton.closest("button")!)

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalled()
    })

    expect(mockToast.error).toHaveBeenCalledWith("校验失败：1 个错误")
  })

  // ── Dirty indicator ────────────────────────────────────────────

  it("shows '未保存' indicator when dirty", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn({ isDirty: true }))

    render(<HarnessConfigPage />)

    expect(screen.getByText("未保存")).toBeDefined()
  })

  it("shows undo button when dirty", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn({ isDirty: true }))

    render(<HarnessConfigPage />)

    expect(screen.getByText("撤销")).toBeDefined()
  })

  // ── Reset to defaults ──────────────────────────────────────────

  it("calls resetToDefaults when '恢复默认' is clicked", () => {
    const mockResetToDefaults = vi.fn()
    mockUseHarnessConfig.mockReturnValue(
      makeHookReturn({ resetToDefaults: mockResetToDefaults })
    )

    render(<HarnessConfigPage />)

    const resetButton = screen.getByText("恢复默认")
    fireEvent.click(resetButton)

    expect(mockResetToDefaults).toHaveBeenCalledWith(expect.any(String))
    expect(mockToast.info).toHaveBeenCalledWith("已恢复默认配置（尚未保存）")
  })

  // ── Reload ─────────────────────────────────────────────────────

  it("calls reload when '重新加载' is clicked", async () => {
    const mockReload = vi.fn().mockResolvedValue(undefined)
    mockUseHarnessConfig.mockReturnValue(
      makeHookReturn({ reload: mockReload })
    )

    render(<HarnessConfigPage />)

    const reloadButton = screen.getByText("重新加载")
    fireEvent.click(reloadButton)

    await waitFor(() => {
      expect(mockReload).toHaveBeenCalled()
    })

    expect(mockToast.info).toHaveBeenCalledWith("已重新加载配置")
  })

  // ── Validation errors ──────────────────────────────────────────

  it("displays validation errors panel when present", () => {
    mockUseHarnessConfig.mockReturnValue(
      makeHookReturn({
        validationErrors: [
          { path: "detectors.foo", message: "Unknown detector type", code: "invalid" },
          { path: "strategies[0]", message: "Missing match field", code: "required" },
        ],
      })
    )

    render(<HarnessConfigPage />)

    expect(screen.getByText("校验错误")).toBeDefined()
    expect(screen.getByText("2 个校验错误")).toBeDefined()
    // Text is split across elements, so use a function matcher
    expect(screen.getByText((_, el) => el?.textContent === "detectors.foo: Unknown detector type")).toBeDefined()
    expect(screen.getByText((_, el) => el?.textContent === "strategies[0]: Missing match field")).toBeDefined()
  })

  // ── Status bar ─────────────────────────────────────────────────

  it("shows '配置有效' when no validation errors", () => {
    mockUseHarnessConfig.mockReturnValue(
      makeHookReturn({ validationErrors: [] })
    )

    render(<HarnessConfigPage />)

    expect(screen.getByText("配置有效")).toBeDefined()
  })

  it("shows error count in status bar when validation errors exist", () => {
    mockUseHarnessConfig.mockReturnValue(
      makeHookReturn({
        validationErrors: [
          { path: "", message: "err1", code: "e1" },
          { path: "", message: "err2", code: "e2" },
        ],
      })
    )

    render(<HarnessConfigPage />)

    expect(screen.getByText("2 个校验错误")).toBeDefined()
  })

  it("shows info about running executions not being affected", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn())

    render(<HarnessConfigPage />)

    expect(
      screen.getByText("配置变更仅影响新的执行，正在运行的 execution 不受影响")
    ).toBeDefined()
  })

  // ── Editor ─────────────────────────────────────────────────────

  it("renders the YAML editor", () => {
    mockUseHarnessConfig.mockReturnValue(makeHookReturn())

    render(<HarnessConfigPage />)

    expect(screen.getByTestId("yaml-editor")).toBeDefined()
  })
})
