import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))

import { listSkillGroups } from "../skill-groups-api"

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true
  const status = init.status ?? (ok ? 200 : 500)
  const json = async () => body
  ;(globalThis.fetch as unknown as { mockResolvedValueOnce: (v: unknown) => unknown }).mockResolvedValueOnce({
    ok,
    status,
    json,
  } as unknown as Response)
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("listSkillGroups", () => {
  it("GETs /api/skill-groups and returns the groups array", async () => {
    // Server route (skill-groups.ts) always emits the built-in "default" empty
    // marker first (D17), then registry groups with their skills.
    mockFetchOnce({
      groups: [
        { group: "default", displayName: "default", skills: [] },
        {
          group: "open-spec",
          displayName: "open-spec",
          skills: [{ name: "open-spec", description: "spec.md docs" }],
        },
      ],
    })

    const result = await listSkillGroups()

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/skill-groups")
    expect(init?.method ?? "GET").toBe("GET")
    expect(result.groups).toHaveLength(2)
    expect(result.groups[0]!.group).toBe("default")
    expect(result.groups[0]!.skills).toEqual([])
    expect(result.groups[1]!.skills[0]).toMatchObject({ name: "open-spec" })
  })

  it("returns an empty groups array when the server responds with one", async () => {
    // Defensive: a server with no installed skills still returns the default
    // marker, but a malformed/empty response should not crash the client.
    mockFetchOnce({ groups: [] })
    const result = await listSkillGroups()
    expect(result.groups).toEqual([])
  })

  it("throws on HTTP error with body.error message", async () => {
    mockFetchOnce({ error: "registry offline" }, { ok: false, status: 500 })
    await expect(listSkillGroups()).rejects.toThrow("registry offline")
  })
})
