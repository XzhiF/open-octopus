import { describe, it, expect } from "vitest"
import { OutputFormatter } from "../commands/resource/formatter"

describe("OutputFormatter", () => {
  it("formats rich table output", () => {
    const fmt = new OutputFormatter("rich")
    const output = fmt.table([
      { name: "brainstorming", type: "skill", version: "1.2.0", source: "npm" },
      { name: "code-reviewer", type: "agent", version: "1.0.0", source: "git" },
    ])
    expect(output).toContain("brainstorming")
    expect(output).toContain("code-reviewer")
    expect(output).toContain("skill")
  })

  it("formats JSON output", () => {
    const fmt = new OutputFormatter("json")
    const output = fmt.table([
      { name: "brainstorming", type: "skill", version: "1.2.0", source: "npm" },
    ])
    const parsed = JSON.parse(output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe("brainstorming")
  })

  it("formats quiet output (names only)", () => {
    const fmt = new OutputFormatter("quiet")
    const output = fmt.table([
      { name: "brainstorming", type: "skill", version: "1.2.0", source: "npm" },
      { name: "code-reviewer", type: "agent", version: "1.0.0", source: "git" },
    ])
    expect(output).toBe("brainstorming\ncode-reviewer")
  })

  it("formats success message", () => {
    const fmt = new OutputFormatter("rich")
    expect(fmt.success("Installed brainstorming")).toContain("✓")
    expect(fmt.success("Installed brainstorming")).toContain("brainstorming")
  })

  it("formats error with suggestion", () => {
    const fmt = new OutputFormatter("rich")
    const output = fmt.error("Resource not found", "Try: octopus resource register")
    expect(output).toContain("Resource not found")
    expect(output).toContain("Try:")
  })

  it("formats empty table", () => {
    const fmt = new OutputFormatter("rich")
    const output = fmt.table([])
    expect(output).toBe("  (empty)")
  })

  it("formats JSON success message", () => {
    const fmt = new OutputFormatter("json")
    const output = fmt.success("done")
    const parsed = JSON.parse(output)
    expect(parsed.success).toBe(true)
    expect(parsed.message).toBe("done")
  })

  it("formats JSON error message", () => {
    const fmt = new OutputFormatter("json")
    const output = fmt.error("bad", "fix it")
    const parsed = JSON.parse(output)
    expect(parsed.error).toBe("bad")
    expect(parsed.suggestion).toBe("fix it")
  })

  it("formats quiet success (plain text)", () => {
    const fmt = new OutputFormatter("quiet")
    expect(fmt.success("Installed")).toBe("Installed")
  })

  it("formats detail view", () => {
    const fmt = new OutputFormatter("rich")
    const output = fmt.detail({
      name: "brainstorming",
      type: "skill",
      version: "1.2.0",
    })
    expect(output).toContain("brainstorming")
    expect(output).toContain("skill")
    expect(output).toContain("1.2.0")
  })

  it("formats detail view as JSON", () => {
    const fmt = new OutputFormatter("json")
    const output = fmt.detail({ name: "test", type: "agent" })
    const parsed = JSON.parse(output)
    expect(parsed.name).toBe("test")
    expect(parsed.type).toBe("agent")
  })

  it("formats tree output", () => {
    const fmt = new OutputFormatter("rich")
    const output = fmt.tree(["root", "  child1", "  child2"])
    expect(output).toContain("root")
    expect(output).toContain("child1")
  })

  it("table alignment handles varying lengths", () => {
    const fmt = new OutputFormatter("rich")
    const output = fmt.table([
      { name: "a", type: "skill" },
      { name: "long-name", type: "workflow" },
    ])
    // Header and separator should exist
    const lines = output.split("\n")
    expect(lines.length).toBe(4) // header + separator + 2 rows
    // Separator uses box-drawing chars
    expect(lines[1]).toContain("─")
  })
})
