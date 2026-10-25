// Per-phase fixed experts reach workflow agent nodes at engine construction
// time (the engine's AgentExecutor, not the server scheduler one).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { TaskDAO } from "../db/dao"
import { buildPhaseExpertContext, injectPhaseExpertContext } from "../services/tasks/phase-expert-context"

let db: Database.Database
let taskDAO: TaskDAO

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  taskDAO = new TaskDAO(db)
  taskDAO.insert({
    id: "t-expert",
    org: "e2e",
    name: "phase expert test",
    task_spec: JSON.stringify({
      format: "v4",
      phases: [
        { index: 1, experts: ["engineering-software-architect", "engineering-code-reviewer"] },
        { index: 2, experts: [] },
      ],
    }),
  })
})

afterAll(() => {
  db.close()
})

describe("phase expert context", () => {
  it("builds the roster block for the current phase only", () => {
    const phase1 = buildPhaseExpertContext(db, "t-expert", 1)
    expect(phase1).toContain("## 当前阶段固定专家（任务规格锁定）")
    expect(phase1).toContain("软件架构师")
    expect(phase1).toContain("代码审查员")
    expect(buildPhaseExpertContext(db, "t-expert", 2)).toBe("")
    expect(buildPhaseExpertContext(db, "missing", 1)).toBe("")
  })

  it("prepends to goal/prompt nodes (including nested) without mutating the source", () => {
    const workflow = {
      nodes: [
        { id: "develop", type: "agent", goal: "implement it" },
        { id: "ship", type: "agent", prompt: "ship it" },
        {
          id: "loop",
          type: "loop",
          nodes: [{ id: "inner", type: "agent", prompt: "inner work" }],
        },
        { id: "bash", type: "bash", command: "true" },
      ],
    }
    const source = JSON.parse(JSON.stringify(workflow))
    const context = "## 当前阶段固定专家（任务规格锁定）\n- architect"
    const injected = injectPhaseExpertContext(workflow, context) as typeof workflow

    expect(injected.nodes[0].goal).toBe(`${context}\n\n---\n\nimplement it`)
    expect(injected.nodes[1].prompt).toBe(`${context}\n\n---\n\nship it`)
    const loop = injected.nodes[2] as { nodes: Array<{ prompt?: string }> }
    expect(loop.nodes[0].prompt).toBe(`${context}\n\n---\n\ninner work`)
    expect(injected.nodes[3]).toEqual({ id: "bash", type: "bash", command: "true" })
    // Source workflow must stay untouched (shared parsed workflow object).
    expect(workflow).toEqual(source)
  })

  it("is a no-op when no expert is configured", () => {
    const workflow = { nodes: [{ id: "a", type: "agent", prompt: "x" }] }
    expect(injectPhaseExpertContext(workflow, "")).toBe(workflow)
  })
})
