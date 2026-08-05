// packages/engine/src/__tests__/dynamic-sub-workflow.test.ts
//
// Unit tests for the dynamic_sub_workflow validation harness and utilities.
//
import { describe, it, expect, vi } from "vitest"
import {
  validateL1Structure,
  validateL2Graph,
  validateL3Semantics,
  runValidationPipeline,
} from "../executors/dynamic-sub-workflow-validation"
import { computeInputHash, buildInputSnapshot } from "../executors/dynamic-sub-workflow-hash"
import type { NodeDef } from "@octopus/shared"
import { VarPool } from "@octopus/shared"

// ──────────────────────────────────────────────────────────────
// Fixtures — shared mock data for integration tests
// ──────────────────────────────────────────────────────────────

const FIXTURES = {
  /** Valid 3-node DAG: t1 and t2 are parallel, t3 depends on both. */
  validDag: {
    nodes: [
      { id: "t1", type: "agent", prompt: "Implement feature A" },
      { id: "t2", type: "agent", prompt: "Implement feature B" },
      { id: "t3", type: "agent", prompt: "Integration test", depends_on: ["t1", "t2"] },
    ],
  },
  /** Invalid DAG: circular dependency t1 → t2 → t1 (fails L2). */
  invalidDagCircular: {
    nodes: [
      { id: "t1", type: "agent", prompt: "do task 1", depends_on: ["t2"] },
      { id: "t2", type: "agent", prompt: "do task 2", depends_on: ["t1"] },
    ],
  },
  /** Corrected DAG: linear chain t1 → t2 → t3 (passes L1+L2+L3). */
  correctedDag: {
    nodes: [
      { id: "t1", type: "agent", prompt: "do task 1" },
      { id: "t2", type: "agent", prompt: "do task 2", depends_on: ["t1"] },
      { id: "t3", type: "agent", prompt: "do task 3", depends_on: ["t2"] },
    ],
  },
  /** Small valid DAG for rerun/hash tests. */
  simpleDag: {
    nodes: [
      { id: "task-a", type: "agent", prompt: "do A" },
      { id: "task-b", type: "agent", prompt: "do B" },
    ],
  },
  /** DAG with mixed agent and octopus_agent nodes. */
  mixedDag: {
    nodes: [
      { id: "analyze", type: "agent", prompt: "Analyze the requirements" },
      { id: "impl", type: "octopus_agent", agent: "workspace", version: "latest", task: { brief: "Implement the login endpoint", context: ["Use the API spec"], constraints: ["Use Express.js"] }, depends_on: ["analyze"] },
      { id: "test", type: "agent", prompt: "Write tests for the login endpoint", depends_on: ["impl"] },
    ],
  },
}

const VALID_DAG_JSON = JSON.stringify(FIXTURES.validDag)
const INVALID_DAG_CIRCULAR_JSON = JSON.stringify(FIXTURES.invalidDagCircular)
const CORRECTED_DAG_JSON = JSON.stringify(FIXTURES.correctedDag)
const SIMPLE_DAG_JSON = JSON.stringify(FIXTURES.simpleDag)
const MIXED_DAG_JSON = JSON.stringify(FIXTURES.mixedDag)

/** Mock WorkflowEngine that returns a successful run without real execution. */
function mockWorkflowEngineModule() {
  return {
    WorkflowEngine: vi.fn().mockImplementation(() => ({
      updateVarPool: vi.fn(),
      setWorkflowResolver: vi.fn(),
      run: vi.fn().mockResolvedValue({
        status: "completed",
        nodeResults: {},
        poolSnapshot: {},
        durationMs: 10,
      }),
    })),
  }
}

/** Mock IAgentProvider that yields predetermined text via sendQuery. */
function createMockProvider(responseText: string) {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      yield { type: "text_delta" as const, content: responseText, messageId: "msg-1" }
      yield { type: "result" as const, sessionId: "mock-session", content: responseText }
    },
  }
}

/** Mock IAgentProvider that returns different responses on successive calls. */
function createMultiCallMockProvider(responses: string[]) {
  let callIndex = 0
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      const response = responses[Math.min(callIndex, responses.length - 1)]
      callIndex++
      yield { type: "text_delta" as const, content: response, messageId: "msg-1" }
      yield { type: "result" as const, sessionId: "mock-session", content: response }
    },
  }
}

