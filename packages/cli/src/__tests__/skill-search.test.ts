import { describe, it, expect } from "vitest"
import { createProgram } from "../index"

describe("Skill Search CLI command", () => {
  it("is registered in the program", () => {
    const program = createProgram()
    const cmd = program.commands.find(c => c.name() === "skill-search")
    expect(cmd).toBeDefined()
  })

  it("has correct description", () => {
    const program = createProgram()
    const cmd = program.commands.find(c => c.name() === "skill-search")
    expect(cmd?.description()).toContain("Skill")
  })

  it("has query argument", () => {
    const program = createProgram()
    const cmd = program.commands.find(c => c.name() === "skill-search")
    expect(cmd?.registeredArguments.length).toBeGreaterThanOrEqual(1)
  })

  it("has --category, --org, --limit options", () => {
    const program = createProgram()
    const cmd = program.commands.find(c => c.name() === "skill-search")
    const options = cmd?.options.map(o => o.long)
    expect(options).toContain("--category")
    expect(options).toContain("--org")
    expect(options).toContain("--limit")
  })
})