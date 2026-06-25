import { describe, it, expect } from "vitest"
import { createProgram } from "../index"

describe("MCP CLI command", () => {
  it("is registered in the program", () => {
    const program = createProgram()
    const cmd = program.commands.find(c => c.name() === "mcp-cli")
    expect(cmd).toBeDefined()
  })

  it("has correct description", () => {
    const program = createProgram()
    const cmd = program.commands.find(c => c.name() === "mcp-cli")
    expect(cmd?.description()).toContain("MCP")
  })

  it("has server and tool arguments", () => {
    const program = createProgram()
    const cmd = program.commands.find(c => c.name() === "mcp-cli")
    expect(cmd?.registeredArguments.length).toBeGreaterThanOrEqual(2)
  })

  it("has --env and --org options", () => {
    const program = createProgram()
    const cmd = program.commands.find(c => c.name() === "mcp-cli")
    const options = cmd?.options.map(o => o.long)
    expect(options).toContain("--env")
    expect(options).toContain("--org")
  })
})