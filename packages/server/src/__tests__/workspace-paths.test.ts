import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  findWorkspaceConfigFile,
  isWorkspaceConfigLike,
  octopusRuntimeDir,
  pipelineConfigPath,
  readWorkspaceConfig,
  resolvePipelineConfigPath,
  updateWorkspaceConfig,
  workspaceConfigPath,
  workspaceRuntimeBase,
  workspaceSubdir,
  writeWorkspaceConfig,
} from "../services/workspace-paths"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-paths-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("workspace config path", () => {
  it("writes to .octopus/workspace.json and never to the directory root", () => {
    const file = writeWorkspaceConfig(root, { kind: "octopus/workspace", name: "ws", repos: [] })
    expect(file).toBe(path.join(root, ".octopus", "workspace.json"))
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(path.join(root, "config.json"))).toBe(false)
  })

  it("reads a legacy root config.json only when it looks like a workspace config", () => {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "ws", repos: [{ name: "a" }] }))
    expect(findWorkspaceConfigFile(root)).toBe(path.join(root, "config.json"))
    expect(readWorkspaceConfig(root)?.name).toBe("ws")
  })

  it("ignores a business config.json (package.json-ish) and writes canonical", () => {
    const business = { name: "my-app", scripts: { dev: "vite" }, dependencies: {}, repos: [{ name: "x" }] }
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(business))
    expect(findWorkspaceConfigFile(root)).toBeNull()
    expect(readWorkspaceConfig(root)).toBeNull()

    updateWorkspaceConfig(root, (config) => {
      config.repos = [{ name: "demo" }]
    })
    expect(JSON.parse(fs.readFileSync(workspaceConfigPath(root), "utf-8")).repos).toEqual([{ name: "demo" }])
    // The business file is untouched.
    expect(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf-8"))).toEqual(business)
  })

  it("updates a valid legacy config in place instead of creating a second file", () => {
    const legacy = path.join(root, "config.json")
    fs.writeFileSync(legacy, JSON.stringify({ name: "ws", repos: [] }))
    updateWorkspaceConfig(root, (config) => {
      config.repos = [{ name: "demo" }]
    })
    expect(fs.existsSync(workspaceConfigPath(root))).toBe(false)
    expect(JSON.parse(fs.readFileSync(legacy, "utf-8")).repos).toEqual([{ name: "demo" }])
  })

  it("rejects configs without any workspace signal", () => {
    expect(isWorkspaceConfigLike({})).toBe(false)
    expect(isWorkspaceConfigLike({ name: "x" })).toBe(false)
    expect(isWorkspaceConfigLike({ repos: [] })).toBe(false)
    expect(isWorkspaceConfigLike({ repos: [{ name: "a" }] })).toBe(true)
  })
})

describe("pipeline config path", () => {
  it("prefers .octopus/pipeline.yaml and falls back to the legacy root file", () => {
    const legacy = path.join(root, "pipeline.yaml")
    fs.writeFileSync(legacy, "apiVersion: octopus/v2\nkind: Pipeline\n")
    expect(resolvePipelineConfigPath(root)).toBe(legacy)

    const canonical = pipelineConfigPath(root)
    fs.mkdirSync(path.dirname(canonical), { recursive: true })
    fs.writeFileSync(canonical, "apiVersion: octopus/v2\nkind: Pipeline\n")
    expect(resolvePipelineConfigPath(root)).toBe(canonical)
  })
})

describe("runtime subdirectories", () => {
  it("new workspaces use .octopus/{projects,workflows,logs,state}", () => {
    expect(workspaceRuntimeBase(root)).toBe(octopusRuntimeDir(root))
    expect(workspaceSubdir(root, "projects")).toBe(path.join(root, ".octopus", "projects"))
    expect(workspaceSubdir(root, "workflows")).toBe(path.join(root, ".octopus", "workflows"))
    expect(workspaceSubdir(root, "logs")).toBe(path.join(root, ".octopus", "logs"))
    expect(workspaceSubdir(root, "state")).toBe(path.join(root, ".octopus", "state"))
  })

  it("legacy workspaces (root config.json) keep the root runtime dirs", () => {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "old", repos: [] }))
    expect(workspaceRuntimeBase(root)).toBe(root)
    expect(workspaceSubdir(root, "projects")).toBe(path.join(root, "projects"))
  })

  it("a root config.json from a business project does not claim root runtime dirs", () => {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "app", scripts: { dev: "vite" } }))
    expect(workspaceRuntimeBase(root)).toBe(octopusRuntimeDir(root))
  })

  it("canonical config wins after migration", () => {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "old", repos: [] }))
    fs.mkdirSync(path.join(root, ".octopus"), { recursive: true })
    fs.writeFileSync(
      workspaceConfigPath(root),
      JSON.stringify({ kind: "octopus/workspace", name: "old", repos: [] }),
    )
    expect(workspaceRuntimeBase(root)).toBe(octopusRuntimeDir(root))
  })
})
