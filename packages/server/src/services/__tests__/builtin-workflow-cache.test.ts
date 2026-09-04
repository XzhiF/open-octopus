// Ticket 10 — built-in workflow list/detail in-memory cache.
// Seam: BuiltInWorkflowService public list()/get() over a REAL fs tmp dir.
// Assertions are counter-based (parseWorkflow wrapper + readFileSync spy), never timing-based.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import type { ResourceManager, ResourceEntry } from "@octopus/shared"

const counters = vi.hoisted(() => ({ parse: 0, read: 0 }))

vi.mock("@octopus/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octopus/shared")>()
  return {
    ...actual,
    parseWorkflow: (...args: Parameters<typeof actual.parseWorkflow>) => {
      counters.parse++
      return actual.parseWorkflow(...args)
    },
  }
})

import { BuiltInWorkflowService } from "../builtin-workflow"

// readFileSync counter — forwards to the real implementation (call-through spy)
const origReadFileSync = fs.readFileSync
vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
  counters.read++
  return (origReadFileSync as (...a: unknown[]) => unknown)(...args)
}) as unknown as typeof fs.readFileSync)

function wfYaml(name: string): string {
  return [
    "apiVersion: octopus/v1",
    "kind: Workflow",
    `name: ${name}`,
    "inputs:",
    "  environment: { description: env, required: true, default: dev }",
    "nodes:",
    "  - id: step1",
    "    type: bash",
    `    bash: echo ${name}`,
  ].join("\n")
}

function makeEntry(dir: string, name: string): ResourceEntry {
  return {
    name,
    type: "workflow",
    group: "built-in",
    installed: true,
    installPath: dir,
  } as unknown as ResourceEntry
}

function makeManager(entries: ResourceEntry[]): ResourceManager {
  return {
    list: () => ({ resources: entries, total: entries.length }),
    get: (_type: unknown, name: string) => entries.find((e) => e.name === name),
  } as unknown as ResourceManager
}

function writeWorkflow(dir: string, file: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, file)
  fs.writeFileSync(f, wfYaml(name))
  return f
}

/** Deterministically bump mtime so invalidation never depends on clock resolution. */
let futureOffset = 0
function touchFuture(f: string): void {
  futureOffset += 1000 // strictly monotonic across the file — repeated touches never collide
  const t = new Date(Date.now() + futureOffset)
  fs.utimesSync(f, t, t)
}

describe("BuiltInWorkflowService cache", () => {
  let tmpRoot: string

  beforeEach(() => {
    counters.parse = 0
    counters.read = 0
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "E2E_TEST_bwf-cache-"))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("AC1: second list performs no readFileSync/parseWorkflow; list and detail share one parse", () => {
    const dir = path.join(tmpRoot, "demo")
    writeWorkflow(dir, "demo.yaml", "demo")
    const service = new BuiltInWorkflowService(makeManager([makeEntry(dir, "demo")]))

    // cold list → exactly one read + one parse
    const parseBefore = counters.parse
    const readBefore = counters.read
    const cold = service.list()
    expect(cold).toHaveLength(1)
    expect(cold[0].name).toBe("demo")
    expect(counters.parse - parseBefore).toBe(1)
    expect(counters.read - readBefore).toBeGreaterThanOrEqual(1)

    // warm list → zero reads, zero parses, identical result
    const snapshot = { parse: counters.parse, read: counters.read }
    const warm = service.list()
    expect(warm).toEqual(cold)
    expect(counters.parse).toBe(snapshot.parse)
    expect(counters.read).toBe(snapshot.read)

    // detail reuses the parse produced by list (shared)
    const detail = service.get("built-in/demo")
    expect(detail?.parsed.name).toBe("demo")
    expect(detail?.content).toContain("name: demo")
    expect(counters.parse).toBe(snapshot.parse)
    expect(counters.read).toBe(snapshot.read)

    // warm detail → still zero
    service.get("built-in/demo")
    expect(counters.parse).toBe(snapshot.parse)
    expect(counters.read).toBe(snapshot.read)
  })

  it("AC2: rewriting one YAML invalidates only that file on the next request", () => {
    const dirA = path.join(tmpRoot, "a")
    const dirB = path.join(tmpRoot, "b")
    const fileA = writeWorkflow(dirA, "a.yaml", "alpha")
    writeWorkflow(dirB, "b.yaml", "beta")
    const service = new BuiltInWorkflowService(
      makeManager([makeEntry(dirA, "alpha"), makeEntry(dirB, "beta")])
    )

    expect(service.list().map((w) => w.name).sort()).toEqual(["alpha", "beta"])
    expect(counters.parse).toBe(2)

    // modify file A in place (its own mtime changes, file B untouched)
    writeWorkflow(dirA, "a.yaml", "alpha-v2")
    touchFuture(fileA)

    const snapshot = { parse: counters.parse, read: counters.read }
    const after = service.list()
    expect(after.map((w) => w.name).sort()).toEqual(["alpha-v2", "beta"])
    // exactly one re-parse (file A), not two
    expect(counters.parse - snapshot.parse).toBe(1)

    // detail sees the new content with no extra parse
    const detail = service.get("built-in/alpha")
    expect(detail?.content).toContain("name: alpha-v2")
    expect(counters.parse).toBe(snapshot.parse + 1)
  })

  it("AC2b: add/remove of a YAML file invalidates the directory scan", () => {
    const dir = path.join(tmpRoot, "one")
    writeWorkflow(dir, "first.yaml", "first")
    const manager = makeManager([makeEntry(dir, "first")])
    const service = new BuiltInWorkflowService(manager)

    expect(service.list().map((w) => w.name)).toEqual(["first"])

    // remove the yaml → dir mtime changes → next list finds nothing
    fs.rmSync(path.join(dir, "first.yaml"))
    touchFuture(dir)
    expect(service.list()).toHaveLength(0)

    // add a yaml under a different filename → dir scan re-runs
    writeWorkflow(dir, "second.yaml", "second")
    touchFuture(dir)
    expect(service.list().map((w) => w.name)).toEqual(["second"])
  })

  it("non-workflow yaml: skip decision is cached too (no re-read, no parse)", () => {
    const dir = path.join(tmpRoot, "plain")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "plain.yaml"), "hello: world\n")

    const service = new BuiltInWorkflowService(makeManager([makeEntry(dir, "plain")]))
    expect(service.list()).toHaveLength(0)
    expect(counters.parse).toBe(0)

    const snapshot = { parse: counters.parse, read: counters.read }
    expect(service.list()).toHaveLength(0)
    expect(counters.parse).toBe(snapshot.parse)
    expect(counters.read).toBe(snapshot.read)
  })
})
