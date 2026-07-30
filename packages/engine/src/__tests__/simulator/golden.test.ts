import { describe, it, expect } from "vitest"
import { runTestSuite } from "../../simulator/test-runner"
import { simulateScenario } from "../../simulator/simulator-engine"
import { runAssertions } from "../../simulator/assertions"
import type { WorkflowDef } from "@octopus/shared"
import type { TestFixture, TestScenario } from "../../simulator/types"

// ── Golden WF-1: Linear ──────────────────────────────────────

const goldenLinearWorkflow: WorkflowDef = {
  apiVersion: "octopus/v1",
  kind: "Workflow",
  name: "golden-linear",
  execution_mode: "serial",
  nodes: [
    {
      id: "agent-greet",
      type: "agent",
      prompt: "Say hello to $vars.user_name",
      outputs: { greeting: "$last_output" },
    },
    {
      id: "condition-check",
      type: "condition",
      depends_on: ["agent-greet"],
      cases: [
        { when: "$vars.greeting == 'hello Alice'", then: "bash-report" },
        { when: "default", then: "bash-fallback" },
      ],
    },
    {
      id: "bash-report",
      type: "bash",
      bash: "echo 'Report: $vars.greeting'",
      depends_on: ["condition-check"],
    },
    {
      id: "bash-fallback",
      type: "bash",
      bash: "echo 'No greeting'",
      depends_on: ["condition-check"],
    },
  ],
}

const goldenLinearFixture: TestFixture = {
  scenarios: [
    {
      name: "happy path",
      inputs: { user_name: "Alice" },
      mocks: {
        "agent-greet": {
          output: "hello Alice",
          outputs: { greeting: "hello Alice" },
        },
        "bash-report": { output: "Report: hello Alice" },
        "bash-fallback": { output: "No greeting" },
      },
      assertions: {
        status: "completed",
        vars: { greeting: "hello Alice" },
        node_trace: {
          executed: ["agent-greet", "condition-check", "bash-report"],
          skipped: ["bash-fallback"],
        },
        node_outputs: {
          "bash-report": { output: "Report: hello Alice" },
        },
      },
    },
  ],
}

// ── Golden WF-2: Branch + DAG ─────────────────────────────────

const goldenBranchWorkflow: WorkflowDef = {
  apiVersion: "octopus/v1",
  kind: "Workflow",
  name: "golden-branch",
  execution_mode: "serial",
  nodes: [
    {
      id: "agent-analyze",
      type: "agent",
      outputs: { score: "0.85" },
    },
    {
      id: "condition-route",
      type: "condition",
      depends_on: ["agent-analyze"],
      cases: [
        { when: "$vars.score > 0.5", then: "agent-approve" },
        { when: "default", then: "agent-reject" },
      ],
    },
    {
      id: "agent-approve",
      type: "agent",
      depends_on: ["condition-route"],
      outputs: { decision: "approved" },
    },
    {
      id: "agent-reject",
      type: "agent",
      depends_on: ["condition-route"],
      outputs: { decision: "rejected" },
    },
    {
      id: "bash-notify",
      type: "bash",
      bash: "echo 'Decision: $vars.decision'",
      depends_on: ["agent-approve", "agent-reject"],
    },
  ],
}

const goldenBranchFixture: TestFixture = {
  scenarios: [
    {
      name: "high score → approve",
      mocks: {
        "agent-analyze": { outputs: { score: "0.85" } },
        "agent-approve": { outputs: { decision: "approved" } },
        "agent-reject": { outputs: { decision: "rejected" } },
        "bash-notify": { output: "Decision: approved" },
      },
      assertions: {
        status: "completed",
        node_trace: {
          executed: ["agent-analyze", "condition-route", "agent-approve", "bash-notify"],
          skipped: ["agent-reject"],
        },
        node_outputs: {
          "agent-approve": { outputs: { decision: "approved" } },
        },
      },
    },
  ],
}

// ── Golden WF-3: Loop ─────────────────────────────────────────

const goldenLoopWorkflow: WorkflowDef = {
  apiVersion: "octopus/v1",
  kind: "Workflow",
  name: "golden-loop",
  execution_mode: "serial",
  nodes: [
    {
      id: "loop-retry",
      type: "loop",
      while: "$vars.attempts < 3",
      max_iterations: 5,
      nodes: [
        {
          id: "agent-try",
          type: "agent",
          outputs: { result: "attempt-output" },
        },
        {
          id: "bash-check",
          type: "bash",
          bash: "echo checking",
          depends_on: ["agent-try"],
        },
      ],
    },
  ],
}

const goldenLoopFixture: TestFixture = {
  scenarios: [
    {
      name: "3 iterations then done",
      inputs: { attempts: "0" },
      mocks: {
        "loop-retry": {
          iterations: 3,
          nodes: {
            "agent-try": [
              { output: "attempt 1", update_vars: { attempts: "1" } },
              { output: "attempt 2", update_vars: { attempts: "2" } },
              { output: "attempt 3", update_vars: { attempts: "3" } },
            ],
            "bash-check": { output: "checking" },
          },
        } as any,
      },
      assertions: {
        status: "completed",
        vars: { attempts: "3" },
      },
    },
  ],
}

