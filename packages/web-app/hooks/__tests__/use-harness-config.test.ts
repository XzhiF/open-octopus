import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

// Mock the API module
vi.mock("@/lib/harness-config-api", () => ({
  fetchHarnessConfig: vi.fn(),
  saveHarnessConfig: vi.fn(),
}))

import {
  fetchHarnessConfig,
  saveHarnessConfig,
} from "@/lib/harness-config-api"
import { useHarnessConfig } from "../use-harness-config"

const mockedFetch = vi.mocked(fetchHarnessConfig)
const mockedSave = vi.mocked(saveHarnessConfig)

const SAMPLE_YAML = `detectors:
  stupid_retry:
    enabled: true
    threshold: 2
`

describe("useHarnessConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Initial load ────────────────────────────────────────────────

  it("loads config on mount", async () => {
    mockedFetch.mockResolvedValue({
      config: SAMPLE_YAML,
      version: 3,
      source: "db",
    })

    const { result } = renderHook(() => useHarnessConfig())

    // Initially loading
    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.content).toBe(SAMPLE_YAML)
    expect(result.current.savedContent).toBe(SAMPLE_YAML)
    expect(result.current.version).toBe(3)
    expect(result.current.source).toBe("db")
    expect(result.current.isDirty).toBe(false)
  })

  it("sets loadError when fetch fails", async () => {
    mockedFetch.mockRejectedValue(new Error("Network error"))

    const { result } = renderHook(() => useHarnessConfig())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.loadError).toBe("Network error")
    expect(result.current.content).toBe("")
  })

  // ── Dirty checking ─────────────────────────────────────────────

  it("isDirty is true when content differs from saved", async () => {
    mockedFetch.mockResolvedValue({
      config: SAMPLE_YAML,
      version: 1,
      source: "defaults",
    })

    const { result } = renderHook(() => useHarnessConfig())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.isDirty).toBe(false)

    act(() => {
      result.current.setContent("modified: true\n")
    })

    expect(result.current.isDirty).toBe(true)
  })

  // ── Save ───────────────────────────────────────────────────────

  it("save updates version and savedContent on success", async () => {
    mockedFetch.mockResolvedValue({
      config: SAMPLE_YAML,
      version: 1,
      source: "defaults",
    })
    mockedSave.mockResolvedValue({ success: true, version: 2 })

    const { result } = renderHook(() => useHarnessConfig())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    act(() => {
      result.current.setContent("modified: true\n")
    })

    expect(result.current.isDirty).toBe(true)

    let saved = false
    await act(async () => {
      saved = await result.current.save()
    })

    expect(saved).toBe(true)
    expect(result.current.version).toBe(2)
    expect(result.current.savedContent).toBe("modified: true\n")
    expect(result.current.isDirty).toBe(false)
    expect(result.current.source).toBe("db")
  })

  it("save sets validationErrors on failure with details", async () => {
    mockedFetch.mockResolvedValue({
      config: SAMPLE_YAML,
      version: 1,
      source: "defaults",
    })

    const validationErr = new Error("Validation failed") as Error & {
      details?: Array<{ path: string; message: string; code: string }>
    }
    validationErr.details = [
      { path: "detectors.foo", message: "Unknown detector", code: "invalid" },
    ]
    mockedSave.mockRejectedValue(validationErr)

    const { result } = renderHook(() => useHarnessConfig())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    act(() => {
      result.current.setContent("invalid yaml")
    })

    let saved = false
    await act(async () => {
      saved = await result.current.save()
    })

    expect(saved).toBe(false)
    expect(result.current.validationErrors).toHaveLength(1)
    expect(result.current.validationErrors[0].path).toBe("detectors.foo")
  })

  // ── Reset ──────────────────────────────────────────────────────

  it("reset reverts content to saved version", async () => {
    mockedFetch.mockResolvedValue({
      config: SAMPLE_YAML,
      version: 1,
      source: "defaults",
    })

    const { result } = renderHook(() => useHarnessConfig())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    act(() => {
      result.current.setContent("modified content")
    })

    expect(result.current.isDirty).toBe(true)

    act(() => {
      result.current.reset()
    })

    expect(result.current.content).toBe(SAMPLE_YAML)
    expect(result.current.isDirty).toBe(false)
  })

  // ── Reset to defaults ──────────────────────────────────────────

  it("resetToDefaults replaces content with defaults YAML", async () => {
    mockedFetch.mockResolvedValue({
      config: SAMPLE_YAML,
      version: 1,
      source: "db",
    })

    const { result } = renderHook(() => useHarnessConfig())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const defaultsYaml = "detectors: {}\nstrategies: []\n"

    act(() => {
      result.current.resetToDefaults(defaultsYaml)
    })

    expect(result.current.content).toBe(defaultsYaml)
    expect(result.current.isDirty).toBe(true)
    expect(result.current.validationErrors).toEqual([])
  })

  // ── Reload ─────────────────────────────────────────────────────

  it("reload fetches config from server again", async () => {
    const newYaml = "detectors:\n  updated: true\n"
    mockedFetch
      .mockResolvedValueOnce({
        config: SAMPLE_YAML,
        version: 1,
        source: "defaults",
      })
      .mockResolvedValueOnce({
        config: newYaml,
        version: 5,
        source: "db",
      })

    const { result } = renderHook(() => useHarnessConfig())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.version).toBe(1)

    await act(async () => {
      await result.current.reload()
    })

    expect(result.current.content).toBe(newYaml)
    expect(result.current.version).toBe(5)
    expect(result.current.source).toBe("db")
  })
})
