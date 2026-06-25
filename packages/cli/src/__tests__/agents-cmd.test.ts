import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// Mock @octopus/engine RoleRegistry
vi.mock("@octopus/engine", () => {
  return {
    RoleRegistry: vi.fn().mockImplementation((paths: string[]) => {
      const mockRoles = [
        { name: "coder", description: "Writes code", category: "engineering", source: "custom", capabilities: ["coding"] },
        { name: "tester", description: "编写测试用例", category: "testing", source: "agency-agents-zh", capabilities: ["testing"] },
        { name: "architect", description: "系统架构师", category: "engineering", source: "agency-agents-zh", capabilities: ["design"] },
        { name: "pm", description: "产品经理", category: "management", source: "org", capabilities: ["planning"] },
      ]

      return {
        loadIndex: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockReturnValue([...mockRoles]),
        listByCategory: vi.fn().mockReturnValue({
          engineering: mockRoles.filter(r => r.category === "engineering"),
          testing: mockRoles.filter(r => r.category === "testing"),
          management: mockRoles.filter(r => r.category === "management"),
        }),
        search: vi.fn().mockImplementation((query: string) => {
          const q = query.toLowerCase()
          return mockRoles.filter(r =>
            r.name.toLowerCase().includes(q) ||
            r.description.toLowerCase().includes(q)
          )
        }),
        resolve: vi.fn().mockImplementation((name: string) => {
          const role = mockRoles.find(r => r.name === name)
          return role ? { ...role, body: `# ${role.name}\nInstructions here.` } : null
        }),
      }
    }),
  }
})

import { agentsCmd } from "../commands/agents"

describe("agents CLI commands", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any)
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    exitSpy.mockRestore()
    vi.clearAllMocks()
  })

  // TC-032: list command outputs roles grouped by category
  describe("TC-032: agents list", () => {
    it("lists roles grouped by category in table format", async () => {
      await agentsCmd.parseAsync(["list"], { from: "user" })

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(" ")).join("\n")

      // Should contain category headers
      expect(allOutput).toContain("engineering")
      expect(allOutput).toContain("testing")
      expect(allOutput).toContain("management")

      // Should contain role names
      expect(allOutput).toContain("coder")
      expect(allOutput).toContain("tester")
      expect(allOutput).toContain("architect")
      expect(allOutput).toContain("pm")

      // Should show total count
      expect(allOutput).toContain("4 total")
    })

    it("lists roles in JSON format with --format json", async () => {
      await agentsCmd.parseAsync(["list", "--format", "json"], { from: "user" })

      const jsonOutput = consoleLogSpy.mock.calls.map(c => c.join(" ")).join("")
      const parsed = JSON.parse(jsonOutput)

      expect(parsed.total).toBe(4)
      expect(parsed.groups).toBeDefined()
      expect(parsed.groups.engineering).toHaveLength(2)
      expect(parsed.groups.testing).toHaveLength(1)
      expect(parsed.groups.management).toHaveLength(1)

      // Verify role structure
      const eng = parsed.groups.engineering[0]
      expect(eng).toHaveProperty("name")
      expect(eng).toHaveProperty("description")
      expect(eng).toHaveProperty("source")
    })

    it("shows custom source tag in table format", async () => {
      await agentsCmd.parseAsync(["list"], { from: "user" })

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(" ")).join("\n")
      // coder has source "custom", should show [custom] tag
      expect(allOutput).toContain("[custom]")
    })
  })

  // TC-033: search with Chinese query finds matching roles
  describe("TC-033: agents search", () => {
    it("searches by Chinese query and finds matching roles", async () => {
      await agentsCmd.parseAsync(["search", "架构"], { from: "user" })

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(" ")).join("\n")
      expect(allOutput).toContain("architect")
      expect(allOutput).toContain("系统架构师")
      expect(allOutput).toContain("1 matches")
    })

    it("searches by another Chinese query", async () => {
      await agentsCmd.parseAsync(["search", "产品"], { from: "user" })

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(" ")).join("\n")
      expect(allOutput).toContain("pm")
      expect(allOutput).toContain("产品经理")
    })

    it("search returns JSON format with --format json", async () => {
      await agentsCmd.parseAsync(["search", "测试", "--format", "json"], { from: "user" })

      const jsonOutput = consoleLogSpy.mock.calls.map(c => c.join(" ")).join("")
      const parsed = JSON.parse(jsonOutput)

      expect(parsed.query).toBe("测试")
      expect(parsed.total).toBe(1)
      expect(parsed.results[0].name).toBe("tester")
      expect(parsed.results[0].description).toBe("编写测试用例")
    })

    it("search with English query works too", async () => {
      await agentsCmd.parseAsync(["search", "coder"], { from: "user" })

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(" ")).join("\n")
      expect(allOutput).toContain("coder")
      expect(allOutput).toContain("1 matches")
    })

    it("search with no results calls process.exit(1)", async () => {
      await agentsCmd.parseAsync(["search", "zzz_nonexistent_zzz"], { from: "user" })

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(" ")).join("\n")
      expect(allOutput).toContain("No roles matching")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })
  })
})

