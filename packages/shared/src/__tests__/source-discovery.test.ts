import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { SourceDiscovery } from "../resource/source-discovery"

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "discovery-test-"))
}
function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}
function writeAgent(dir: string, relPath: string, name: string): void {
  const fullPath = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, `---\nname: ${name}\ndescription: Test agent\n---\n\n# ${name}\n`, "utf-8")
}

describe("SourceDiscovery — root categories (agency-agents-zh)", () => {
  let tmpDir: string
  let discovery: SourceDiscovery

  beforeEach(() => {
    tmpDir = createTempDir()
    discovery = new SourceDiscovery()
  })
  afterEach(() => { cleanupDir(tmpDir) })

  it("discovers agents from root-level category directories", () => {
    writeAgent(tmpDir, "engineering/software-architect.md", "软件架构师")
    writeAgent(tmpDir, "engineering/frontend-dev.md", "前端开发者")
    writeAgent(tmpDir, "design/ui-designer.md", "UI设计师")
    writeAgent(tmpDir, "marketing/seo-specialist.md", "SEO专家")
    fs.writeFileSync(path.join(tmpDir, "engineering", "README.md"), "# Engineering", "utf-8")

    const resources = discovery.discover(tmpDir)

    expect(resources.length).toBe(4)
    expect(resources.every((r) => r.type === "agent")).toBe(true)
    expect(resources.map((r) => r.name)).toContain("software-architect")
    expect(resources.map((r) => r.name)).toContain("ui-designer")
    expect(resources.map((r) => r.name)).not.toContain("README")
  })

  it("handles nested category directories (game-development/engine-unity/)", () => {
    writeAgent(tmpDir, "game-development/engine-unity/unity-dev.md", "Unity开发者")
    writeAgent(tmpDir, "game-development/engine-godot/godot-dev.md", "Godot开发者")

    const resources = discovery.discover(tmpDir)

    expect(resources.length).toBe(2)
    expect(resources.map((r) => r.name)).toContain("unity-dev")
    expect(resources.map((r) => r.name)).toContain("godot-dev")
  })

  it("discovers mixed skills + agents + workflows", () => {
    const skillDir = path.join(tmpDir, "skills", "my-skill")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---", "utf-8")

    writeAgent(tmpDir, "engineering/architect.md", "架构师")

    const wfDir = path.join(tmpDir, "workflows")
    fs.mkdirSync(wfDir, { recursive: true })
    fs.writeFileSync(path.join(wfDir, "build.yaml"), "name: build\n", "utf-8")

    const resources = discovery.discover(tmpDir)

    expect(resources.find((r) => r.type === "skill" && r.name === "my-skill")).toBeDefined()
    expect(resources.find((r) => r.type === "agent" && r.name === "architect")).toBeDefined()
    expect(resources.find((r) => r.type === "workflow" && r.name === "build")).toBeDefined()
  })

  it("disambiguates name collisions", () => {
    writeAgent(tmpDir, "engineering/architect.md", "架构师")
    writeAgent(tmpDir, "design/architect.md", "设计架构师")

    const resources = discovery.discover(tmpDir)

    const names = resources.map((r) => r.name)
    expect(names.length).toBe(2)
    expect(new Set(names).size).toBe(2) // no duplicates
  })

  it("skips non-agent directories", () => {
    writeAgent(tmpDir, "engineering/architect.md", "架构师")
    fs.mkdirSync(path.join(tmpDir, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "scripts", "build.sh"), "#!/bin/bash", "utf-8")
    fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, "examples"), { recursive: true })

    const resources = discovery.discover(tmpDir)

    expect(resources.length).toBe(1)
    expect(resources[0].name).toBe("architect")
  })
})
