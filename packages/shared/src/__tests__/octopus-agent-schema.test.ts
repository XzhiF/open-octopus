import { describe, it, expect } from "vitest"
import { NodeSchema } from "../types/workflow"

describe("NodeSchema — octopus_agent validation", () => {
  it("accepts a valid octopus_agent node with minimal fields", () => {
    const node = {
      id: "dev-agent",
      type: "octopus_agent",
      agent: "workspace",
      task: {
        brief: "Create a hello world endpoint",
      },
    }
    const result = NodeSchema.safeParse(node)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("octopus_agent")
      expect(result.data.agent).toBe("workspace")
    }
  })

  it("accepts a valid octopus_agent node with all fields", () => {
    const node = {
      id: "dev-agent",
      type: "octopus_agent",
      agent: "workspace",
      version: "1.2.0-beta.1",
      min_stage: "beta",
      task: {
        brief: "Implement the login endpoint",
        context: ["$vars.api_spec", "$design-node.output"],
        constraints: ["Use Express.js", "Follow existing patterns"],
        expected_output: {
          type: "code_changes",
          schema: { type: "object", properties: { files: { type: "array" } } },
        },
        sop: "1. Read spec 2. Implement 3. Test",
        budget: {
          max_tokens: 50000,
          max_duration: 600,
          max_cost_usd: 2.5,
        },
      },
      harness: {
        heartbeat_interval: 5,
        heartbeat_timeout: 120,
        auto_abort_on_budget: true,
      },
      outputs: {
        result: "$last_output",
      },
    }
    const result = NodeSchema.safeParse(node)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.version).toBe("1.2.0-beta.1")
      expect(result.data.min_stage).toBe("beta")
      expect(result.data.task?.brief).toBe("Implement the login endpoint")
      expect(result.data.task?.budget?.max_tokens).toBe(50000)
      expect(result.data.harness?.heartbeat_interval).toBe(5)
    }
  })

  it("rejects octopus_agent without agent field", () => {
    const node = {
      id: "dev-agent",
      type: "octopus_agent",
      task: {
        brief: "Do something",
      },
    }
    const result = NodeSchema.safeParse(node)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages.some((m) => m.includes("agent"))).toBe(true)
    }
  })

  it("rejects octopus_agent without task.brief", () => {
    const node = {
      id: "dev-agent",
      type: "octopus_agent",
      agent: "workspace",
      task: {
        constraints: ["Use Express.js"],
      },
    }
    const result = NodeSchema.safeParse(node)
    expect(result.success).toBe(false)
    if (!result.success) {
      const issues = result.error.issues
      const hasTaskBriefIssue = issues.some(
        (i) =>
          i.message.includes("task") ||
          i.message.includes("brief") ||
          (i.path.includes("task") && i.path.includes("brief")),
      )
      expect(hasTaskBriefIssue).toBe(true)
    }
  })

  it("rejects octopus_agent with empty agent field", () => {
    const node = {
      id: "dev-agent",
      type: "octopus_agent",
      agent: "   ",
      task: {
        brief: "Do something",
      },
    }
    const result = NodeSchema.safeParse(node)
    expect(result.success).toBe(false)
  })

  it("rejects invalid min_stage value", () => {
    const node = {
      id: "dev-agent",
      type: "octopus_agent",
      agent: "workspace",
      min_stage: "gamma",
      task: {
        brief: "Do something",
      },
    }
    const result = NodeSchema.safeParse(node)
    expect(result.success).toBe(false)
  })

  it("accepts non-octopus_agent nodes without octopus_agent fields", () => {
    const node = {
      id: "bash-node",
      type: "bash",
      bash: "echo hello",
    }
    const result = NodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it("does not require octopus_agent fields for regular agent nodes", () => {
    const node = {
      id: "agent-node",
      type: "agent",
      agent: "workspace",
      prompt: "Do something",
    }
    const result = NodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })
})
