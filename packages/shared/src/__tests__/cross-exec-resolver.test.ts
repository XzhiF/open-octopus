// packages/shared/src/__tests__/cross-exec-resolver.test.ts
import { describe, it, expect } from "vitest"
import { CrossExecResolver, ExecutionLookup } from "../variables/cross-exec-resolver"

interface LookupRow {
  parent_id?: string
  var_pool?: string
}

interface LookupData {
  [id: string]: LookupRow
}

interface NodeOutputsData {
  [executionId: string]: {
    [nodeId: string]: Record<string, any>
  }
}

function createLookup(
  data: LookupData,
  nodeOutputs?: NodeOutputsData,
): ExecutionLookup {
  return {
    getById: (id: string) => data[id] ?? null,
    getNodeOutputs: nodeOutputs
      ? (executionId: string, nodeId: string) =>
          nodeOutputs[executionId]?.[nodeId] ?? null
      : undefined,
  }
}

describe("CrossExecResolver", () => {
  // ── $parent.var_pool.* ──────────────────────────────────────────────────────

  it("resolves $parent.var_pool.* from nested var_pool format", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ var_pool: { branch: "main" } }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Branch: $parent.var_pool.branch", "child-1")
    expect(result).toBe("Branch: main")
  })

  it("resolves $parent.var_pool.* from legacy poolSnapshot format", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ poolSnapshot: { project: "octopus" } }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Project: $parent.var_pool.project", "child-1")
    expect(result).toBe("Project: octopus")
  })

  it("resolves $parent.var_pool.* from flat format (entire object is pool)", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ gathered_info: "TypeScript tips", topic_summary: "TS" }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Info: $parent.var_pool.gathered_info", "child-1")
    expect(result).toBe("Info: TypeScript tips")
  })

  // ── $parent.$<nodeId>.outputs.* ─────────────────────────────────────────────

  it("resolves $parent.$<nodeId>.outputs.<key> via getNodeOutputs", () => {
    const lookup = createLookup(
      {
        "child-1": { parent_id: "parent-1" },
        "parent-1": { parent_id: "0" },
      },
      {
        "parent-1": {
          "gather-step": { branch: "feat/x", commit: "abc123" },
        },
      },
    )
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "Branch: $parent.$gather-step.outputs.branch",
      "child-1",
    )
    expect(result).toBe("Branch: feat/x")
  })

  it("resolves $parent.$collect.outputs.result via getNodeOutputs", () => {
    const lookup = createLookup(
      {
        "child-1": { parent_id: "parent-1" },
        "parent-1": { parent_id: "0" },
      },
      {
        "parent-1": {
          collect: { result: "hello" },
        },
      },
    )
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("$parent.$collect.outputs.result", "child-1")
    expect(result).toBe("hello")
  })

  it("resolves $ancestor[1].$collect.outputs.result from grandparent", () => {
    const lookup = createLookup(
      {
        "child-1": { parent_id: "parent-1" },
        "parent-1": { parent_id: "grandparent-1" },
        "grandparent-1": { parent_id: "0" },
      },
      {
        "grandparent-1": {
          collect: { result: "hello" },
        },
      },
    )
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "$ancestor[1].$collect.outputs.result",
      "child-1",
    )
    expect(result).toBe("hello")
  })

  it("leaves $parent.$nonexistent.outputs.result unresolved when node not found", () => {
    const lookup = createLookup(
      {
        "child-1": { parent_id: "parent-1" },
        "parent-1": { parent_id: "0" },
      },
      {
        "parent-1": {
          collect: { result: "hello" },
        },
      },
    )
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "$parent.$nonexistent.outputs.result",
      "child-1",
    )
    expect(result).toBe("$parent.$nonexistent.outputs.result")
  })

  it("leaves $parent.$<nodeId>.outputs.<key> unresolved when getNodeOutputs unavailable", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": { parent_id: "0" },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "Value: $parent.$gather-step.outputs.branch",
      "child-1",
    )
    expect(result).toBe("Value: $parent.$gather-step.outputs.branch")
  })

  it("leaves $parent.$<nodeId>.outputs.<key> unresolved when node not found", () => {
    const lookup = createLookup(
      {
        "child-1": { parent_id: "parent-1" },
        "parent-1": { parent_id: "0" },
      },
      { "parent-1": {} },
    )
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "Value: $parent.$missing-node.outputs.key",
      "child-1",
    )
    expect(result).toBe("Value: $parent.$missing-node.outputs.key")
  })

  // ── $ancestor[N].var_pool.* ─────────────────────────────────────────────────

  it("resolves $ancestor[0].var_pool.* (same as parent)", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ var_pool: { version: "1.0" } }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Version: $ancestor[0].var_pool.version", "child-1")
    expect(result).toBe("Version: 1.0")
  })

  it("resolves $ancestor[1].var_pool.* (grandparent)", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": { parent_id: "grandparent-1", var_pool: "{}" },
      "grandparent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ var_pool: { commit: "abc123" } }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Commit: $ancestor[1].var_pool.commit", "child-1")
    expect(result).toBe("Commit: abc123")
  })

  it("resolves $ancestor[N].var_pool.* from flat format (grandparent)", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "grandparent-1",
        var_pool: JSON.stringify({ intermediate: "step2-data" }),
      },
      "grandparent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ root_topic: "AI" }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Topic: $ancestor[1].var_pool.root_topic", "child-1")
    expect(result).toBe("Topic: AI")
  })

  // ── $ancestor[N].$<nodeId>.outputs.* ────────────────────────────────────────

  it("resolves $ancestor[N].$<nodeId>.outputs.<key> via getNodeOutputs", () => {
    const lookup = createLookup(
      {
        "child-1": { parent_id: "parent-1" },
        "parent-1": { parent_id: "grandparent-1" },
        "grandparent-1": { parent_id: "0" },
      },
      {
        "grandparent-1": {
          "setup-node": { env: "production", region: "us-east-1" },
        },
      },
    )
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "Env: $ancestor[1].$setup-node.outputs.env",
      "child-1",
    )
    expect(result).toBe("Env: production")
  })

  // ── Unresolved / fallback cases ─────────────────────────────────────────────

  it("returns original text when parent does not exist", () => {
    const lookup = createLookup({
      "root-1": { parent_id: "0" },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Branch: $parent.var_pool.branch", "root-1")
    expect(result).toBe("Branch: $parent.var_pool.branch")
  })

  it("returns original text when var_pool key does not exist", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ var_pool: {} }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Branch: $parent.var_pool.branch", "child-1")
    expect(result).toBe("Branch: $parent.var_pool.branch")
  })

  it("returns original text when ancestor level exceeds depth", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": { parent_id: "0", var_pool: "{}" },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Data: $ancestor[5].var_pool.data", "child-1")
    expect(result).toBe("Data: $ancestor[5].var_pool.data")
  })

  it("does not recursively resolve nested references", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ var_pool: { nested: "$parent.var_pool.inner" } }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve("Value: $parent.var_pool.nested", "child-1")
    expect(result).toBe("Value: $parent.var_pool.inner")
  })

  // ── Multiple references in one text ─────────────────────────────────────────

  it("resolves multiple references in same text", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        var_pool: JSON.stringify({ var_pool: { branch: "main", version: "1.0" } }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "$parent.var_pool.branch-$parent.var_pool.version",
      "child-1",
    )
    expect(result).toBe("main-1.0")
  })

  // ── input_values ─────────────────────────────────────────────────────────────

  it("resolves $parent.input_values.* from parent execution", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        input_values: JSON.stringify({ topic: "TypeScript", depth: "advanced" }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "Topic: $parent.input_values.topic, Depth: $parent.input_values.depth",
      "child-1",
    )
    expect(result).toBe("Topic: TypeScript, Depth: advanced")
  })

  it("resolves $ancestor[N].input_values.* from ancestor execution", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": { parent_id: "grandparent-1" },
      "grandparent-1": {
        parent_id: "0",
        input_values: JSON.stringify({ project: "octopus" }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "Project: $ancestor[1].input_values.project",
      "child-1",
    )
    expect(result).toBe("Project: octopus")
  })

  it("leaves $parent.input_values.* unresolved when key does not exist", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": {
        parent_id: "0",
        input_values: JSON.stringify({ topic: "TypeScript" }),
      },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "Value: $parent.input_values.nonexistent",
      "child-1",
    )
    expect(result).toBe("Value: $parent.input_values.nonexistent")
  })

  it("leaves $parent.input_values.* unresolved when parent has no input_values", () => {
    const lookup = createLookup({
      "child-1": { parent_id: "parent-1" },
      "parent-1": { parent_id: "0" },
    })
    const resolver = new CrossExecResolver(lookup)
    const result = resolver.resolve(
      "Value: $parent.input_values.topic",
      "child-1",
    )
    expect(result).toBe("Value: $parent.input_values.topic")
  })

  // ── hasCrossExecRefs ────────────────────────────────────────────────────────

  it("detects cross-exec references with hasCrossExecRefs", () => {
    const lookup = createLookup({})
    const resolver = new CrossExecResolver(lookup)

    // New syntax — detected
    expect(resolver.hasCrossExecRefs("$parent.var_pool.branch")).toBe(true)
    expect(resolver.hasCrossExecRefs("$ancestor[0].var_pool.version")).toBe(true)
    expect(resolver.hasCrossExecRefs("$parent.$gather-step.outputs.branch")).toBe(true)
    expect(resolver.hasCrossExecRefs("$ancestor[2].$setup.outputs.env")).toBe(true)

    // Non-cross-exec refs — not detected
    expect(resolver.hasCrossExecRefs("$vars.local")).toBe(false)
    expect(resolver.hasCrossExecRefs("$node-id.output.key")).toBe(false)
  })
})
