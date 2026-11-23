import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  ensureRootClaudePointer,
  findWorkspaceConfigFile,
  isWorkspaceConfigLike,
  pipelineConfigPath,
  readWorkspaceConfig,
  resolvePipelineConfigPath,
  ROOT_CLAUDE_POINTER,
  updateWorkspaceConfig,
  upsertManagedBlock,
  WORKSPACE_CLAUDE_BEGIN,
  WORKSPACE_CLAUDE_END,
  workspaceConfigPath,
  workspaceInstructionPath,
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
  it("writes to .octopus/config.json and never to the directory root", () => {
    const file = writeWorkspaceConfig(root, { name: "ws", repos: [] })
    expect(file).toBe(path.join(root, ".octopus", "config.json"))
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

describe("workspace instructions + root pointer", () => {
  it("writes the full instructions into .octopus/CLAUDE.md", () => {
    expect(workspaceInstructionPath(root)).toBe(path.join(root, ".octopus", "CLAUDE.md"))
    upsertManagedBlock(workspaceInstructionPath(root), "# 工作空间: demo", WORKSPACE_CLAUDE_BEGIN, WORKSPACE_CLAUDE_END)
    const content = fs.readFileSync(workspaceInstructionPath(root), "utf-8")
    expect(content).toContain(WORKSPACE_CLAUDE_BEGIN)
    expect(content).toContain("# 工作空间: demo")
    expect(content).toContain(WORKSPACE_CLAUDE_END)
  })

  it("creates the root CLAUDE.md as a one-line pointer when it is missing", () => {
    ensureRootClaudePointer(root)
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8")).toBe(`${ROOT_CLAUDE_POINTER}\n`)
  })

  it("keeps existing root CLAUDE.md content and adds the pointer exactly once", () => {
    const file = path.join(root, "CLAUDE.md")
    fs.writeFileSync(file, "# My project\n\nExisting instructions.\n")
    ensureRootClaudePointer(root)
    ensureRootClaudePointer(root)
    const content = fs.readFileSync(file, "utf-8")
    expect(content).toContain("# My project")
    expect(content).toContain("Existing instructions.")
    expect(content.split(ROOT_CLAUDE_POINTER)).toHaveLength(2)
  })

  it("replaces only the managed block, preserving content outside it", () => {
    const file = path.join(root, ".octopus", "CLAUDE.md")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `user notes\n\n${WORKSPACE_CLAUDE_BEGIN}\nold\n${WORKSPACE_CLAUDE_END}\n`)
    upsertManagedBlock(file, "new", WORKSPACE_CLAUDE_BEGIN, WORKSPACE_CLAUDE_END)
    const content = fs.readFileSync(file, "utf-8")
    expect(content).toContain("user notes")
    expect(content).toContain("new")
    expect(content).not.toContain("old")
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
