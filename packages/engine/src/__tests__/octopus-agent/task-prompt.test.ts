// packages/engine/src/__tests__/octopus-agent/task-prompt.test.ts
//
// Unit tests for buildTaskPrompt function.
// Verifies that TaskContract generates structured markdown prompt with all sections.
//

import { describe, it, expect } from "vitest"
import { buildTaskPrompt } from "../../executors/octopus-agent/task-prompt"
import { VarPool } from "@octopus/shared"
import type { TaskContract, HarnessConfig } from "@octopus/shared"

describe("buildTaskPrompt", () => {
  it("generates prompt with Brief section", () => {
    const task: TaskContract = {
      brief: "Create a hello world API endpoint",
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("## Task Delegation")
    expect(prompt).toContain("### Brief")
    expect(prompt).toContain("Create a hello world API endpoint")
  })

  it("generates prompt with Context section resolving $vars references", () => {
    const task: TaskContract = {
      brief: "Implement feature",
      context: ["$vars.api_spec", "$vars.design_doc"],
    }
    const pool = new VarPool({
      api_spec: "OpenAPI 3.0 spec for user endpoints",
      design_doc: "Design document for user management",
    })
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("### Context")
    expect(prompt).toContain("OpenAPI 3.0 spec for user endpoints")
    expect(prompt).toContain("Design document for user management")
  })

  it("generates prompt with Context section resolving $nodeId.output references", () => {
    const task: TaskContract = {
      brief: "Write tests",
      context: ["$impl-node.output.code", "$design-node.output.architecture"],
    }
    const pool = new VarPool()
    const nodeOutputs = {
      "impl-node": {
        code: "const app = express();\napp.get('/users', handler);",
      },
      "design-node": {
        architecture: "Microservices with REST API",
      },
    }
    const prompt = buildTaskPrompt(task, pool, nodeOutputs)

    expect(prompt).toContain("### Context")
    expect(prompt).toContain("const app = express()")
    expect(prompt).toContain("Microservices with REST API")
  })

  it("generates prompt with Constraints section", () => {
    const task: TaskContract = {
      brief: "Build endpoint",
      constraints: ["Use Express.js", "TypeScript only", "Max 100 lines"],
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("### Constraints")
    expect(prompt).toContain("- Use Express.js")
    expect(prompt).toContain("- TypeScript only")
    expect(prompt).toContain("- Max 100 lines")
  })

  it("generates prompt with Expected Output section", () => {
    const task: TaskContract = {
      brief: "Generate code",
      expected_output: {
        type: "code_changes",
        schema: {
          type: "object",
          properties: {
            files: { type: "array" },
            tests: { type: "array" },
          },
        },
      },
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("### Expected Output")
    expect(prompt).toContain("Type: code_changes")
    expect(prompt).toContain("Schema:")
    expect(prompt).toContain('"files"')
  })

  it("generates prompt with SOP section", () => {
    const task: TaskContract = {
      brief: "Refactor module",
      sop: "1. Analyze current code\n2. Identify issues\n3. Plan refactoring\n4. Implement changes\n5. Write tests",
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("### Standard Operating Procedure")
    expect(prompt).toContain("1. Analyze current code")
    expect(prompt).toContain("5. Write tests")
  })

  it("generates prompt with Budget section", () => {
    const task: TaskContract = {
      brief: "Long task",
      budget: {
        max_tokens: 50000,
        max_duration: 600,
        max_cost_usd: 5.0,
      },
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("### Budget")
    expect(prompt).toContain("Max tokens: 50000")
    expect(prompt).toContain("Max duration: 600s")
    expect(prompt).toContain("Max cost: $5")
  })

  it("generates prompt with Instructions section including heartbeat interval", () => {
    const task: TaskContract = {
      brief: "Execute task",
    }
    const pool = new VarPool()
    const harness: HarnessConfig = {
      heartbeat_interval: 5,
    }
    const prompt = buildTaskPrompt(task, pool, undefined, harness)

    expect(prompt).toContain("### Instructions")
    expect(prompt).toContain("heartbeat every 5 steps")
    expect(prompt).toContain("structured JSON")
  })

  it("uses default heartbeat interval of 3 when not specified", () => {
    const task: TaskContract = {
      brief: "Execute task",
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("heartbeat every 3 steps")
  })

  it("handles empty context array gracefully", () => {
    const task: TaskContract = {
      brief: "Simple task",
      context: [],
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("### Brief")
    expect(prompt).toContain("Simple task")
    // Context section should not appear or be empty
  })

  it("handles all optional sections omitted", () => {
    const task: TaskContract = {
      brief: "Minimal task",
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("### Brief")
    expect(prompt).toContain("Minimal task")
    expect(prompt).toContain("### Instructions")
    // Optional sections may be absent or empty
  })

  it("substitutes variables in brief text", () => {
    const task: TaskContract = {
      brief: "Implement $vars.feature_name for $vars.target_system",
    }
    const pool = new VarPool({
      feature_name: "authentication",
      target_system: "API gateway",
    })
    const prompt = buildTaskPrompt(task, pool)

    expect(prompt).toContain("Implement authentication for API gateway")
  })

  it("handles unresolved variable references gracefully", () => {
    const task: TaskContract = {
      brief: "Task",
      context: ["$vars.missing_var", "$nonexistent.output"],
    }
    const pool = new VarPool()
    const prompt = buildTaskPrompt(task, pool)

    // Should not crash, unresolved vars may appear as empty or original reference
    expect(prompt).toContain("### Brief")
    expect(prompt).toContain("Task")
  })
})
