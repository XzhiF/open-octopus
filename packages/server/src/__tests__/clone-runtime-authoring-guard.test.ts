// packages/server/src/__tests__/clone-runtime-authoring-guard.test.ts
//
// CloneRuntime.sendWithProvider must install the authoring guard for the
// task-author clone — and ONLY for it.
//
// Two things are pinned here that the pure guard tests (command-guard.test.ts,
// path-guard.test.ts) cannot reach, because they exercise the guard function in
// isolation rather than its wiring:
//
//   1. **Scope.** The guard must reach a task-author session (an author must not
//      run the build) but must NOT reach the other built-ins — the workspace
//      clone is a full-stack dev assistant whose whole job is running builds.
//      An unconditional `onBeforeToolCall` would silently break it.
//   2. **The bare-session hole.** `routes/clone/index.ts` passes `undefined`
//      for `taskHomePath` when the task home is missing on disk. The old wiring
//      was `taskHomePath ? buildPathGuard(...) : undefined`, so that session ran
//      with NO hook at all — no write scope AND no command guard. The command
//      half does not need a home, so it must still be installed.
//
// Real CloneRuntime + mocked @octopus/providers capturing sendQuery options
// (the clone-runtime-interaction-session.test.ts convention); HOME points at a
// temp dir so the constructor's mkdir never touches the real ~/.octopus.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

const homeTmp = path.join(os.tmpdir(), `octopus-guard-wiring-home-${Date.now()}`)

const captured = vi.hoisted(() => ({
  opts: null as Record<string, unknown> | null,
}))

vi.mock("@octopus/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octopus/providers")>()
  return {
    ...actual,
    getProvider: () => ({
      getType: () => "claude",
      sendQuery: (_p: string, _cwd: string, _resume: string | undefined, opts: Record<string, unknown>) => {
        captured.opts = opts
        return (async function* () {
          yield { type: "result", sessionId: "fake" }
        })()
      },
    }),
  }
})

import { CloneRuntime } from "../services/agent/clone-runtime"

function cloneDef(name: string, type: "built-in" | "user" = "built-in") {
  return {
    name,
    displayName: name,
    type,
    persona: "",
    skills: [],
    memoryScope: "isolated",
    config: {},
  } as never
}

/** Drive one chat turn and hand back the options the guard was passed in. */
async function optionsFor(def: never, taskHomePath?: string) {
  captured.opts = null
  const runtime = new CloneRuntime(def, "e2e-guard")
  for await (const _chunk of runtime.chat("hi", "s-1", null, homeTmp, undefined, undefined, undefined, taskHomePath)) {
    void _chunk
  }
  return captured.opts!
}

beforeAll(() => {
  process.env.HOME = homeTmp
  process.env.USERPROFILE = homeTmp
})

beforeEach(() => {
  captured.opts = null
})

describe("authoring guard wiring — task-author only", () => {
  it("installs the guard for the task-author clone", async () => {
    const opts = await optionsFor(cloneDef("task-author"), "/tmp/some-task-home")
    expect(typeof opts.onBeforeToolCall).toBe("function")
  })

  it("installs it even when taskHomePath is missing (the bare-session hole)", async () => {
    // The write half has no scope to enforce here, but the command half does —
    // and previously this session got no hook whatsoever.
    const opts = await optionsFor(cloneDef("task-author"), undefined)
    expect(typeof opts.onBeforeToolCall).toBe("function")

    const guard = opts.onBeforeToolCall as (t: string, i: unknown) => Promise<unknown>
    expect(await guard("Bash", { command: "pnpm test" })).toMatchObject({ allow: false })
  })

  it.each(["workspace", "scheduler", "archive", "resource", "harness-agent"])(
    "leaves %s unguarded — it must keep its full command surface",
    async (name) => {
      const opts = await optionsFor(cloneDef(name), "/tmp/some-task-home")
      expect(opts.onBeforeToolCall).toBeUndefined()
    },
  )

  it("leaves user clones unguarded", async () => {
    const opts = await optionsFor(cloneDef("my-own-clone", "user"), undefined)
    expect(opts.onBeforeToolCall).toBeUndefined()
  })
})

describe("authoring guard wiring — end-to-end through the hook", () => {
  it("denies a build but allows the authoring surface", async () => {
    const opts = await optionsFor(cloneDef("task-author"), path.join(homeTmp, "task-home"))
    const guard = opts.onBeforeToolCall as (t: string, i: unknown) => Promise<{ allow: boolean } | undefined>

    expect(await guard("Bash", { command: "mvn verify" })).toMatchObject({ allow: false })
    expect(await guard("Bash", { command: "git commit -m x" })).toMatchObject({ allow: false })
    expect(await guard("Bash", { command: "octopus workflow validate x.yaml" })).toBeUndefined()
    expect(await guard("Bash", { command: "git status" })).toBeUndefined()
    // Reads are never blocked, whatever the path
    expect(await guard("Read", { file_path: "/etc/hosts" })).toBeUndefined()
  })

  it("still blocks writes outside the task home", async () => {
    const home = path.join(homeTmp, "task-home")
    const opts = await optionsFor(cloneDef("task-author"), home)
    const guard = opts.onBeforeToolCall as (t: string, i: unknown) => Promise<{ allow: boolean } | undefined>

    expect(await guard("Write", { file_path: "/Users/dev/project/main.ts" })).toMatchObject({ allow: false })
    expect(await guard("Write", { file_path: path.join(home, "artifacts", "spec.md") })).toBeUndefined()
  })
})

// Referenced so the temp dir is created before CloneRuntime's mkdir runs.
fs.mkdirSync(path.join(homeTmp, ".octopus"), { recursive: true })