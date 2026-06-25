import { describe, it, expect } from "vitest"
import { VarPool } from "@octopus/shared"
import { applyVarsUpdate } from "../executors/parse-vars-update"

describe("applyVarsUpdate", () => {
  function makePool(): VarPool {
    return new VarPool({})
  }

  it("parses single-line JSON", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    applyVarsUpdate('{"vars_update":{"name":"test","count":"5"}}', pool, outputs)
    expect(pool.get("name")).toBe("test")
    expect(pool.get("count")).toBe("5")
    expect(outputs.vars_update).toBeDefined()
  })

  it("parses JSON from the last line of multi-line output", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    const text = `Some agent output here
More text
{"vars_update":{"result":"ok"}}`
    applyVarsUpdate(text, pool, outputs)
    expect(pool.get("result")).toBe("ok")
  })

  it("extracts JSON from markdown code fences", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    const text = `Here is my output:
\`\`\`json
{"vars_update":{"display_name":"PRD Forge #001","prd_index":"001"}}
\`\`\``
    applyVarsUpdate(text, pool, outputs)
    expect(pool.get("display_name")).toBe("PRD Forge #001")
    expect(pool.get("prd_index")).toBe("001")
  })

  it("extracts multi-line JSON from code fences", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    const text = `\`\`\`json
{"vars_update":{
  "projects":"project-a, project-b",
  "branch":"main",
  "display_name":"Test Flow"
}}
\`\`\``
    applyVarsUpdate(text, pool, outputs)
    expect(pool.get("projects")).toBe("project-a, project-b")
    expect(pool.get("branch")).toBe("main")
    expect(pool.get("display_name")).toBe("Test Flow")
  })

  it("extracts multi-line JSON without code fences", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    const text = `Agent thinking...
{"vars_update":{
  "key1":"value1",
  "key2":"value2"
}}`
    applyVarsUpdate(text, pool, outputs)
    expect(pool.get("key1")).toBe("value1")
    expect(pool.get("key2")).toBe("value2")
  })

  it("handles __status control signal", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    applyVarsUpdate('{"vars_update":{"__status":"failed","msg":"error"}}', pool, outputs)
    expect(outputs.__status).toBe("failed")
    expect(pool.get("msg")).toBe("error")
    // __status should NOT be in the pool
    expect(pool.get("__status")).toBeUndefined()
  })

  it("ignores output without vars_update", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    applyVarsUpdate("Just some text without JSON", pool, outputs)
    expect(outputs.vars_update).toBeUndefined()
  })

  it("handles nested JSON values in vars_update", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    const text = `{"vars_update":{"data":"{\\"nested\\":\\"value\\"}","simple":"ok"}}`
    applyVarsUpdate(text, pool, outputs)
    expect(pool.get("simple")).toBe("ok")
  })

  it("uses the LAST vars_update when multiple exist", () => {
    const pool = makePool()
    const outputs: Record<string, any> = {}
    const text = `{"vars_update":{"version":"first"}}
some text
{"vars_update":{"version":"second"}}`
    applyVarsUpdate(text, pool, outputs)
    expect(pool.get("version")).toBe("second")
  })
})
