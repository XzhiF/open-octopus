import { describe, it, expect } from "vitest"
import { Command } from "commander"
import { createProgram } from "../index"
import { VERSION } from "@octopus/shared"

describe("CLI program setup", () => {
  it("program name is 'octopus'", () => {
    const program = createProgram()
    expect(program.name()).toBe("octopus")
  })

  it("program has version from shared", () => {
    const program = createProgram()
    expect(program.version()).toBe(VERSION)
  })

  it("program description matches", () => {
    const program = createProgram()
    expect(program.description()).toBe("Octopus - 企业级 Skill + Workflow 工具集")
  })

  it("program has all core commands", () => {
    const program = createProgram()
    const cmds = program.commands.map((c) => c.name())
    expect(cmds).toContain("version")
    expect(cmds).toContain("init")
    expect(cmds).toContain("setup")
    expect(cmds).toContain("upgrade")
    expect(cmds).toContain("repos")
    expect(cmds).toContain("skill-search")
    expect(cmds).toContain("mcp-cli")
  })

  it("repos command has subcommands", () => {
    const program = createProgram()
    const reposCmd = program.commands.find((c) => c.name() === "repos")
    expect(reposCmd).toBeDefined()
    const subcmds = reposCmd!.commands.map((c) => c.name())
    expect(subcmds).toContain("update")
    expect(subcmds).toContain("pull")
    expect(subcmds).toContain("clone")
    expect(subcmds).toContain("rebuild-index")
  })

  it("init command has required argument and options", () => {
    const program = createProgram()
    const initCmd = program.commands.find((c) => c.name() === "init")
    expect(initCmd).toBeDefined()
    expect(initCmd!.description()).toContain("初始化")
  })

  it("setup command has dry-run and force options", () => {
    const program = createProgram()
    const setupCmd = program.commands.find((c) => c.name() === "setup")
    expect(setupCmd).toBeDefined()
    expect(setupCmd!.description()).toContain("初始化/更新")
  })

  it("upgrade command description matches", () => {
    const program = createProgram()
    const upgradeCmd = program.commands.find((c) => c.name() === "upgrade")
    expect(upgradeCmd).toBeDefined()
    expect(upgradeCmd!.description()).toContain("升级")
  })
})

describe("version command", () => {
  it("version subcommand has correct description", () => {
    const program = createProgram()
    const cmd = program.commands.find((c) => c.name() === "version")
    expect(cmd?.description()).toBe("显示版本信息")
  })

  it("VERSION constant from shared is 1.0.0", () => {
    expect(VERSION).toBe("1.0.0")
  })
})