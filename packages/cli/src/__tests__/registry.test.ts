import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { RegistryStore } from "../repository/registry"
import type { RegistryEntry, ResourceType } from "@octopus/shared"

const baseTmpDir = mkdtempSync(join(tmpdir(), "octopus-registry-test-"))

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "test-skill",
    type: "skill",
    version: "1.0.0",
    source: { protocol: "builtin", id: "test-skill" },
    hash: "abc123",
    description: "A test skill",
    tags: ["test"],
    dependencies: [],
    size: 1024,
    manifest_path: "manifests/skill/test-skill.yaml",
    cache_path: "cache/skill/test-skill@abc123/",
    registered_at: new Date().toISOString(),
    ...overrides,
  }
}

describe("RegistryStore", () => {
  let testDir: string
  let store: RegistryStore

  beforeEach(() => {
    testDir = mkdtempSync(join(baseTmpDir, "store-"))
    store = new RegistryStore(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(baseTmpDir, { recursive: true, force: true })
  })

  it("starts empty", () => {
    expect(store.list()).toEqual([])
    expect(store.getEntries()).toEqual([])
  })

  it("add() stores an entry and persists", () => {
    const entry = makeEntry()
    store.add(entry)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].name).toBe("test-skill")
  })

  it("add() overwrites entry with same type+name key", () => {
    store.add(makeEntry({ version: "1.0.0" }))
    store.add(makeEntry({ version: "2.0.0" }))
    const items = store.list()
    expect(items).toHaveLength(1)
    expect(items[0].version).toBe("2.0.0")
  })

  it("remove() returns true when entry exists and removes it", () => {
    store.add(makeEntry())
    expect(store.remove("test-skill", "skill")).toBe(true)
    expect(store.list()).toHaveLength(0)
  })

  it("remove() returns false when entry does not exist", () => {
    expect(store.remove("nonexistent", "skill")).toBe(false)
  })

  it("lookup() finds by name + type", () => {
    store.add(makeEntry())
    const found = store.lookup("test-skill", "skill")
    expect(found).toBeDefined()
    expect(found?.name).toBe("test-skill")
  })

  it("lookup() without type searches across all types", () => {
    store.add(makeEntry({ name: "agent-x", type: "agent" }))
    store.add(makeEntry({ name: "skill-y", type: "skill" }))
    const found = store.lookup("agent-x")
    expect(found).toBeDefined()
    expect(found?.type).toBe("agent")
  })

  it("lookup() returns undefined when not found", () => {
    expect(store.lookup("missing")).toBeUndefined()
  })

  it("list() filters by type", () => {
    store.add(makeEntry({ name: "s1", type: "skill" }))
    store.add(makeEntry({ name: "a1", type: "agent" }))
    store.add(makeEntry({ name: "s2", type: "skill" }))
    expect(store.list("skill")).toHaveLength(2)
    expect(store.list("agent")).toHaveLength(1)
    expect(store.list()).toHaveLength(3)
  })

  it("search() matches name, description, tags", () => {
    store.add(makeEntry({ name: "brainstorming", description: "Creative ideas", tags: ["creativity"] }))
    store.add(makeEntry({ name: "reviewer", description: "Code review", tags: ["quality"] }))
    store.add(makeEntry({ name: "designer", description: "UI design", tags: ["creativity", "ui"] }))

    // Name match (exact first)
    const byName = store.search("brainstorming")
    expect(byName[0].name).toBe("brainstorming")

    // Description match
    const byDesc = store.search("review")
    expect(byDesc.some(e => e.name === "reviewer")).toBe(true)

    // Tag match
    const byTag = store.search("creativity")
    expect(byTag).toHaveLength(2)
  })

  it("search() filters by type and tag options", () => {
    store.add(makeEntry({ name: "s1", type: "skill", tags: ["ui"] }))
    store.add(makeEntry({ name: "s2", type: "agent", tags: ["ui"] }))
    store.add(makeEntry({ name: "s3", type: "skill", tags: ["api"] }))

    expect(store.search("s", { type: "skill" })).toHaveLength(2)
    expect(store.search("s", { tag: "ui" })).toHaveLength(2)
    expect(store.search("s", { type: "skill", tag: "ui" })).toHaveLength(1)
  })

  it("getEntries() returns all entries", () => {
    store.add(makeEntry({ name: "a" }))
    store.add(makeEntry({ name: "b" }))
    expect(store.getEntries()).toHaveLength(2)
  })
})
