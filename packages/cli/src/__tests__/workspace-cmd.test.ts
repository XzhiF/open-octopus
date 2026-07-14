import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { workspaceCmd } from "../commands/workspace-cmd"

describe("workspace delete command", () => {
  let fetchSpy: any

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("delete without --cleanup sends request without query param", async () => {
    await workspaceCmd.parseAsync(["delete", "ws-123"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://localhost:3001/api/workspaces/ws-123")
    expect(options.method).toBe("DELETE")
  })

  it("delete with --cleanup sends request with ?mode=cleanup", async () => {
    await workspaceCmd.parseAsync(["delete", "ws-123", "--cleanup"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://localhost:3001/api/workspaces/ws-123?mode=cleanup")
    expect(options.method).toBe("DELETE")
  })

  it("delete shows 'Archived (full)' message on success without --cleanup", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    await workspaceCmd.parseAsync(["delete", "ws-123"], { from: "user" })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Archived (full)"))
    consoleSpy.mockRestore()
  })

  it("delete shows 'Cleaned up' message on success with --cleanup", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    await workspaceCmd.parseAsync(["delete", "ws-123", "--cleanup"], { from: "user" })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Cleaned up"))
    consoleSpy.mockRestore()
  })

  it("delete error handling unchanged", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
    )

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await workspaceCmd.parseAsync(["delete", "ws-999"], { from: "user" })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Not found"))
    consoleSpy.mockRestore()
  })
})
