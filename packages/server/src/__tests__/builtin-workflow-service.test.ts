import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import type { WorkflowInfo } from "../types/workflow-api"

const BUILTIN_DIR = path.join(os.tmpdir(), `test-builtin-workflows-${Date.now()}`)
let service: BuiltInWorkflowService

const VALID_WF = "apiVersion: octopus/v1\nkind: Workflow\nname: deploy\ninputs:\n  environment: { description: 'deploy env', required: true, default: dev }\nnodes:\n  - id: step1\n    type: bash\n    bash: echo deploy"
const VALID_WF_NO_INPUTS = "apiVersion: octopus/v1\nkind: Workflow\nname: test\nnodes:\n  - id: step1\n    type: bash\n    bash: echo test"
const NON_OCTOPUS_YAML = "foo: bar\nbaz: 123"

beforeEach(() => {
  fs.mkdirSync(BUILTIN_DIR, { recursive: true })
  service = new BuiltInWorkflowService(BUILTIN_DIR)
})

afterEach(() => {
  fs.rmSync(BUILTIN_DIR, { recursive: true, force: true })
})

describe("BuiltInWorkflowService", () => {
  it("lists Octopus workflow YAML files from directory", () => {
    fs.writeFileSync(path.join(BUILTIN_DIR, "deploy.yaml"), VALID_WF)
    fs.writeFileSync(path.join(BUILTIN_DIR, "test.yaml"), VALID_WF_NO_INPUTS)
    expect(service.list().length).toBe(2)
  })

  it("skips non-Octopus YAML files", () => {
    fs.writeFileSync(path.join(BUILTIN_DIR, "deploy.yaml"), VALID_WF)
    fs.writeFileSync(path.join(BUILTIN_DIR, "random.yaml"), NON_OCTOPUS_YAML)
    expect(service.list().length).toBe(1)
    expect(service.list()[0].ref).toBe("deploy.yaml")
  })

  it("returns name parsed from YAML", () => {
    fs.writeFileSync(path.join(BUILTIN_DIR, "deploy.yaml"), VALID_WF)
    const list = service.list()
    expect(list[0].name).toBe("deploy")
  })

  it("returns inputs from parsed workflow", () => {
    fs.writeFileSync(path.join(BUILTIN_DIR, "deploy.yaml"), VALID_WF)
    const list = service.list()
    expect(list[0].inputs).toBeDefined()
    expect(list[0].inputs!.environment.description).toBe("deploy env")
  })

  it("returns empty list when directory does not exist", () => {
    const emptyService = new BuiltInWorkflowService(path.join(os.tmpdir(), "nonexistent"))
    expect(emptyService.list().length).toBe(0)
  })

  it("gets workflow detail by ref", () => {
    fs.writeFileSync(path.join(BUILTIN_DIR, "deploy.yaml"), VALID_WF)
    const detail = service.get("deploy.yaml")
    expect(detail).toBeDefined()
    expect(detail!.parsed.name).toBe("deploy")
    expect(detail!.parsed.inputs).toBeDefined()
  })

  it("returns null for nonexistent ref", () => {
    expect(service.get("nonexistent.yaml")).toBeNull()
  })

  it("handles .yml extension files", () => {
    fs.writeFileSync(path.join(BUILTIN_DIR, "build.yml"), VALID_WF_NO_INPUTS)
    expect(service.list().length).toBe(1)
    expect(service.list()[0].ref).toBe("build.yml")
  })
})