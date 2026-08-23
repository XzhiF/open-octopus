// packages/server/src/services/tasks/__tests__/workflow-ref-resolver.test.ts
//
// task-workflow-handoff (ADR-0013): workflow_ref resolver unit tests.
//
// Seam under test: resolveWorkflowRef / isWorkflowRefResolvable. The resolver is
// a pure function with injectable deps (BuiltInWorkflowService stub +
// TaskHomeService over a temp FS). No DB, no HTTP. We observe the return value
// (source/content/ref).
//
// Resolution set (ADR-0013):
//   ① installed built-in workflow (BuiltInWorkflowService.get returns non-null)
//   ② task home `{home}/workflows/{ref}` (bare filename, .yaml or .yml)
//   global `~/.octopus/workflows/` is NOT in the set — there is no code path
//   that checks it (verified by this test: a ref that matches neither ① nor ②
//   returns null regardless of what's in the global dir).

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import {
  resolveWorkflowRef,
  isWorkflowRefResolvable,
  type WorkflowResolverDeps,
} from "../workflow-ref-resolver"
import { TaskHomeService } from "../task-home-service"

/** Minimal BuiltInWorkflowService stub — maps ref → {content, ref}. */
function stubBuiltIn(entries: Record<string, string>): { get: (ref: string) => { ref: string; content: string } | null } {
  return {
    get(ref: string) {
      // Support both `name` and `group/name` lookup: stub keys are the canonical
      // `group/name`; the stub also matches if the caller passes just `name`.
      if (entries[ref]) {
        return { ref, content: entries[ref] }
      }
      // Bare name lookup: find a key whose `/name` tail matches.
      for (const [key, content] of Object.entries(entries)) {
        if (key.endsWith(`/${ref}`)) {
          return { ref: key, content }
        }
      }
      return null
    },
  }
}

function createTempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-resolver-"))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe("resolveWorkflowRef (ADR-0013 resolution set)", () => {
  let tempBase: string
  let taskHome: TaskHomeService

  beforeEach(() => {
    tempBase = createTempBase()
    taskHome = new TaskHomeService(tempBase)
  })

  afterEach(() => {
    cleanupDir(tempBase)
  })

  function depsFor(taskId: string, builtInEntries: Record<string, string> = {}): WorkflowResolverDeps {
    return {
      builtIn: stubBuiltIn(builtInEntries),
      taskHome,
      taskId,
    }
  }

  // ── empty / invalid ref ─────────────────────────────────────────────
  it("returns null for empty / whitespace-only / non-string ref", () => {
    const d = depsFor("t-1", { "octo/flow": "content" })
    expect(resolveWorkflowRef("", d)).toBeNull()
    expect(resolveWorkflowRef("   ", d)).toBeNull()
    // @ts-expect-error — deliberate type-violation for defensive test
    expect(resolveWorkflowRef(null, d)).toBeNull()
    // @ts-expect-error
    expect(resolveWorkflowRef(undefined, d)).toBeNull()
  })

  // ── builtin branch (①) ──────────────────────────────────────────────
  it("resolves a builtin ref by `group/name` → source=builtin", () => {
    const d = depsFor("t-2", { "octo/backend-flow": "yaml:builtin" })
    const r = resolveWorkflowRef("octo/backend-flow", d)
    expect(r).not.toBeNull()
    expect(r!.source).toBe("builtin")
    expect(r!.content).toBe("yaml:builtin")
    expect(r!.ref).toBe("octo/backend-flow")
  })

  it("resolves a builtin ref by bare name (no group) → source=builtin", () => {
    const d = depsFor("t-2b", { "octo/backend-flow": "yaml:builtin-bare" })
    const r = resolveWorkflowRef("backend-flow", d)
    expect(r).not.toBeNull()
    expect(r!.source).toBe("builtin")
    expect(r!.ref).toBe("octo/backend-flow") // canonical ref echoed back
  })

  // ── task-home branch (②) ────────────────────────────────────────────
  it("resolves a task-home file by `name.yaml` → source=task-home", () => {
    const taskId = "t-3"
    taskHome.createHome(taskId)
    fs.writeFileSync(path.join(taskHome.workflowsDir(taskId), "my-flow.yaml"), "yaml:home", "utf-8")
    const r = resolveWorkflowRef("my-flow.yaml", depsFor(taskId))
    expect(r).not.toBeNull()
    expect(r!.source).toBe("task-home")
    expect(r!.content).toBe("yaml:home")
    expect(r!.ref).toBe("my-flow.yaml")
  })

  it("resolves a task-home file by bare name (no extension) → tries .yaml then .yml", () => {
    const taskId = "t-4"
    taskHome.createHome(taskId)
    fs.writeFileSync(path.join(taskHome.workflowsDir(taskId), "my-flow.yml"), "yaml:home-yml", "utf-8")
    const r = resolveWorkflowRef("my-flow", depsFor(taskId))
    expect(r).not.toBeNull()
    expect(r!.source).toBe("task-home")
    expect(r!.ref).toBe("my-flow.yml")
  })

  it("returns null for a task-home miss (dir exists but file missing)", () => {
    const taskId = "t-5"
    taskHome.createHome(taskId)
    expect(resolveWorkflowRef("missing.yaml", depsFor(taskId))).toBeNull()
    expect(resolveWorkflowRef("missing", depsFor(taskId))).toBeNull()
  })

  it("returns null when task has no home at all", () => {
    expect(resolveWorkflowRef("anything.yaml", depsFor("no-such-task"))).toBeNull()
  })

  // ── precedence: builtin first, then task-home ───────────────────────
  it("builtin wins over task-home when both have a matching ref", () => {
    const taskId = "t-6"
    taskHome.createHome(taskId)
    // Task home has a file called `backend-flow` (would match bare-name lookup).
    fs.writeFileSync(path.join(taskHome.workflowsDir(taskId), "backend-flow"), "yaml:home", "utf-8")
    const d = depsFor(taskId, { "octo/backend-flow": "yaml:builtin" })
    // Bare-name `backend-flow` — builtin tries it first via the stub's bare-name
    // fallback and wins.
    const r = resolveWorkflowRef("backend-flow", d)
    expect(r).not.toBeNull()
    expect(r!.source).toBe("builtin")
  })

  // ── path-injection guard ────────────────────────────────────────────
  it("does not resolve path-escape refs against task home (returns null)", () => {
    const taskId = "t-7"
    taskHome.createHome(taskId)
    // Write a real file, then try to reach it via an escape ref.
    fs.writeFileSync(path.join(taskHome.workflowsDir(taskId), "secret.yaml"), "x", "utf-8")
    expect(resolveWorkflowRef("../secret.yaml", depsFor(taskId))).toBeNull()
    expect(resolveWorkflowRef("sub/secret.yaml", depsFor(taskId))).toBeNull()
  })

  // ── isWorkflowRefResolvable (boolean wrapper) ───────────────────────
  it("isWorkflowRefResolvable is a boolean mirror of resolveWorkflowRef", () => {
    const taskId = "t-8"
    taskHome.createHome(taskId)
    fs.writeFileSync(path.join(taskHome.workflowsDir(taskId), "hit.yaml"), "x", "utf-8")
    const d = depsFor(taskId)
    expect(isWorkflowRefResolvable("hit.yaml", d)).toBe(true)
    expect(isWorkflowRefResolvable("miss.yaml", d)).toBe(false)
    expect(isWorkflowRefResolvable("", d)).toBe(false)
  })

  // ── null BuiltInWorkflowService (server without ResourceManager) ────
  it("works when builtIn is null (only task-home branch checked)", () => {
    const taskId = "t-9"
    taskHome.createHome(taskId)
    fs.writeFileSync(path.join(taskHome.workflowsDir(taskId), "my-flow.yaml"), "x", "utf-8")
    const d: WorkflowResolverDeps = { builtIn: null, taskHome, taskId }
    expect(resolveWorkflowRef("my-flow.yaml", d)?.source).toBe("task-home")
    expect(resolveWorkflowRef("nonexistent", d)).toBeNull()
  })
})
