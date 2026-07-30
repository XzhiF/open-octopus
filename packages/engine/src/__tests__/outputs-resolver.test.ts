import { describe, it, expect } from "vitest"
import { VarPool, resolveOutputsExpression, applyOutputsMapping } from "@octopus/shared"

describe("resolveOutputsExpression", () => {
  it("returns lastOutput for $last_output", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("$last_output", pool, "hello world", undefined)
    expect(result).toBe("hello world")
  })

  it("returns undefined for $last_output when lastOutput is undefined", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("$last_output", pool, undefined, undefined)
    expect(result).toBeUndefined()
  })

  it("extracts field from JSON lastOutput via $last_output.field", () => {
    const pool = new VarPool({})
    const jsonOutput = JSON.stringify({ name: "Alice", age: 30 })
    const result = resolveOutputsExpression("$last_output.name", pool, jsonOutput, undefined)
    expect(result).toBe("Alice")
  })

  it("returns undefined when lastOutput is not valid JSON for $last_output.field", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("$last_output.name", pool, "not json", undefined)
    expect(result).toBeUndefined()
  })

  it("returns undefined when JSON field doesn't exist", () => {
    const pool = new VarPool({})
    const jsonOutput = JSON.stringify({ name: "Alice" })
    const result = resolveOutputsExpression("$last_output.missing", pool, jsonOutput, undefined)
    expect(result).toBeUndefined()
  })

  it("returns exitCode for $exit_code", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("$exit_code", pool, undefined, 0)
    expect(result).toBe(0)
  })

  it("returns non-zero exitCode", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("$exit_code", pool, undefined, 42)
    expect(result).toBe(42)
  })

  it("returns undefined for $exit_code when exitCode is undefined", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("$exit_code", pool, undefined, undefined)
    expect(result).toBeUndefined()
  })

  it("evaluates comparison via $vars.x = expr (evaluateExpression returns boolean)", () => {
    const pool = new VarPool({ count: 5 })
    // evaluateExpression returns boolean — $vars.count > 3 → true
    const result = resolveOutputsExpression("$vars.count = $vars.count > 3", pool, undefined, undefined)
    expect(result).toBe(true)
  })

  it("evaluates string expression via $vars.x = expr", () => {
    const pool = new VarPool({ name: "world" })
    const result = resolveOutputsExpression("$vars.greeting = 'hello'", pool, undefined, undefined)
    expect(result).toBe(true) // evaluateExpression returns boolean
  })

  it("resolves $vars.xxx to pool value", () => {
    const pool = new VarPool({ feature: "user-auth" })
    const result = resolveOutputsExpression("$vars.feature", pool, undefined, undefined)
    expect(result).toBe("user-auth")
  })

  it("resolves $vars.xxx to undefined when key doesn't exist", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("$vars.missing", pool, undefined, undefined)
    expect(result).toBeUndefined()
  })

  it("substitutes variables in $-prefixed expressions (not matching simpler patterns)", () => {
    const pool = new VarPool({ name: "Alice" })
    // "$vars.name is great" starts with $, doesn't match VARS_REF_RE (has suffix),
    // so falls through to substituteVars which resolves it
    const result = resolveOutputsExpression("$vars.name is great", pool, undefined, undefined)
    expect(result).toBe("Alice is great")
  })

  it("returns literal strings not starting with $ as-is", () => {
    const pool = new VarPool({ name: "Alice" })
    // Strings not starting with $ are literals — no substitution performed
    const result = resolveOutputsExpression("Hello $vars.name!", pool, undefined, undefined)
    expect(result).toBe("Hello $vars.name!")
  })

  it("returns literal strings as-is", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("just a string", pool, undefined, undefined)
    expect(result).toBe("just a string")
  })

  it("returns empty string literal", () => {
    const pool = new VarPool({})
    const result = resolveOutputsExpression("", pool, undefined, undefined)
    expect(result).toBe("")
  })
})

describe("applyOutputsMapping", () => {
  it("processes multiple output mappings and writes to pool", () => {
    const pool = new VarPool({})
    const outputs: Record<string, any> = {
      last_output: "hello",
      exit_code: 0,
    }
    const nodeOutputs = {
      result: "$last_output",
      code: "$exit_code",
    }

    const result = applyOutputsMapping(nodeOutputs, outputs, pool, "hello", 0)

    expect(result.result).toBe("hello")
    expect(result.code).toBe(0)
    expect(pool.get("result")).toBe("hello")
    expect(pool.get("code")).toBe(0)
  })

  it("strips $vars. prefix from pool keys", () => {
    const pool = new VarPool({})
    const outputs: Record<string, any> = {
      last_output: "test-value",
    }
    const nodeOutputs = {
      "$vars.my_var": "$last_output",
    }

    const result = applyOutputsMapping(nodeOutputs, outputs, pool, "test-value", undefined)

    expect(result.my_var).toBe("test-value")
    expect(pool.get("my_var")).toBe("test-value")
  })

  it("handles JSON field extraction from lastOutput", () => {
    const pool = new VarPool({})
    const jsonOutput = JSON.stringify({ status: "ok", count: 42 })
    const outputs: Record<string, any> = {
      last_output: jsonOutput,
    }
    const nodeOutputs = {
      status: "$last_output.status",
      count: "$last_output.count",
    }

    const result = applyOutputsMapping(nodeOutputs, outputs, pool, jsonOutput, undefined)

    expect(result.status).toBe("ok")
    expect(result.count).toBe(42)
    expect(pool.get("status")).toBe("ok")
    expect(pool.get("count")).toBe(42)
  })

  it("handles $vars.x = expr boolean assignment (evaluateExpression returns boolean)", () => {
    const pool = new VarPool({ count: 10 })
    const outputs: Record<string, any> = {}
    const nodeOutputs = {
      "$vars.count": "$vars.count = $vars.count > 5",
    }

    const result = applyOutputsMapping(nodeOutputs, outputs, pool, undefined, undefined)

    expect(pool.get("count")).toBe(true)
    expect(result.count).toBe(true)
  })

  it("returns empty record when nodeOutputs is empty", () => {
    const pool = new VarPool({})
    const outputs: Record<string, any> = {}
    const result = applyOutputsMapping({}, outputs, pool, undefined, undefined)
    expect(result).toEqual({})
  })

  it("preserves existing outputs keys not in nodeOutputs mapping", () => {
    const pool = new VarPool({})
    const outputs: Record<string, any> = {
      last_output: "test",
      exit_code: 0,
      __status: "completed",
    }
    const nodeOutputs = {
      result: "$last_output",
    }

    applyOutputsMapping(nodeOutputs, outputs, pool, "test", 0)

    // Original outputs keys should be untouched
    expect(outputs.__status).toBe("completed")
    expect(outputs.last_output).toBe("test")
  })
})
