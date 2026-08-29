import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { WorkflowPresetsService } from "../workflow-presets-service"

describe("WorkflowPresetsService", () => {
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

  it("returns all presets when no skills_group filter", () => {
    writeCatalog(`
presets:
  - name: general-dev
    skills_group: []
    workflow: built-in/matt-dev-pipeline
    inputs:
      idea: "\${goal}"
  - name: xzf-dev
    skills_group: [octo-xzf-implementer]
    workflow: built-in/xzf-dev
    inputs:
      idea: "\${goal}"
`)
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list()
    expect(result.presets).toHaveLength(2)
    expect(result.presets[0].name).toBe("general-dev")
    expect(result.presets[1].name).toBe("xzf-dev")
  })

  it("filters by skills_group: matching + general fallback", () => {
    writeCatalog(`
presets:
  - name: general-dev
    skills_group: []
    workflow: built-in/matt-dev-pipeline
  - name: xzf-dev
    skills_group: [octo-xzf-implementer]
    workflow: built-in/xzf-dev
  - name: other-dev
    skills_group: [other-skill]
    workflow: built-in/other-flow
`)
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list(["octo-xzf-implementer"])
    expect(result.presets).toHaveLength(2)
    const names = result.presets.map(p => p.name)
    expect(names).toContain("general-dev") // general fallback
    expect(names).toContain("xzf-dev")     // matching
    expect(names).not.toContain("other-dev") // non-matching
  })

  it("filters by multiple skills_groups: union + general", () => {
    writeCatalog(`
presets:
  - name: general-dev
    skills_group: []
    workflow: built-in/matt-dev-pipeline
  - name: xzf-dev
    skills_group: [octo-xzf-implementer]
    workflow: built-in/xzf-dev
  - name: other-dev
    skills_group: [other-skill]
    workflow: built-in/other-flow
`)
    service = new WorkflowPresetsService(tmpDir)
    const result = service.list(["octo-xzf-implementer", "other-skill"])
    expect(result.presets).toHaveLength(3) // all 3 match
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
