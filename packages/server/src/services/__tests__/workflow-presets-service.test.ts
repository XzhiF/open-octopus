import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { WorkflowPresetsService } from "../workflow-presets-service"

describe("WorkflowPresetsService (binding catalog, verbatim)", () => {
  let tmpDir: string
  let service: WorkflowPresetsService

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-presets-${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeCatalog(content: string) {
    const dir = path.join(tmpDir, "agent", "built-in", "task-author")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "workflow-presets.yaml"), content, "utf-8")
  }

  it("returns empty presets when catalog file is missing", () => {
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list()
    expect(result.presets).toEqual([])
  })

  it("returns the catalog verbatim (no filtering — catalog == everything bindable)", () => {
    writeCatalog(`
presets:
  - name: spec-dev
    desc: v4 主打
    workflow: built-in/matt-spec-dev
    inputs:
      batch_dir: "\${phase.batch_rel}"
  - name: custom-flow
    workflow: my-flow.yaml
    inputs: {}
`)
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list()
    expect(result.presets).toHaveLength(2)
    expect(result.presets[0].name).toBe("spec-dev")
    expect(result.presets[0].desc).toBe("v4 主打")
    expect(result.presets[0].inputs).toEqual({ batch_dir: "${phase.batch_rel}" })
    expect(result.presets[1].workflow).toBe("my-flow.yaml")
  })

  it("pre-v3 files carrying retired skills_group keys still parse (keys stripped)", () => {
    writeCatalog(`
presets:
  - name: general-dev
    skills_group: []
    workflow: built-in/task-dev
`)
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list()
    expect(result.presets).toHaveLength(1)
    expect("skills_group" in result.presets[0]).toBe(false)
  })

  it("returns empty presets for malformed YAML", () => {
    writeCatalog(`this: is: not: valid: yaml: [[[`)
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list()
    expect(result.presets).toEqual([])
  })

  it("returns empty presets for empty file", () => {
    writeCatalog("")
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list()
    expect(result.presets).toEqual([])
  })

  it("handles catalog with no presets field", () => {
    writeCatalog("some_other_field: value")
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list()
    expect(result.presets).toEqual([])
  })
})