/** Get a spy that tracks call count on a mock provider. */
function createSpyProvider(responseText: string) {
  const spy = vi.fn()
  return {
    provider: {
      getType: () => "claude",
      sendQuery: async function* () {
        spy()
        yield { type: "text_delta" as const, content: responseText, messageId: "msg-1" }
        yield { type: "result" as const, sessionId: "mock-session", content: responseText }
      },
    },
    spy,
  }
}

// ──────────────────────────────────────────────────────────────
// Validation Harness
// ──────────────────────────────────────────────────────────────

describe("Validation Harness", () => {
  // ── L1: Structure ────────────────────────────────────────────

  describe("L1 Structure", () => {
    it("valid JSON with nodes array → valid", () => {
      const json = {
        nodes: [
          { id: "a", type: "agent", prompt: "do something" },
          { id: "b", type: "agent", prompt: "do other", depends_on: ["a"] },
        ],
      }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("missing nodes array → invalid", () => {
      const json = { items: [] }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("nodes"))).toBe(true)
    })

    it("node missing id → invalid", () => {
      const json = { nodes: [{ type: "agent", prompt: "do something" }] }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("id"))).toBe(true)
    })

    it("node missing type → invalid", () => {
      const json = { nodes: [{ id: "a", prompt: "do something" }] }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("type"))).toBe(true)
    })

    it("node missing prompt → invalid", () => {
      const json = { nodes: [{ id: "a", type: "agent" }] }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("prompt"))).toBe(true)
    })

    it("non-object input → invalid", () => {
      expect(validateL1Structure(null).valid).toBe(false)
      expect(validateL1Structure("string").valid).toBe(false)
      expect(validateL1Structure(42).valid).toBe(false)
      expect(validateL1Structure(undefined).valid).toBe(false)
    })

    it("empty nodes array → valid (degenerate but structurally OK)", () => {
      const json = { nodes: [] }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(true)
    })

    it("octopus_agent node with task.brief → valid", () => {
      const json = {
        nodes: [
          { id: "impl", type: "octopus_agent", agent: "workspace", task: { brief: "Implement feature X" } },
        ],
      }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("octopus_agent node without task.brief → invalid", () => {
      const json = {
        nodes: [
          { id: "impl", type: "octopus_agent", agent: "workspace" },
        ],
      }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("task.brief"))).toBe(true)
    })

    it("octopus_agent node with empty task.brief → invalid", () => {
      const json = {
        nodes: [
          { id: "impl", type: "octopus_agent", agent: "workspace", task: { brief: "" } },
        ],
      }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("task.brief"))).toBe(true)
    })

    it("octopus_agent node without prompt but with task.brief → valid (no prompt required)", () => {
      const json = {
        nodes: [
          { id: "a", type: "agent", prompt: "do something" },
          { id: "b", type: "octopus_agent", agent: "workspace", task: { brief: "delegate to workspace" }, depends_on: ["a"] },
        ],
      }
      const result = validateL1Structure(json)
      expect(result.valid).toBe(true)
    })
  })

  // ── L2: Graph ────────────────────────────────────────────────

  describe("L2 Graph", () => {
    it("valid DAG (no cycles) → valid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent" },
        { id: "b", type: "agent", depends_on: ["a"] },
        { id: "c", type: "agent", depends_on: ["a", "b"] },
      ]
      const result = validateL2Graph(nodes)
      expect(result.valid).toBe(true)
    })

    it("circular dependency → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent", depends_on: ["b"] },
        { id: "b", type: "agent", depends_on: ["a"] },
      ]
      const result = validateL2Graph(nodes)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.toLowerCase().includes("cycl"))).toBe(true)
    })

    it("depends_on references non-existent node → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent", depends_on: ["missing-node"] },
      ]
      const result = validateL2Graph(nodes)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("missing-node"))).toBe(true)
    })

    it("self-referencing node → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent", depends_on: ["a"] },
      ]
      const result = validateL2Graph(nodes)
      expect(result.valid).toBe(false)
    })

    it("parallel nodes with no deps → valid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent" },
        { id: "b", type: "agent" },
        { id: "c", type: "agent" },
      ]
      const result = validateL2Graph(nodes)
      expect(result.valid).toBe(true)
    })

    it("octopus_agent depends_on existing nodes → valid", () => {
      const nodes: NodeDef[] = [
        { id: "design", type: "agent", prompt: "design the feature" },
        { id: "impl", type: "octopus_agent", task: { brief: "implement" } as any, depends_on: ["design"] },
      ]
      const result = validateL2Graph(nodes)
      expect(result.valid).toBe(true)
    })

    it("octopus_agent depends_on non-existent node → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "impl", type: "octopus_agent", task: { brief: "implement" } as any, depends_on: ["missing-design"] },
      ]
      const result = validateL2Graph(nodes)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("missing-design"))).toBe(true)
    })

    it("mixed agent and octopus_agent DAG with valid deps → valid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent", prompt: "analyze" },
        { id: "b", type: "octopus_agent", task: { brief: "design" } as any, depends_on: ["a"] },
        { id: "c", type: "agent", prompt: "test", depends_on: ["b"] },
      ]
      const result = validateL2Graph(nodes)
      expect(result.valid).toBe(true)
    })
  })

  // ── L3: Semantics ────────────────────────────────────────────

  describe("L3 Semantics", () => {
    it("all agent nodes → valid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent", prompt: "implement feature A" },
        { id: "b", type: "agent", prompt: "implement feature B" },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(true)
    })

    it("bash node in DAG → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "bash", prompt: "run build" },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("agent") || e.includes("bash"))).toBe(true)
    })

    it("empty prompt → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent", prompt: "" },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("prompt"))).toBe(true)
    })

    it("sub_workflow node in DAG → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "sub_workflow", prompt: "call child" },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(false)
    })

    it("missing prompt field → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "a", type: "agent" },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(false)
    })

    it("octopus_agent with task.brief → valid", () => {
      const nodes: NodeDef[] = [
        { id: "impl", type: "octopus_agent", task: { brief: "Implement the login page" } as any },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(true)
    })

    it("octopus_agent without task.brief → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "impl", type: "octopus_agent" },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("task.brief"))).toBe(true)
    })

    it("mixed agent and octopus_agent nodes → valid", () => {
      const nodes: NodeDef[] = [
        { id: "analyze", type: "agent", prompt: "Analyze the requirements" },
        { id: "impl", type: "octopus_agent", task: { brief: "Implement" } as any },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(true)
    })

    it("octopus_agent with empty task.brief → invalid", () => {
      const nodes: NodeDef[] = [
        { id: "impl", type: "octopus_agent", task: { brief: "  " } as any },
      ]
      const result = validateL3Semantics(nodes)
      expect(result.valid).toBe(false)
    })
  })

  // ── Validation Pipeline ──────────────────────────────────────

  describe("Validation Pipeline", () => {
    it("valid DAG passes all layers", () => {
      const json = {
        nodes: [
          { id: "a", type: "agent", prompt: "do A" },
          { id: "b", type: "agent", prompt: "do B", depends_on: ["a"] },
        ],
      }
      const result = runValidationPipeline(json)
      expect(result.result.valid).toBe(true)
      expect(result.result.errors).toHaveLength(0)
    })

    it("L1 failure short-circuits L2/L3", () => {
      const json = { items: [] }
      const result = runValidationPipeline(json)
      expect(result.result.valid).toBe(false)
      // Should only have L1 errors, not L2/L3
      expect(result.result.errors.every((e) => e.includes("nodes") || e.includes("L1"))).toBe(true)
    })

    it("L2 failure caught after L1 passes", () => {
      const json = {
        nodes: [
          { id: "a", type: "agent", prompt: "do A", depends_on: ["b"] },
          { id: "b", type: "agent", prompt: "do B", depends_on: ["a"] },
        ],
      }
      const result = runValidationPipeline(json)
      expect(result.result.valid).toBe(false)
      expect(result.result.errors.some((e) => e.toLowerCase().includes("cycl"))).toBe(true)
    })

    it("L3 failure caught after L1+L2 pass", () => {
      const json = {
        nodes: [
          { id: "a", type: "bash", prompt: "run build" },
        ],
      }
      const result = runValidationPipeline(json)
      expect(result.result.valid).toBe(false)
      expect(result.result.errors.some((e) => e.includes("agent"))).toBe(true)
    })

    it("octopus_agent node with task.brief passes all layers", () => {
      const json = {
        nodes: [
          { id: "design", type: "agent", prompt: "Design the feature" },
          { id: "impl", type: "octopus_agent", agent: "workspace", task: { brief: "Implement the feature" }, depends_on: ["design"] },
        ],
      }
      const result = runValidationPipeline(json)
      expect(result.result.valid).toBe(true)
      expect(result.result.errors).toHaveLength(0)
    })

    it("octopus_agent without task.brief fails L1", () => {
      const json = {
        nodes: [
          { id: "impl", type: "octopus_agent", agent: "workspace" },
        ],
      }
      const result = runValidationPipeline(json)
      expect(result.result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("L1") && e.includes("task.brief"))).toBe(true)
    })
  })
})

