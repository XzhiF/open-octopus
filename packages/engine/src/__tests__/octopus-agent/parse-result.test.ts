// packages/engine/src/__tests__/octopus-agent/parse-result.test.ts
//
// Unit tests for parseStructuredResult function.
// Verifies extraction of StructuredResult JSON from agent output text.
//

import { describe, it, expect } from "vitest"
import { parseStructuredResult } from "../../executors/octopus-agent/parse-result"

describe("parseStructuredResult", () => {
  it("parses valid StructuredResult JSON in code fence", () => {
    const text = `Here is the result:

\`\`\`json
{
  "status": "completed",
  "output": {
    "files": ["src/api.ts", "src/tests.ts"],
    "lines_added": 150
  },
  "artifacts": [
    {
      "type": "code",
      "path": "src/api.ts",
      "description": "API endpoint implementation"
    }
  ],
  "vars_update": {
    "impl_status": "done",
    "test_coverage": 85
  },
  "summary": "Successfully implemented API endpoint with 85% test coverage",
  "token_usage": {
    "input": 5000,
    "output": 3000,
    "total": 8000
  },
  "duration_ms": 45000
}
\`\`\`
`
    const result = parseStructuredResult(text)

    expect(result).not.toBeNull()
    expect(result!.status).toBe("completed")
    expect(result!.output.files).toEqual(["src/api.ts", "src/tests.ts"])
    expect(result!.output.lines_added).toBe(150)
    expect(result!.artifacts).toHaveLength(1)
    expect(result!.artifacts[0].type).toBe("code")
    expect(result!.artifacts[0].path).toBe("src/api.ts")
    expect(result!.vars_update!.impl_status).toBe("done")
    expect(result!.vars_update!.test_coverage).toBe(85)
    expect(result!.summary).toContain("Successfully implemented")
    expect(result!.token_usage.total).toBe(8000)
    expect(result!.duration_ms).toBe(45000)
  })

  it("parses raw JSON without code fence", () => {
    const text = `{
  "status": "completed",
  "output": { "result": "success" },
  "artifacts": [],
  "summary": "Task completed",
  "token_usage": { "input": 1000, "output": 500, "total": 1500 },
  "duration_ms": 10000
}`
    const result = parseStructuredResult(text)

    expect(result).not.toBeNull()
    expect(result!.status).toBe("completed")
    expect(result!.output.result).toBe("success")
    expect(result!.summary).toBe("Task completed")
  })

  it("returns null for plain text without JSON", () => {
    const text = `I've completed the task. Here's what I did:
- Analyzed the requirements
- Implemented the solution
- Wrote tests

Everything is working correctly.`

    const result = parseStructuredResult(text)

    // Should return null when no structured JSON found
    expect(result).toBeNull()
  })

  it("handles malformed JSON gracefully", () => {
    const text = `\`\`\`json
{
  "status": "completed",
  "output": { malformed json here
  "summary": "Task done"
}
\`\`\``

    const result = parseStructuredResult(text)

    // Should return null or partial result, not throw
    expect(result).toBeNull()
  })

  it("extracts JSON from middle of text with multiple code fences", () => {
    const text = `Here's an example:

\`\`\`json
{ "example": "not the result" }
\`\`\`

Now here's the actual result:

\`\`\`json
{
  "status": "completed",
  "output": { "data": "final result" },
  "artifacts": [],
  "summary": "Final output",
  "token_usage": { "input": 2000, "output": 1000, "total": 3000 },
  "duration_ms": 20000
}
\`\`\`

That's the final result.
`
    const result = parseStructuredResult(text)

    expect(result).not.toBeNull()
    expect(result!.output.data).toBe("final result")
    expect(result!.summary).toBe("Final output")
  })

  it("handles partial StructuredResult with missing fields", () => {
    const text = `\`\`\`json
{
  "status": "failed",
  "output": {},
  "summary": "Task failed due to timeout"
}
\`\`\``

    const result = parseStructuredResult(text)

    // Should still parse what's available
    expect(result).not.toBeNull()
    expect(result!.status).toBe("failed")
    expect(result!.summary).toContain("timeout")
    // Missing fields should be undefined or have defaults
    expect(result!.artifacts).toBeUndefined()
    expect(result!.token_usage).toBeUndefined()
  })

  it("handles different status values", () => {
    const statuses = ["completed", "failed", "partial", "aborted", "budget_exceeded"] as const

    for (const status of statuses) {
      const text = `\`\`\`json
{
  "status": "${status}",
  "output": {},
  "artifacts": [],
  "summary": "Result with status ${status}",
  "token_usage": { "input": 100, "output": 100, "total": 200 },
  "duration_ms": 5000
}
\`\`\``

      const result = parseStructuredResult(text)
      expect(result).not.toBeNull()
      expect(result!.status).toBe(status)
    }
  })

  it("handles artifact types", () => {
    const text = `\`\`\`json
{
  "status": "completed",
  "output": {},
  "artifacts": [
    { "type": "code", "path": "src/index.ts" },
    { "type": "file", "path": "config.json" },
    { "type": "text", "content": "Documentation" },
    { "type": "data", "content": "{}" }
  ],
  "summary": "Multiple artifacts",
  "token_usage": { "input": 500, "output": 500, "total": 1000 },
  "duration_ms": 8000
}
\`\`\``

    const result = parseStructuredResult(text)

    expect(result).not.toBeNull()
    expect(result!.artifacts).toHaveLength(4)
    expect(result!.artifacts[0].type).toBe("code")
    expect(result!.artifacts[1].type).toBe("file")
    expect(result!.artifacts[2].type).toBe("text")
    expect(result!.artifacts[3].type).toBe("data")
  })

  it("handles empty artifacts array", () => {
    const text = `\`\`\`json
{
  "status": "completed",
  "output": { "result": "done" },
  "artifacts": [],
  "summary": "No artifacts",
  "token_usage": { "input": 100, "output": 100, "total": 200 },
  "duration_ms": 3000
}
\`\`\``

    const result = parseStructuredResult(text)

    expect(result).not.toBeNull()
    expect(result!.artifacts).toEqual([])
  })

  it("handles vars_update with nested objects", () => {
    const text = `\`\`\`json
{
  "status": "completed",
  "output": {},
  "artifacts": [],
  "vars_update": {
    "config": {
      "api_endpoint": "/v2/users",
      "timeout": 30
    },
    "features": ["auth", "logging"],
    "metadata": {
      "version": "1.0.0"
    }
  },
  "summary": "Complex vars_update",
  "token_usage": { "input": 1000, "output": 1000, "total": 2000 },
  "duration_ms": 15000
}
\`\`\``

    const result = parseStructuredResult(text)

    expect(result).not.toBeNull()
    expect(result!.vars_update!.config).toEqual({
      api_endpoint: "/v2/users",
      timeout: 30,
    })
    expect(result!.vars_update!.features).toEqual(["auth", "logging"])
    expect(result!.vars_update!.metadata).toEqual({ version: "1.0.0" })
  })

  it("returns null for JSON that doesn't match StructuredResult shape", () => {
    const text = `\`\`\`json
{
  "name": "John Doe",
  "email": "john@example.com",
  "age": 30
}
\`\`\``

    const result = parseStructuredResult(text)

    // Should return null when JSON doesn't have required StructuredResult fields
    expect(result).toBeNull()
  })
})