// ── Golden WF-4: Swarm ────────────────────────────────────────

const goldenSwarmWorkflow: WorkflowDef = {
  apiVersion: "octopus/v1",
  kind: "Workflow",
  name: "golden-swarm",
  execution_mode: "serial",
  nodes: [
    {
      id: "agent-prep",
      type: "agent",
      outputs: { topic: "security review" },
    },
    {
      id: "swarm-review",
      type: "swarm",
      depends_on: ["agent-prep"],
      mode: "review",
      topic: "$vars.topic",
    },
    {
      id: "bash-summary",
      type: "bash",
      bash: "echo '$vars.review_result'",
      depends_on: ["swarm-review"],
    },
  ],
}

const goldenSwarmFixture: TestFixture = {
  scenarios: [
    {
      name: "swarm review completed",
      mocks: {
        "agent-prep": { outputs: { topic: "security review" } },
        "swarm-review": {
          output: "All clear",
          outputs: { review_result: "All clear" },
        },
        "bash-summary": { output: "All clear" },
      },
      assertions: {
        status: "completed",
        node_trace: {
          executed: ["agent-prep", "swarm-review", "bash-summary"],
        },
        node_outputs: {
          "swarm-review": { output: "All clear" },
        },
      },
    },
  ],
}

// ── Golden WF-5: Failure Path ─────────────────────────────────

const goldenFailureWorkflow: WorkflowDef = {
  apiVersion: "octopus/v1",
  kind: "Workflow",
  name: "golden-failure",
  execution_mode: "serial",
  nodes: [
    {
      id: "agent-risky",
      type: "agent",
    },
    {
      id: "bash-after",
      type: "bash",
      bash: "echo should not run",
      depends_on: ["agent-risky"],
    },
  ],
}

const goldenFailureFixture: TestFixture = {
  scenarios: [
    {
      name: "agent fails, workflow fails",
      mocks: {
        "agent-risky": {
          status: "failed",
          error: "LLM rate limited",
        },
        "bash-after": { output: "should not run" },
      },
      assertions: {
        status: "failed",
        node_trace: {
          executed: ["agent-risky"],
          skipped: ["bash-after"],
        },
        node_outputs: {
          "agent-risky": { status: "failed" },
        },
      },
    },
  ],
}

// ── Tests ─────────────────────────────────────────────────────

describe("Golden Workflow Integration Tests", () => {
  it("WF-1: linear workflow with condition branch", async () => {
    const result = await runTestSuite(goldenLinearWorkflow, goldenLinearFixture)
    expect(result.passed).toBe(true)
    expect(result.results[0].passed).toBe(true)

    // Verify hand-calculated expectations
    const simResult = result.results[0]
    expect(simResult.nodeResults["agent-greet"].status).toBe("completed")
    expect(simResult.nodeResults["condition-check"].status).toBe("completed")
    expect(simResult.nodeResults["bash-report"].status).toBe("completed")
    expect(simResult.nodeResults["bash-fallback"].status).toBe("skipped")
    expect(simResult.poolSnapshot.greeting).toBe("hello Alice")
  })

  it("WF-2: branch + DAG with score condition", async () => {
    const result = await runTestSuite(goldenBranchWorkflow, goldenBranchFixture)
    expect(result.passed).toBe(true)

    const simResult = result.results[0]
    expect(simResult.nodeResults["agent-approve"].status).toBe("completed")
    expect(simResult.nodeResults["agent-reject"].status).toBe("skipped")
    expect(simResult.nodeResults["bash-notify"].status).toBe("completed")
  })

  it("WF-3: loop with per-iteration mock data", async () => {
    const result = await runTestSuite(goldenLoopWorkflow, goldenLoopFixture)
    expect(result.passed).toBe(true)

    const simResult = result.results[0]
    expect(simResult.nodeResults["loop-retry"].status).toBe("completed")
    expect(simResult.nodeResults["loop-retry"].iterations).toBe(3)
    expect(simResult.poolSnapshot.attempts).toBe("3")
  })

  it("WF-4: swarm whole mock", async () => {
    const result = await runTestSuite(goldenSwarmWorkflow, goldenSwarmFixture)
    expect(result.passed).toBe(true)

    const simResult = result.results[0]
    expect(simResult.nodeResults["swarm-review"].status).toBe("completed")
    expect(simResult.nodeResults["swarm-review"].lastOutput).toBe("All clear")
  })

  it("WF-5: failure path cascades to dependent nodes", async () => {
    const result = await runTestSuite(goldenFailureWorkflow, goldenFailureFixture)
    expect(result.passed).toBe(true)

    const simResult = result.results[0]
    expect(simResult.status).toBe("failed")
    expect(simResult.nodeResults["agent-risky"].status).toBe("failed")
    expect(simResult.nodeResults["bash-after"].status).toBe("skipped")
  })
})
