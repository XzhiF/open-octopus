import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { WorkflowService } from "../services/workflow"
import type { WorkflowInfo } from "../types/workflow-api"

const WORKSPACE_DIR = path.join(os.tmpdir(), `test-workflows-${Date.now()}`)
let service: WorkflowService

const MINIMAL_WF = "apiVersion: octopus/v1\nkind: Workflow\nname: test\nnodes:\n  - id: step1\n    type: bash\n    bash: echo hello"

const VALID_WF_WITH_INPUTS = "apiVersion: octopus/v1\nkind: Workflow\nname: deploy\ninputs:\n  environment: { description: 'deploy env', required: true, default: dev }\n  version: { description: 'version number', required: true }\nnodes:\n  - id: step1\n    type: bash\n    bash: echo hello"

const NON_OCTOPUS_YAML = "foo: bar\nbaz: 123"

beforeEach(() => {
  fs.mkdirSync(path.join(WORKSPACE_DIR, "workflows"), { recursive: true })
  service = new WorkflowService()
})

afterEach(() => {
  fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true })
})

describe("WorkflowService", () => {
  it("lists YAML files in the workflows directory", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "deploy.yaml"), MINIMAL_WF)
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "test.yaml"), MINIMAL_WF)
    expect(service.list(WORKSPACE_DIR).length).toBe(2)
  })

  it("parses workflow name from YAML content", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "deploy.yaml"), "apiVersion: octopus/v1\nkind: Workflow\nname: deploy\nnodes: []")
    const list = service.list(WORKSPACE_DIR)
    expect(list[0].name).toBe("deploy")
  })

  it("gets YAML content and parsed workflow by ref", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "deploy.yaml"), MINIMAL_WF)
    const result = service.get(WORKSPACE_DIR, "deploy.yaml")
    expect(result).toBeDefined()
    expect(result!.parsed.name).toBe("test")
    expect(result!.parsed.nodes[0].id).toBe("step1")
  })

  it("returns undefined for nonexistent ref", () => {
    expect(service.get(WORKSPACE_DIR, "nonexistent.yaml")).toBeUndefined()
  })

  it("creates a new workflow YAML file", () => {
    const result = service.create(WORKSPACE_DIR, "new.yaml", MINIMAL_WF)
    expect(result.ref).toBe("new.yaml")
    expect(fs.existsSync(path.join(WORKSPACE_DIR, "workflows", "new.yaml"))).toBe(true)
  })

  it("updates a workflow YAML file", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "test.yaml"), "apiVersion: octopus/v1\nkind: Workflow\nname: old\nnodes: []")
    const result = service.update(WORKSPACE_DIR, "test.yaml", "apiVersion: octopus/v1\nkind: Workflow\nname: updated\nnodes: []")
    expect(result).toBeDefined()
    expect(result!.content).toContain("updated")
  })

  it("returns undefined when updating nonexistent file", () => {
    expect(service.update(WORKSPACE_DIR, "nonexistent.yaml", "...")).toBeUndefined()
  })

  it("deletes a workflow YAML file", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "to-delete.yaml"), MINIMAL_WF)
    expect(service.delete(WORKSPACE_DIR, "to-delete.yaml")).toBe(true)
    expect(fs.existsSync(path.join(WORKSPACE_DIR, "workflows", "to-delete.yaml"))).toBe(false)
  })

  it("returns false when deleting nonexistent file", () => {
    expect(service.delete(WORKSPACE_DIR, "nonexistent.yaml")).toBe(false)
  })

  it("handles existing .yml extension files", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "build.yml"), MINIMAL_WF)
    expect(service.list(WORKSPACE_DIR).length).toBe(1)
  })
})

describe("WorkflowService filtering", () => {
  it("skips YAML files that are not Octopus workflows", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "deploy.yaml"), MINIMAL_WF)
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "random.yaml"), NON_OCTOPUS_YAML)
    const list = service.list(WORKSPACE_DIR)
    expect(list.length).toBe(1)
    expect(list[0].ref).toBe("deploy.yaml")
  })

  it("returns inputs field from parsed workflow", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "deploy.yaml"), VALID_WF_WITH_INPUTS)
    const list = service.list(WORKSPACE_DIR) as WorkflowInfo[]
    expect(list[0].inputs).toBeDefined()
    expect(list[0].inputs!.environment.description).toBe("deploy env")
  })

  it("returns undefined inputs for workflows without inputs", () => {
    fs.writeFileSync(path.join(WORKSPACE_DIR, "workflows", "simple.yaml"), MINIMAL_WF)
    const list = service.list(WORKSPACE_DIR) as WorkflowInfo[]
    expect(list[0].inputs).toBeUndefined()
  })
})