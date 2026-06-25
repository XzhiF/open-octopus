import { describe, it, expect } from "vitest"
import { VarPool } from "../variables/var-pool"
import { evaluateExpression } from "../variables/expression"
import { substituteVars } from "../variables/substitute"

describe("substituteVars", () => {
  it("replaces $vars.xxx", () => {
    const pool = new VarPool({ org: "xzf", env: "prod" })
    const result = substituteVars("Deploy to $vars.env for $vars.org", pool)
    expect(result).toBe("Deploy to prod for xzf")
  })

  it("replaces $node-id.output.xxx", () => {
    const pool = new VarPool({})
    const nodeOutputs = { "code-review": { decision: "approved", severity: "low" } }
    const result = substituteVars("Decision: $code-review.output.decision", pool, nodeOutputs)
    expect(result).toBe("Decision: approved")
  })

  it("keeps unresolved refs", () => {
    const pool = new VarPool({ org: "xzf" })
    const result = substituteVars("$vars.unknown stays", pool)
    expect(result).toContain("unknown")
  })

  it("replaces $inputs.xxx from pool", () => {
    const pool = new VarPool({ prompt: "write a poem" })
    const result = substituteVars("Task: $inputs.prompt", pool)
    expect(result).toBe("Task: write a poem")
  })

  it("keeps unresolved $inputs.xxx", () => {
    const pool = new VarPool({})
    const result = substituteVars("$inputs.unknown stays", pool)
    expect(result).toContain("$inputs.unknown")
  })

  it("replaces $hook.xxx from pool", () => {
    const pool = new VarPool({ "hook.event": "on_success", "hook.id": "h1" })
    const result = substituteVars("Event: $hook.event, Id: $hook.id", pool)
    expect(result).toBe("Event: on_success, Id: h1")
  })

  it("keeps unresolved $hook.xxx", () => {
    const pool = new VarPool({})
    const result = substituteVars("$hook.unknown stays", pool)
    expect(result).toContain("$hook.unknown")
  })

  it("replaces $ref:workflow.node.output with resolver", () => {
    const pool = new VarPool({})
    pool.setRefResolver((refPath: string) => {
      if (refPath === "security-scan.scan.vulnerabilities") return "3 critical issues found"
      if (refPath === "build.compile.exit_code") return 0
      return undefined
    })
    expect(substituteVars("Report: $ref:security-scan.scan.vulnerabilities", pool))
      .toBe("Report: 3 critical issues found")
    expect(substituteVars("Exit: $ref:build.compile.exit_code", pool))
      .toBe("Exit: 0")
  })

  it("keeps unresolved $ref: when resolver returns undefined", () => {
    const pool = new VarPool({})
    pool.setRefResolver(() => undefined)
    const result = substituteVars("Value: $ref:unknown.node.key", pool)
    expect(result).toBe("Value: $ref:unknown.node.key")
  })

  it("keeps $ref: literal when no resolver set", () => {
    const pool = new VarPool({})
    const result = substituteVars("Value: $ref:workflow.node.key", pool)
    expect(result).toBe("Value: $ref:workflow.node.key")
  })

  it("replaces $iteration with loopContext", () => {
    const pool = new VarPool({})
    const loopContext = { iteration: 3 }
    const result = substituteVars("Iteration $iteration of loop", pool, undefined, undefined, undefined, loopContext)
    expect(result).toBe("Iteration 3 of loop")
  })

  it("keeps $iteration literal when no loopContext", () => {
    const pool = new VarPool({})
    const result = substituteVars("Iteration $iteration of loop", pool)
    expect(result).toBe("Iteration $iteration of loop")
  })

  it("replaces multiple $iteration references", () => {
    const pool = new VarPool({})
    const loopContext = { iteration: 5 }
    const result = substituteVars("Round $iteration: processing item $iteration", pool, undefined, undefined, undefined, loopContext)
    expect(result).toBe("Round 5: processing item 5")
  })

  it("replaces $iteration with other variables", () => {
    const pool = new VarPool({ name: "test" })
    const loopContext = { iteration: 2 }
    const result = substituteVars("$vars.name at iteration $iteration", pool, undefined, undefined, undefined, loopContext)
    expect(result).toBe("test at iteration 2")
  })
})

describe("evaluateExpression", () => {
  it("simple comparison", () => {
    const pool = new VarPool({ tasks_remaining: 3, all_done: false })
    expect(evaluateExpression("$vars.tasks_remaining > 0", pool)).toBe(true)
    expect(evaluateExpression("$vars.tasks_remaining == 3", pool)).toBe(true)
    expect(evaluateExpression("$vars.all_done == false", pool)).toBe(true)
  })

  it("string comparison", () => {
    const pool = new VarPool({ decision: "approved" })
    expect(evaluateExpression("$vars.decision == 'approved'", pool)).toBe(true)
    expect(evaluateExpression("$vars.decision == 'rejected'", pool)).toBe(false)
  })

  it("and/or logic", () => {
    const pool = new VarPool({ approved: true, severity: "low" })
    expect(evaluateExpression("$vars.approved == true && $vars.severity == 'low'", pool)).toBe(true)
    expect(evaluateExpression("$vars.approved == true || $vars.severity == 'high'", pool)).toBe(true)
  })

  it("in operator", () => {
    const pool = new VarPool({ env: "prod" })
    expect(evaluateExpression("$vars.env in ['prod', 'uat']", pool)).toBe(true)
  })

  it("with node outputs", () => {
    const pool = new VarPool({})
    const nodeOutputs = { "code-review": { decision: "approved" } }
    expect(evaluateExpression("$code-review.output.decision == 'approved'", pool, nodeOutputs)).toBe(true)
  })

  it("with inputs alias", () => {
    const pool = new VarPool({})
    const inputs = { decision: "approved" }
    expect(evaluateExpression("$inputs.decision == 'approved'", pool, {}, inputs)).toBe(true)
  })

  it("not expression", () => {
    const pool = new VarPool({ has_next: true })
    expect(evaluateExpression("!$vars.has_next", pool)).toBe(false)
  })

  it("iteration", () => {
    const pool = new VarPool({})
    const loopContext = { iteration: 2 }
    expect(evaluateExpression("$iteration == 2", pool, {}, {}, loopContext)).toBe(true)
  })

  it("default keyword", () => {
    expect(evaluateExpression("default", new VarPool({}))).toBe(true)
  })

  it("hook variable", () => {
    const pool = new VarPool({ "hook.event": "on_success" })
    expect(evaluateExpression("$hook.event == 'on_success'", pool)).toBe(true)
    expect(evaluateExpression("$hook.event == 'on_failure'", pool)).toBe(false)
  })

  it("$ref: cross-execution reference resolves via pool resolver", () => {
    const pool = new VarPool({})
    pool.setRefResolver((refPath: string) => {
      if (refPath === "security-scan.scan.severity") return "critical"
      return undefined
    })
    expect(evaluateExpression("$ref:security-scan.scan.severity == 'critical'", pool)).toBe(true)
    expect(evaluateExpression("$ref:security-scan.scan.severity == 'low'", pool)).toBe(false)
  })

  it("$ref: returns undefined for unresolvable reference", () => {
    const pool = new VarPool({})
    pool.setRefResolver(() => undefined)
    expect(evaluateExpression("$ref:unknown.node.output == null", pool)).toBe(true)
  })

  it("$ref: returns unresolved when no resolver set", () => {
    const pool = new VarPool({})
    // No refResolver set — should return the literal $ref: string
    // which won't match any comparison, so expression evaluates to false
    expect(evaluateExpression("$ref:workflow.node.key == 'value'", pool)).toBe(false)
  })
})