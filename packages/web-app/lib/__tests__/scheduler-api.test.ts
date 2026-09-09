import { describe, it, expect, beforeEach, vi } from "vitest"
import { listJobs, abortJob } from "../scheduler-api"

/** Build a minimal fetch Response double for happy-path assertions. */
function mockJsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response
}

describe("listJobs", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal("fetch", vi.fn())
  })

  it("GETs /api/scheduler/jobs with only the surviving filters", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(mockJsonResponse({ items: [], total: 0, page: 1, limit: 20 }))

    await listJobs({ page: 2, limit: 10, search: "nightly", job_type: "job" })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain("/api/scheduler/jobs?")
    expect(url).toContain("page=2")
    expect(url).toContain("limit=10")
    expect(url).toContain("search=nightly")
    // job_type='job' is the third type 票03 added (a registered TS handler) — it is a
    // filterable row of this table now, not something the client hides.
    expect(url).toContain("job_type=job")
  })

  // ADR-0021 票03: ?trigger_source= / ?origin= left the route with the origin_* columns.
  // ListJobsParams no longer declares them, so nothing can put them on the query string.
  it("never sends the retired trigger_source / origin query params", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(mockJsonResponse({ items: [], total: 0, page: 1, limit: 20 }))

    await listJobs({ search: "x" })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).not.toContain("trigger_source=")
    expect(url).not.toContain("origin=")
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

// POST /api/scheduler/jobs/:id/enqueue + SchedulerService.enqueueJob were deleted by
// ADR-0021 票03 (a job definition is registered, never parked — the 'draft' schedule
// status went with it). The task-side confirm/trigger surface it used to serve is now
// covered in lib/__tests__/tasks-api.test.ts (triggerTask / scheduleTaskTrigger).