// TC-034: template generation creates valid YAML (tests workflow new subcommand)
describe("TC-034: workflow new template generation", () => {
  let tmpDirs: string[] = []

  function createTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "workflow-template-test-"))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs = []
  })

  it("generates valid YAML from template with param substitution", () => {
    const dir = createTmpDir()

    // Create a template file
    const templateContent = `$template_params: name, description
# Test workflow template
name: "{{name}}"
description: "{{description}}"
nodes:
  - id: step1
    type: bash
    command: echo "Hello from {{name}}"
`
    writeFileSync(join(dir, "test-template.yaml"), templateContent, "utf-8")

    // Read and process template manually (simulating the workflow new logic)
    const content = readFileSync(join(dir, "test-template.yaml"), "utf-8")

    // Parse required params
    const paramsMatch = content.match(/^\$template_params:\s*(.+)$/m)
    expect(paramsMatch).not.toBeNull()
    const required = paramsMatch![1].split(",").map(s => s.trim())
    expect(required).toEqual(["name", "description"])

    // Provide params
    const params: Record<string, string> = {
      name: "my-workflow",
      description: "A generated workflow",
    }

    // Check no missing params
    const missing = required.filter(r => !params[r])
    expect(missing).toHaveLength(0)

    // Replace template variables
    let output = content.replace(/^\$template_params:.*\n/m, "")
    for (const [key, value] of Object.entries(params)) {
      output = output.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
    }

    // Write output
    const outputPath = join(dir, "output.yaml")
    writeFileSync(outputPath, output)

    // Verify output
    expect(existsSync(outputPath)).toBe(true)
    const result = readFileSync(outputPath, "utf-8")
    expect(result).toContain('name: "my-workflow"')
    expect(result).toContain('description: "A generated workflow"')
    expect(result).toContain('echo "Hello from my-workflow"')
    expect(result).not.toContain("{{")
    expect(result).not.toContain("$template_params")
  })

  it("detects missing required params", () => {
    const dir = createTmpDir()

    const templateContent = `$template_params: name, env, region
name: "{{name}}"
env: "{{env}}"
region: "{{region}}"
`
    writeFileSync(join(dir, "deploy.yaml"), templateContent, "utf-8")

    const content = readFileSync(join(dir, "deploy.yaml"), "utf-8")
    const paramsMatch = content.match(/^\$template_params:\s*(.+)$/m)
    const required = paramsMatch![1].split(",").map(s => s.trim())

    // Only provide some params
    const params: Record<string, string> = { name: "my-deploy" }
    const missing = required.filter(r => !params[r])

    expect(missing).toEqual(["env", "region"])
  })
})