// ──────────────────────────────────────────────────────────────
// Generation Prompt
// ──────────────────────────────────────────────────────────────

describe("Generation Prompt", () => {
  it("includes both agent and octopus_agent types in constraints", async () => {
    const { buildGenerationPrompt } = await import("../executors/dynamic-sub-workflow")
    const prompt = buildGenerationPrompt("Build a login feature", { tickets: ["T1"] })

    // Should mention both types
    expect(prompt).toContain("agent")
    expect(prompt).toContain("octopus_agent")

    // Should NOT say ALL nodes must be agent
    expect(prompt).not.toContain('ALL nodes must have type: "agent"')

    // Should say nodes can be either type
    expect(prompt).toContain('Nodes can have type: "agent" or "octopus_agent"')

    // Should include octopus_agent example with task.brief
    expect(prompt).toContain("task")
    expect(prompt).toContain("brief")
    expect(prompt).toContain('"octopus_agent"')

    // Should explain the difference
    expect(prompt).toContain("task.brief")
    expect(prompt).toContain("prompt")
  })
})

// ──────────────────────────────────────────────────────────────
// Input Hash
// ──────────────────────────────────────────────────────────────

describe("Input Hash", () => {
  it("same input → same hash", () => {
    const input = { tickets: ["T1", "T2", "T3"], context: "feature" }
    const hash1 = computeInputHash(input)
    const hash2 = computeInputHash(input)
    expect(hash1).toBe(hash2)
  })

  it("different input → different hash", () => {
    const input1 = { tickets: ["T1", "T2"] }
    const input2 = { tickets: ["T1", "T2", "T3"] }
    expect(computeInputHash(input1)).not.toBe(computeInputHash(input2))
  })

  it("key ordering doesn't affect hash (canonical JSON)", () => {
    const input1 = { b: 2, a: 1 }
    const input2 = { a: 1, b: 2 }
    expect(computeInputHash(input1)).toBe(computeInputHash(input2))
  })

  it("returns a hex string", () => {
    const hash = computeInputHash({ foo: "bar" })
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("buildInputSnapshot", () => {
  it("collects upstream node outputs based on depends_on", () => {
    const pool = new VarPool()
    pool.set("global_var", "hello")

    const nodeResults = {
      "upstream-node": {
        outputs: { result: "analysis data" },
        lastOutput: "final text",
        status: "completed" as const,
        durationMs: 100,
        logLines: [],
      },
    }

    const node: NodeDef = {
      id: "dynamic-node",
      type: "dynamic_sub_workflow",
      depends_on: ["upstream-node"],
    }

    const snapshot = buildInputSnapshot(node, pool, nodeResults)
    expect(snapshot).toHaveProperty("upstream-node")
    expect(snapshot).toHaveProperty("vars")
  })
})

// ──────────────────────────────────────────────────────────────
// DynamicSubWorkflowExecutor — Unit Tests
// ──────────────────────────────────────────────────────────────

import { DynamicSubWorkflowExecutor } from "../executors/dynamic-sub-workflow"
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function createTempDir(): string {
  const dir = join(tmpdir(), `dsw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanupDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe("DynamicSubWorkflowExecutor", () => {
  describe("File name resolution", () => {
    it("generates name from parent workflow + node id", () => {
      const dir = createTempDir()
      try {
        const pool = new VarPool()
        const node: NodeDef = { id: "plan", type: "dynamic_sub_workflow", prompt: "plan" }
        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: {},
          workflow: { name: "pipeline" },
        })
        // Access private method via type cast for testing
        const name = (executor as any).resolveWorkflowName()
        expect(name).toBe("pipeline__plan")
      } finally {
        cleanupDir(dir)
      }
    })

    it("uses custom workflow name when specified", () => {
      const dir = createTempDir()
      try {
        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "plan",
          workflow: "ticket-dag",
        }
        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: {},
        })
        const name = (executor as any).resolveWorkflowName()
        expect(name).toBe("ticket-dag")
      } finally {
        cleanupDir(dir)
      }
    })

    it("appends iteration suffix inside a loop", () => {
      const dir = createTempDir()
      try {
        const pool = new VarPool()
        const node: NodeDef = { id: "plan", type: "dynamic_sub_workflow", prompt: "plan" }
        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: {},
          workflow: { name: "pipeline" },
          iterationIndex: 2,
        })
        const name = (executor as any).resolveWorkflowName()
        expect(name).toBe("pipeline__plan-iter2")
      } finally {
        cleanupDir(dir)
      }
    })
  })

  describe("Rerun detection", () => {
    it("reuses existing DAG when hash matches", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")
      mkdirSync(workflowsDir, { recursive: true })

      try {
        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "plan DAG",
          workflow: "test-dag",
        }

        // Compute hash for empty pool + no deps
        const snapshot = buildInputSnapshot(node, pool, {})
        const hash = computeInputHash(snapshot)

        // Pre-create meta.json + yaml
        const meta = {
          generated_at: new Date().toISOString(),
          input_hash: hash,
          input_snapshot: {},
          validation_rounds: 1,
          execution_status: "completed",
          node_count: 2,
        }
        writeFileSync(join(workflowsDir, "test-dag.meta.json"), JSON.stringify(meta))
        writeFileSync(join(workflowsDir, "test-dag.yaml"), `apiVersion: octopus/v1
kind: Workflow
name: test-dag
nodes:
  - id: task-a
    type: agent
    prompt: "do A"
  - id: task-b
    type: agent
    prompt: "do B"
`)

        vi.doMock("../engine", () => mockWorkflowEngineModule())

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: { claude: createMockProvider(SIMPLE_DAG_JSON) },
          outputDir: workflowsDir,
          workflow: { name: "parent" },
        })

        const result = await executor.execute()

        // Should reuse existing DAG — no agent call needed
        expect(result.status).toBe("completed")
        expect(result.logLines.some((l) => l.includes("reusing existing DAG"))).toBe(true)

        vi.doUnmock("../engine")
      } finally {
        cleanupDir(dir)
      }
    })
  })

  describe("Generation + Persistence", () => {
    it("generates DAG, validates, and persists YAML + meta.json", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")

      try {
        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "plan DAG",
          workflow: "gen-test",
        }

        vi.doMock("../engine", () => mockWorkflowEngineModule())

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: { claude: createMockProvider(VALID_DAG_JSON) },
          outputDir: workflowsDir,
          workflow: { name: "parent" },
        })

        const result = await executor.execute()

        // Check files exist
        expect(existsSync(join(workflowsDir, "gen-test.yaml"))).toBe(true)
        expect(existsSync(join(workflowsDir, "gen-test.meta.json"))).toBe(true)

        // Check meta.json content
        const meta = JSON.parse(readFileSync(join(workflowsDir, "gen-test.meta.json"), "utf-8"))
        expect(meta.validation_rounds).toBe(1)
        expect(meta.node_count).toBe(3)
        expect(meta.execution_status).toBe("completed")

        // Check result outputs
        expect(result.outputs.generated_workflow).toBe("gen-test")
        expect(result.outputs.node_count).toBe(3)

        vi.doUnmock("../engine")
      } finally {
        cleanupDir(dir)
      }
    })
  })

  describe("Validation failure", () => {
    it("fails after max correction rounds with invalid agent output", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")

      try {
        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "plan DAG",
          workflow: "fail-test",
        }

        // Agent always returns invalid JSON
        const badProvider = createMockProvider("This is not JSON at all")

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: { claude: badProvider },
          outputDir: workflowsDir,
          workflow: { name: "parent" },
          maxCorrectionRounds: 2,
        })

        const result = await executor.execute()

        expect(result.status).toBe("failed")
        expect(result.error).toContain("validation failed")
        expect(result.logLines.some((l) => l.includes("FAILED after"))).toBe(true)
      } finally {
        cleanupDir(dir)
      }
    })
  })

  // ──────────────────────────────────────────────────────────────
  // Integration Tests — Full executor lifecycle with mock provider
  // ──────────────────────────────────────────────────────────────

  describe("Integration: full lifecycle with mock provider", () => {
    it("generates valid DAG → persists YAML and meta → executes and returns result", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")
      const ensureNodeSpy = vi.fn()

      try {
        vi.doMock("../engine", () => mockWorkflowEngineModule())

        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "Generate a DAG to implement features",
          workflow: "integ-test",
        }

        const { provider, spy: providerSpy } = createSpyProvider(VALID_DAG_JSON)

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: { claude: provider },
          outputDir: workflowsDir,
          workflow: { name: "parent" },
          ensureNodeExecution: ensureNodeSpy,
        })

        const result = await executor.execute()

        // Status and outputs
        expect(result.status).toBe("completed")
        expect(result.outputs.generated_workflow).toBe("integ-test")
        expect(result.outputs.node_count).toBe(3)
        expect(result.outputs.validation_rounds).toBe(1)
        expect(result.error).toBeUndefined()

        // YAML file exists and contains expected nodes
        const yamlPath = join(workflowsDir, "integ-test.yaml")
        expect(existsSync(yamlPath)).toBe(true)
        const yamlContent = readFileSync(yamlPath, "utf-8")
        expect(yamlContent).toContain("id: t1")
        expect(yamlContent).toContain("id: t2")
        expect(yamlContent).toContain("id: t3")
        expect(yamlContent).toContain("name: integ-test")
        expect(yamlContent).toContain("type: agent")
        expect(yamlContent).toContain("apiVersion: octopus/v1")
        expect(yamlContent).toContain("kind: Workflow")
        expect(yamlContent).toContain("depends_on: [t1, t2]")

        // Meta file exists with correct metadata
        const metaPath = join(workflowsDir, "integ-test.meta.json")
        expect(existsSync(metaPath)).toBe(true)
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
        expect(meta.validation_rounds).toBe(1)
        expect(meta.node_count).toBe(3)
        expect(meta.execution_status).toBe("completed")
        expect(meta.input_hash).toMatch(/^[a-f0-9]{64}$/)
        expect(meta.input_snapshot).toBeDefined()
        expect(meta.generated_at).toBeDefined()
        expect(typeof meta.generated_at).toBe("string")

        // Provider called exactly once (no correction needed)
        expect(providerSpy).toHaveBeenCalledTimes(1)

        // ensureNodeExecution called for each child node (3 nodes)
        expect(ensureNodeSpy).toHaveBeenCalledTimes(3)
        expect(ensureNodeSpy).toHaveBeenCalledWith("plan:t1", "agent", expect.any(Object))
        expect(ensureNodeSpy).toHaveBeenCalledWith("plan:t2", "agent", expect.any(Object))
        expect(ensureNodeSpy).toHaveBeenCalledWith("plan:t3", "agent", expect.any(Object))

        // Duration is a positive number
        expect(result.durationMs).toBeGreaterThanOrEqual(0)

        vi.doUnmock("../engine")
      } finally {
        cleanupDir(dir)
      }
    })

    it("invalid DAG → correction loop → success on second round", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")

      try {
        vi.doMock("../engine", () => mockWorkflowEngineModule())

        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "Generate a DAG",
          workflow: "correction-test",
        }

        // First call: circular DAG (fails L2). Second call: corrected DAG (passes all).
        const provider = createMultiCallMockProvider([
          INVALID_DAG_CIRCULAR_JSON,
          CORRECTED_DAG_JSON,
        ])

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: { claude: provider },
          outputDir: workflowsDir,
          workflow: { name: "parent" },
          maxCorrectionRounds: 3,
        })

        const result = await executor.execute()

        // Execution succeeds after correction
        expect(result.status).toBe("completed")
        expect(result.outputs.generated_workflow).toBe("correction-test")
        expect(result.outputs.node_count).toBe(3)
        expect(result.outputs.validation_rounds).toBe(2)
        expect(result.error).toBeUndefined()

        // Log lines confirm correction happened
        expect(result.logLines.some((l) => l.includes("(correction)"))).toBe(true)
        expect(result.logLines.some((l) => l.includes("Validation failed"))).toBe(true)
        expect(result.logLines.some((l) => l.includes("Attempting auto-correction"))).toBe(true)
        expect(result.logLines.some((l) => l.includes("Validation passed"))).toBe(true)
        expect(result.logLines.some((l) => l.includes("cycle"))).toBe(true)

        // Persisted files exist
        expect(existsSync(join(workflowsDir, "correction-test.yaml"))).toBe(true)
        expect(existsSync(join(workflowsDir, "correction-test.meta.json"))).toBe(true)

        // YAML reflects the corrected DAG (not the circular one)
        const yamlContent = readFileSync(join(workflowsDir, "correction-test.yaml"), "utf-8")
        expect(yamlContent).toContain("id: t1")
        expect(yamlContent).toContain("id: t2")
        expect(yamlContent).toContain("id: t3")

        // Meta records 2 validation rounds
        const meta = JSON.parse(readFileSync(join(workflowsDir, "correction-test.meta.json"), "utf-8"))
        expect(meta.validation_rounds).toBe(2)
        expect(meta.node_count).toBe(3)
        expect(meta.execution_status).toBe("completed")

        vi.doUnmock("../engine")
      } finally {
        cleanupDir(dir)
      }
    })

    it("no meta.json → triggers fresh generation from scratch", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")
      // Note: workflowsDir is NOT pre-created — no meta.json, no yaml

      try {
        vi.doMock("../engine", () => mockWorkflowEngineModule())

        const pool = new VarPool()
        pool.set("context", "fresh-start")

        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "Generate a fresh DAG",
          workflow: "fresh-test",
        }

        const { provider, spy: providerSpy } = createSpyProvider(VALID_DAG_JSON)

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: { claude: provider },
          outputDir: workflowsDir,
          workflow: { name: "parent" },
        })

        const result = await executor.execute()

        // Provider was called (generation happened)
        expect(providerSpy).toHaveBeenCalledTimes(1)

        // Execution succeeds
        expect(result.status).toBe("completed")
        expect(result.outputs.generated_workflow).toBe("fresh-test")
        expect(result.outputs.node_count).toBe(3)
        expect(result.outputs.validation_rounds).toBe(1)
        expect(result.error).toBeUndefined()
        expect(result.durationMs).toBeGreaterThanOrEqual(0)
        expect(result.logLines).toBeDefined()
        expect(Array.isArray(result.logLines)).toBe(true)
        expect(result.logLines.length).toBeGreaterThan(0)

        // Output directory was created from scratch
        expect(existsSync(workflowsDir)).toBe(true)
        expect(existsSync(join(workflowsDir, "fresh-test.yaml"))).toBe(true)
        expect(existsSync(join(workflowsDir, "fresh-test.meta.json"))).toBe(true)

        // Meta snapshot includes pool vars
        const meta = JSON.parse(readFileSync(join(workflowsDir, "fresh-test.meta.json"), "utf-8"))
        expect(meta.input_snapshot.vars).toBeDefined()
        expect(meta.input_snapshot.vars.context).toBe("fresh-start")
        expect(meta.validation_rounds).toBe(1)

        vi.doUnmock("../engine")
      } finally {
        cleanupDir(dir)
      }
    })

    it("meta.json with hash mismatch → regenerates DAG", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")
      mkdirSync(workflowsDir, { recursive: true })

      try {
        vi.doMock("../engine", () => mockWorkflowEngineModule())

        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "plan DAG",
          workflow: "hash-mismatch",
        }

        // Pre-create meta.json with a deliberately wrong hash
        const staleMeta = {
          generated_at: new Date().toISOString(),
          input_hash: "0000000000000000000000000000000000000000000000000000000000000000",
          input_snapshot: {},
          validation_rounds: 1,
          execution_status: "completed",
          node_count: 2,
        }
        writeFileSync(join(workflowsDir, "hash-mismatch.meta.json"), JSON.stringify(staleMeta))
        writeFileSync(join(workflowsDir, "hash-mismatch.yaml"), `apiVersion: octopus/v1
kind: Workflow
name: hash-mismatch
nodes:
  - id: old-task
    type: agent
    prompt: "old task"
`)

        const { provider, spy: providerSpy } = createSpyProvider(SIMPLE_DAG_JSON)

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: { claude: provider },
          outputDir: workflowsDir,
          workflow: { name: "parent" },
        })

        const result = await executor.execute()

        // Detected hash mismatch and regenerated
        expect(result.logLines.some((l) => l.includes("hash mismatch"))).toBe(true)
        expect(result.logLines.some((l) => l.includes("regenerating DAG"))).toBe(true)
        expect(providerSpy).toHaveBeenCalledTimes(1)

        // Result reflects the newly generated DAG (2 nodes from SIMPLE_DAG_JSON)
        expect(result.status).toBe("completed")
        expect(result.outputs.node_count).toBe(2)
        expect(result.outputs.generated_workflow).toBe("hash-mismatch")
        expect(result.outputs.validation_rounds).toBe(1)

        // Meta.json updated with new hash
        const meta = JSON.parse(readFileSync(join(workflowsDir, "hash-mismatch.meta.json"), "utf-8"))
        expect(meta.input_hash).not.toBe("0000000000000000000000000000000000000000000000000000000000000000")
        expect(meta.node_count).toBe(2)
        expect(meta.execution_status).toBe("completed")
        expect(meta.validation_rounds).toBe(1)

        // YAML was overwritten with new content
        const yamlContent = readFileSync(join(workflowsDir, "hash-mismatch.yaml"), "utf-8")
        expect(yamlContent).toContain("id: task-a")
        expect(yamlContent).toContain("id: task-b")
        expect(yamlContent).not.toContain("id: old-task")

        vi.doUnmock("../engine")
      } finally {
        cleanupDir(dir)
      }
    })

    it("mixed DAG with agent and octopus_agent → validation passes → YAML serialized correctly", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")
      const ensureNodeSpy = vi.fn()

      try {
        vi.doMock("../engine", () => mockWorkflowEngineModule())

        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "Generate a DAG with octopus_agent",
          workflow: "mixed-test",
        }

        const { provider, spy: providerSpy } = createSpyProvider(MIXED_DAG_JSON)

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: { claude: provider },
          outputDir: workflowsDir,
          workflow: { name: "parent" },
          ensureNodeExecution: ensureNodeSpy,
        })

        const result = await executor.execute()

        // Status and outputs
        expect(result.status).toBe("completed")
        expect(result.outputs.generated_workflow).toBe("mixed-test")
        expect(result.outputs.node_count).toBe(3)
        expect(result.outputs.validation_rounds).toBe(1)
        expect(result.error).toBeUndefined()

        // Provider called once (no correction needed)
        expect(providerSpy).toHaveBeenCalledTimes(1)

        // ensureNodeExecution called for all 3 child nodes
        expect(ensureNodeSpy).toHaveBeenCalledTimes(3)
        expect(ensureNodeSpy).toHaveBeenCalledWith("plan:analyze", "agent", expect.any(Object))
        expect(ensureNodeSpy).toHaveBeenCalledWith("plan:impl", "octopus_agent", expect.any(Object))
        expect(ensureNodeSpy).toHaveBeenCalledWith("plan:test", "agent", expect.any(Object))

        // YAML file contains both node types
        const yamlPath = join(workflowsDir, "mixed-test.yaml")
        expect(existsSync(yamlPath)).toBe(true)
        const yamlContent = readFileSync(yamlPath, "utf-8")
        expect(yamlContent).toContain("id: analyze")
        expect(yamlContent).toContain("type: agent")
        expect(yamlContent).toContain("id: impl")
        expect(yamlContent).toContain("type: octopus_agent")
        expect(yamlContent).toContain("agent: workspace")
        expect(yamlContent).toContain("brief:")
        expect(yamlContent).toContain("Implement the login endpoint")
        expect(yamlContent).toContain("depends_on: [impl]")
        expect(yamlContent).toContain("id: test")

        // Meta file
        const metaPath = join(workflowsDir, "mixed-test.meta.json")
        expect(existsSync(metaPath)).toBe(true)
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
        expect(meta.node_count).toBe(3)
        expect(meta.validation_rounds).toBe(1)
        expect(meta.execution_status).toBe("completed")

        vi.doUnmock("../engine")
      } finally {
        cleanupDir(dir)
      }
    })

    it("child callbacks forward onAgentEvent with scoped node ID for octopus_agent", async () => {
      const dir = createTempDir()
      const workflowsDir = join(dir, "workflows")

      try {
        // We test the createChildCallbacks method directly to verify event forwarding
        const pool = new VarPool()
        const node: NodeDef = {
          id: "plan",
          type: "dynamic_sub_workflow",
          prompt: "Generate a DAG",
          workflow: "cb-test",
        }

        const executor = new DynamicSubWorkflowExecutor(node, pool, {
          cwd: dir,
          providers: {},
          outputDir: workflowsDir,
          workflow: { name: "parent" },
        })

        // Access private method for testing
        const logLines: string[] = []
        const childCallbacks = (executor as any).createChildCallbacks(logLines, "test-wf")

        // Verify onAgentEvent forwards with scoped node ID
        const agentEventSpy = vi.fn()
        executor["config"] = {
          ...executor["config"],
          callbacks: { onAgentEvent: agentEventSpy },
        }

        // Recreate callbacks with the spy
        const callbacksWithSpy = (executor as any).createChildCallbacks(logLines, "test-wf")
        callbacksWithSpy.onAgentEvent("impl-node", { type: "heartbeat", data: { step: 3 } })

        // Verify the parent callback was called with scoped ID
        expect(agentEventSpy).toHaveBeenCalledWith(
          "plan:impl-node",
          { type: "heartbeat", data: { step: 3 } },
        )
      } finally {
        cleanupDir(dir)
      }
    })
  })
})
