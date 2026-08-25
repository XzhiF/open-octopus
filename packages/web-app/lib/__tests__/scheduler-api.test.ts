import { describe, it, expect, beforeEach, vi } from "vitest"
import { enqueueJob, abortJob } from "../scheduler-api"

/** Build a minimal fetch Response double for happy-path assertions. */
function mockJsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response
}

describe("enqueueJob", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal("fetch", vi.fn())
  })

  it("POSTs to /api/scheduler/jobs/:id/enqueue and returns the parsed body (AC: 入队 draft→queued)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(mockJsonResponse({ ok: true }))

    const result = await enqueueJob("job-1")

    // Arrange the expected request shape, then assert the call matches exactly.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://localhost:3001/api/scheduler/jobs/job-1/enqueue")
    expect(init.method).toBe("POST")
    // enqueue is a confirm-gate trigger — no request body.
    expect(init.body).toBeUndefined()
    expect(result).toEqual({ ok: true })
  })

  it("throws when the server rejects the enqueue", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "already queued" }),
    } as Response)

    await expect(enqueueJob("job-1")).rejects.toThrow("already queued")
  })
})

describe("abortJob", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal("fetch", vi.fn())
  })

  it("POSTs to /api/scheduler/jobs/:id/abort and returns the parsed body (G4: 中止 → aborted)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(mockJsonResponse({ ok: true }))

    const result = await abortJob("job-1")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://localhost:3001/api/scheduler/jobs/job-1/abort")
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
    expect(result).toEqual({ ok: true })
  })
})
