import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))

import {
  listCabins, createCabin, attachCabin, getCabin, patchCabin, deleteCabin,
  initCabin, getCabinInit, retryCabinInit, wakeCabin, archiveCabin, reopenCabin,
  listCabinRepos, dispatchCabinJob, setCabinFocus, clearCabinFocus, cabinEventsUrl,
  CabinApiError,
} from "../cabin-api"

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true
  const status = init.status ?? (ok ? 200 : 500)
  ;(globalThis.fetch as unknown as { mockResolvedValueOnce: (v: unknown) => unknown }).mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as unknown as Response)
}

const cabinRow = {
  id: "cabin-1", name: "Aurora 结算平台", path: "/tmp/aurora",
  workspace_id: "ws-1", main_session_id: "sess-1", requirements: "",
  status: "active", mainline_strategy: "clean-main", org: "xzf",
  focused_job_id: null, version: 1,
  created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z",
  last_active_at: null, archived_at: null, cockpit_prefs: null,
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("cabin-api CRUD", () => {
  it("listCabins GETs /api/cabins and unwraps cabins[]", async () => {
    mockFetchOnce({ cabins: [cabinRow] })
    const rows = await listCabins()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe("Aurora 结算平台")
    expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:3001/api/cabins")
  })

  it("listCabins passes ?status= when filtering", async () => {
    mockFetchOnce({ cabins: [] })
    await listCabins("archived")
    expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:3001/api/cabins?status=archived")
  })

  it("createCabin POSTs the body and unwraps cabin", async () => {
    mockFetchOnce({ cabin: cabinRow }, { status: 201 })
    const cabin = await createCabin({ name: "Aurora", path: "/tmp/aurora", org: "xzf", repos: ["a"] })
    expect(cabin.id).toBe("cabin-1")
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/cabins")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ name: "Aurora", path: "/tmp/aurora", org: "xzf", repos: ["a"] })
  })

  it("attachCabin POSTs /attach", async () => {
    mockFetchOnce({ cabin: cabinRow }, { status: 201 })
    await attachCabin("/tmp/aurora", "Aurora")
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/cabins/attach")
    expect(JSON.parse(init.body)).toEqual({ path: "/tmp/aurora", name: "Aurora" })
  })

  it("getCabin returns {cabin, view} verbatim (derived view is server truth)", async () => {
    const view = { cabin: cabinRow, attention: [], health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 5 }, iterations: [], open_findings: 0 }
    mockFetchOnce({ cabin: cabinRow, view })
    const result = await getCabin("cabin-1")
    expect(result.view).toEqual(view)
  })

  it("patchCabin sends version + fields", async () => {
    mockFetchOnce({ cabin: { ...cabinRow, version: 2 } })
    await patchCabin("cabin-1", 1, { name: "新名" })
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/cabins/cabin-1")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body)).toEqual({ version: 1, name: "新名" })
  })

  it("deleteCabin DELETEs", async () => {
    mockFetchOnce({ ok: true })
    await deleteCabin("cabin-1")
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("DELETE")
  })

  it("surfaces server error message + status as CabinApiError (409 conflict)", async () => {
    mockFetchOnce({ error: "version conflict" }, { ok: false, status: 409 })
    await expect(patchCabin("cabin-1", 1, {})).rejects.toMatchObject({
      name: "CabinApiError", status: 409, message: "version conflict",
    })
  })
})

describe("cabin-api init / lifecycle", () => {
  it("initCabin POSTs /init", async () => {
    mockFetchOnce({ cabin: { ...cabinRow, status: "initializing" } }, { status: 202 })
    const cabin = await initCabin("cabin-1")
    expect(cabin.status).toBe("initializing")
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("http://localhost:3001/api/cabins/cabin-1/init")
  })

  it("getCabinInit returns status + gate state", async () => {
    mockFetchOnce({ status: "initializing", state: { items: [{ key: "dir", label: "目录可写", state: "done" }] } })
    const result = await getCabinInit("cabin-1")
    expect(result.state.items[0].key).toBe("dir")
  })

  it("retryCabinInit POSTs /init/retry", async () => {
    mockFetchOnce({ ok: true, status: "initializing" }, { status: 202 })
    await retryCabinInit("cabin-1")
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/cabins/cabin-1/init/retry")
    expect(init.method).toBe("POST")
  })

  it("wake/archive/reopen hit their lifecycle endpoints", async () => {
    mockFetchOnce({ cabin: cabinRow })
    await wakeCabin("cabin-1")
    mockFetchOnce({ cabin: { ...cabinRow, status: "archived" } })
    await archiveCabin("cabin-1")
    mockFetchOnce({ cabin: cabinRow })
    await reopenCabin("cabin-1")
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(urls).toEqual([
      "http://localhost:3001/api/cabins/cabin-1/wake",
      "http://localhost:3001/api/cabins/cabin-1/archive",
      "http://localhost:3001/api/cabins/cabin-1/reopen",
    ])
  })
})

describe("cabin-api repos / jobs / focus / SSE", () => {
  it("listCabinRepos unwraps repos[] with git enrichment", async () => {
    mockFetchOnce({ repos: [{ name: "a", worktree_path: "/tmp/wt", git: { branch: "cabin-cabin-1", detached: false, commit: "abcd1234" } }] })
    const repos = await listCabinRepos("cabin-1")
    expect(repos[0].git?.branch).toBe("cabin-cabin-1")
  })

  it("dispatchCabinJob POSTs mandate + priority", async () => {
    mockFetchOnce({ job: { id: "job-1" } }, { status: 201 })
    await dispatchCabinJob("cabin-1", { kind: "task", title: "接入渠道", mandate: { strength: "explicit" }, priority: 3 })
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/cabins/cabin-1/jobs")
    expect(JSON.parse(init.body)).toMatchObject({ kind: "task", priority: 3, mandate: { strength: "explicit" } })
  })

  it("setCabinFocus POSTs version + job_id; clearCabinFocus DELETEs with ?version=", async () => {
    mockFetchOnce({ cabin: cabinRow })
    await setCabinFocus("cabin-1", 2, "job-1")
    mockFetchOnce({ cabin: cabinRow })
    await clearCabinFocus("cabin-1", 3)
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(JSON.parse(calls[0][1].body)).toEqual({ version: 2, job_id: "job-1" })
    expect(calls[1][0]).toBe("http://localhost:3001/api/cabins/cabin-1/focus?version=3")
    expect(calls[1][1].method).toBe("DELETE")
  })

  it("cabinEventsUrl points at the SSE endpoint", () => {
    expect(cabinEventsUrl("cabin-1")).toBe("http://localhost:3001/api/cabins/cabin-1/events")
  })
})