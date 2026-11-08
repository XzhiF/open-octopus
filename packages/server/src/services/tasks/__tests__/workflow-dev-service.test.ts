// workflow-dev task kind (2026-11-06): source-of-truth file / verification /
// completion service. The engine simulator is exercised with strict=false
// (mocks optional) so the test stays hermetic.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { TaskDAO } from "../../../db/dao"
import { TaskHomeService } from "../task-home-service"
import { WorkflowDevService } from "../workflow-dev-service"

const WORKFLOW = `apiVersion: octopus/v1
kind: Workflow
name: my-flow
description: demo workflow
nodes:
  - id: step
    type: bash
    bash: echo hi
`

const FIXTURE = `scenarios:
  - name: basic
    mocks: {}
    assertions:
      status: completed
`

describe("WorkflowDevService — workflow-dev task kind", () => {
  let db: Database.Database
  let tmp: string
  let wsDir: string
  let homeService: TaskHomeService
  let taskDAO: TaskDAO
  let service: WorkflowDevService
  let emitted: Array<{ taskId: string; status: string }>

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dev-"))
    wsDir = path.join(tmp, "ws")
    fs.mkdirSync(wsDir, { recursive: true })
    process.env.OCTOPUS_HOME = path.join(tmp, "octopus")

    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "ws-1", wsDir, now, now)

    taskDAO = new TaskDAO(db)
    taskDAO.insert({
      id: "t-1",
      name: "wf task",
      status: "draft",
      workspace_id: "ws-1",
      task_spec: JSON.stringify({ format: "v4", kind: "workflow-dev" }),
    })

    homeService = new TaskHomeService(tmp)
    homeService.createHome("t-1")
    emitted = []
    service = new WorkflowDevService({
      db,
      taskDAO,
      taskHomeService: homeService,
      workspaceService: {
        getById: () => ({ id: "ws-1", path: wsDir }),
      } as never,
      emitTaskStatus: (taskId, status) => emitted.push({ taskId, status }),
    })
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.OCTOPUS_HOME
  })

  it("saves to task home + mirrors to the workspace and invalidates old verification", () => {
    const snap = service.save("t-1", WORKFLOW)
    expect(snap.ref).toBe("my-flow.yaml")
    expect(snap.state.active_ref).toBe("my-flow.yaml")
    expect(fs.existsSync(path.join(homeService.workflowsDir("t-1"), "my-flow.yaml"))).toBe(true)
    expect(fs.existsSync(path.join(wsDir, "workflows", "my-flow.yaml"))).toBe(true)

    expect(service.validate("t-1").valid).toBe(true)
    expect(service.getState("t-1").state.validation?.valid).toBe(true)

    service.save("t-1", WORKFLOW.replace("echo hi", "echo bye"))
    expect(service.getState("t-1").state.validation).toBeUndefined()
  })

  it("blocks a real run until validation + simulation pass", async () => {
    service.save("t-1", WORKFLOW)
    expect(service.canRun("t-1", "my-flow.yaml")).toMatchObject({ ok: false })

    service.validate("t-1")
    expect(service.canRun("t-1", "my-flow.yaml")).toMatchObject({ ok: false })

    fs.writeFileSync(path.join(homeService.workflowsDir("t-1"), "my-flow.test.yaml"), FIXTURE, "utf-8")
    const sim = await service.simulate("t-1", { strict: false })
    expect(sim.passed).toBe(true)
    expect(service.canRun("t-1", "my-flow.yaml")).toEqual({ ok: true })

    // An explicit waiver records the reason and lets the run proceed.
    service.save("t-1", WORKFLOW.replace("echo hi", "echo bye"))
    expect(service.canRun("t-1", "my-flow.yaml", "用户要求跳过仿真")).toEqual({ ok: true })
    expect(service.getState("t-1").state.waiver?.reason).toBe("用户要求跳过仿真")
  })

  it("completes a workflow, then the task, and emits awaiting_archive", async () => {
    service.save("t-1", WORKFLOW)
    service.validate("t-1")
    fs.writeFileSync(path.join(homeService.workflowsDir("t-1"), "my-flow.test.yaml"), FIXTURE, "utf-8")
    await service.simulate("t-1", { strict: false })

    const afterWorkflow = service.markWorkflowComplete("t-1", "my-flow.yaml", "snapshot")
    expect(afterWorkflow.state.completed_refs).toContain("my-flow.yaml")
    expect(afterWorkflow.state.active_ref).toBeUndefined()
    expect(afterWorkflow.state.stage).toBe("snapshot")

    service.completeTask("t-1")
    const row = taskDAO.getById("t-1")!
    expect(row.status).toBe("ready")
    expect(JSON.parse(row.task_spec).workflow_dev.complete).toBe(true)
    expect(emitted).toEqual([{ taskId: "t-1", status: "awaiting_archive" }])
    // Fixtures are not workflows: after completion the window still resolves
    // the authored YAML, not my-flow.test.yaml.
    expect(service.getState("t-1").ref).toBe("my-flow.yaml")
  })

  it("release copies a released YAML into the main-agent workspace", async () => {
    const released = `apiVersion: octopus/v1
kind: Workflow
name: my-flow
version: 1.0.0
stage: release
description: demo workflow
nodes:
  - id: step
    type: bash
    bash: echo hi
`
    service.save("t-1", released)
    service.validate("t-1")
    fs.writeFileSync(path.join(homeService.workflowsDir("t-1"), "my-flow.test.yaml"), FIXTURE, "utf-8")
    await service.simulate("t-1", { strict: false })

    const out = service.release("t-1", "my-flow.yaml")
    expect(out.targetPath).toBe(path.join(tmp, "octopus", "agent", "workflows", "my-flow.yaml"))
    expect(fs.existsSync(out.targetPath)).toBe(true)
  })

  it("rejects a second workflow while one is still in development", () => {
    service.save("t-1", WORKFLOW)
    fs.writeFileSync(
      path.join(homeService.workflowsDir("t-1"), "other.yaml"),
      WORKFLOW.replace("name: my-flow", "name: other"),
      "utf-8",
    )
    expect(() => service.setActiveRef("t-1", "other.yaml")).toThrow(/still in development/)
  })
})
